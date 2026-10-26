"""
Hosted terminals: the client's MetaTrader 5 runs in one of our pods (pod_agent.py) instead of on the client's
machine. The pod runs the same Slave as everybody else, and the hub sees no difference.

The manager registers the client's broker server and password for a license (PUT /licenses/{id}/hosting). The
password and the license's Slave key are stored encrypted with HOSTING_SECRET, a Fernet key kept out of the
database: the pod has to hand them to MT5, so a hash would not do. Hosting a license gives it a new key, which
disconnects a Slave the client was running on their own machine.

Each pod authenticates with its own key (pod_..., create_pod.py) and calls POST /pods/sync every SYNC_SECONDS:
it reports the state of its terminals and gets back every terminal assigned to it, with credentials for the
enabled ones. A new terminal goes to the first pod with free room that syncs, and stays there, disabled or not:
the Slave's copy mapping lives in that pod's slot folder. A terminal left out of the list was removed, and the
pod deletes its folder.

A client hosting its own license pays for it in Stripe, a subscription apart from the portfolio's (payments.py): the
terminal keeps the credentials but only runs while paid, and gets the license's new key when a pod first runs it, so
the client's own Slave keeps copying until then. Terminals a manager hosts are exempt.
"""
import datetime
import json
import logging
import os
from typing import Callable, Dict, List, Literal, Optional, Tuple

from cryptography.fernet import Fernet, InvalidToken
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import models

logger = logging.getLogger(__name__)

SYNC_SECONDS = 15
POD_OFFLINE_SECONDS = 120  # A pod silent for longer is shown as offline
MAX_CAPACITY = 200
GRACE = datetime.timedelta(days=2)  # Stripe retries a failed renewal for days: the terminal does not stop at the first try
ENDED = ("canceled", "unpaid", "incomplete_expired")  # Stripe stopped charging: the terminal stops at once
# What a pod reports for a terminal (pod_agent.py)
POD_STATUSES = ("starting", "running", "login_failed", "key_refused", "error", "restarting", "stopped")

# Characters that would break a line of MT5's start.ini or .set
ONE_LINE = r"^[^\r\n\x00]*$"
MAP_PATTERN = r"^[^\r\n\x00|]*$"  # A pipe would split the CFG line the hub sends the Slave


class SlaveInputs(BaseModel):
    """The Slave inputs a manager sets for a hosted terminal; the rest keep the EA's defaults."""
    sizing_mode: Optional[Literal["factor", "balance", "equity"]] = None
    lots_factor: Optional[float] = Field(default=None, gt=0, le=1000)
    lots_divide: Optional[bool] = None
    reference_capital: Optional[float] = Field(default=None, gt=0)
    sltp_mode: Optional[Literal["distance", "price"]] = None
    copy_sltp: Optional[bool] = None
    late_max_deviation_points: Optional[int] = Field(default=None, ge=0, le=10_000_000)
    slippage_points: Optional[int] = Field(default=None, ge=0, le=10_000_000)
    symbol_map: Optional[str] = Field(default=None, max_length=500, pattern=MAP_PATTERN)
    suffix_map: Optional[str] = Field(default=None, max_length=200, pattern=MAP_PATTERN)


class HostingUpdate(BaseModel):
    server: Optional[str] = Field(default=None, min_length=1, max_length=64, pattern=r"^[\w .\-]+$")
    password: Optional[str] = Field(default=None, min_length=1, max_length=64, pattern=ONE_LINE)  # Left out: unchanged
    enabled: Optional[bool] = None
    inputs: Optional[SlaveInputs] = None


class TerminalReport(BaseModel):
    id: int
    config_version: int
    status: str = Field(max_length=32)
    detail: Optional[str] = Field(default=None, max_length=1000)


class PodSync(BaseModel):
    capacity: int = Field(ge=0)
    info: dict = {}
    terminals: List[TerminalReport] = []


def cipher() -> Optional[Fernet]:
    """None while HOSTING_SECRET is not set, or is not a Fernet key: hosting is off (the log says which)."""
    global _bad_secret_logged
    secret = os.getenv("HOSTING_SECRET", "").strip()
    if not secret:
        return None
    try:
        return Fernet(secret.encode())
    except ValueError:
        if not _bad_secret_logged:
            _bad_secret_logged = True
            logger.error("HOSTING_SECRET is not a Fernet key (44 url-safe base64 characters ending in '=', no quotes "
                         "and no b'...'): hosting is off")
        return None


_bad_secret_logged = False


def encrypt(f: Fernet, value: str) -> str:
    return f.encrypt(value.encode()).decode()


def slave_inputs(raw: Optional[str]) -> Dict[str, str]:
    """Stored inputs as the Slave's .set lines (input name -> value)."""
    inputs = SlaveInputs(**json.loads(raw or "{}"))  # licenses.settings
    out = {}
    if inputs.sizing_mode is not None:
        out["inp_sizing_mode"] = str(("factor", "balance", "equity").index(inputs.sizing_mode))
    if inputs.lots_factor is not None:
        out["inp_lots_factor"] = repr(inputs.lots_factor)
    if inputs.lots_divide is not None:
        out["inp_lots_op"] = "1" if inputs.lots_divide else "0"
    if inputs.reference_capital is not None:
        out["inp_reference_capital"] = repr(inputs.reference_capital)
    if inputs.sltp_mode is not None:
        out["inp_sltp_mode"] = "0" if inputs.sltp_mode == "distance" else "1"
    if inputs.copy_sltp is not None:
        out["inp_copy_sltp"] = "true" if inputs.copy_sltp else "false"
    if inputs.late_max_deviation_points is not None:
        out["inp_late_max_deviation_points"] = str(inputs.late_max_deviation_points)
    if inputs.slippage_points is not None:
        out["inp_slippage_points"] = str(inputs.slippage_points)
    if inputs.symbol_map is not None:
        out["inp_symbol_map"] = inputs.symbol_map
    if inputs.suffix_map is not None:
        out["inp_suffix_map"] = inputs.suffix_map
    return out


def paid(t: models.HostedTerminal, now: datetime.datetime) -> bool:
    """Exempt, or paid in Stripe: until the paid period's end plus GRACE, or at once when Stripe ends it."""
    if t.exempt:
        return True
    return t.stripe_period_end is not None and t.stripe_status not in ENDED and now < t.stripe_period_end + GRACE


def runs(t: models.HostedTerminal, now: datetime.datetime) -> bool:
    return t.enabled and paid(t, now)


def upsert(db: Session, lic: models.License, changes: HostingUpdate, f: Fernet, now: datetime.datetime,
           make_key: Callable[[models.License], str], exempt: bool = True) -> Tuple[models.HostedTerminal, bool]:
    """Hosts the license, or changes its hosting: (terminal, created). Creating needs the server and the password
    and gives the license a new key (make_key); a terminal to be paid gets it from sync, when a pod first runs it. Inputs replace the license's settings, which reach the running Slave
    through the hub (CFG); a new server, password or on/off restarts the terminal. ValueError when creating
    without the server or the password."""
    settings = json.dumps(changes.inputs.model_dump(exclude_none=True), sort_keys=True) if changes.inputs else None
    t = db.query(models.HostedTerminal).filter(models.HostedTerminal.license_id == lic.id).first()
    if t is None:
        if not changes.server or not changes.password:
            raise ValueError("Informe o servidor da corretora e a senha da conta")
        if settings is not None:
            lic.settings = settings
        t = models.HostedTerminal(license_id=lic.id, server=changes.server, password_enc=encrypt(f, changes.password),
                                  license_key_enc=encrypt(f, make_key(lic)) if exempt else "", inputs="{}", exempt=exempt,
                                  enabled=changes.enabled is not False, config_version=1, status="pending",
                                  created_at=now, updated_at=now)
        db.add(t)
        return t, True
    changed = False
    if changes.server is not None and changes.server != t.server:
        t.server, changed = changes.server, True
    if changes.password is not None:
        t.password_enc, changed = encrypt(f, changes.password), True
    if settings is not None:
        lic.settings = settings
    if changes.enabled is not None and changes.enabled != t.enabled:
        t.enabled, changed = changes.enabled, True
    if changed:
        t.config_version += 1
        t.updated_at = now
        if t.pod_id is not None:
            t.status, t.status_detail, t.status_at = "starting", None, now
    return t, False


def pod_online(pod: Optional[models.HostedPod], now: datetime.datetime) -> bool:
    return pod is not None and pod.last_seen_at is not None and \
        (now - pod.last_seen_at).total_seconds() <= POD_OFFLINE_SECONDS


def state(t: models.HostedTerminal, now: datetime.datetime, connected: bool = False) -> Tuple[str, Optional[str]]:
    """What the dashboard shows: the pod's report, unless the terminal is off, waits for a pod or its pod is gone.
    A Slave the hub has connected is running whatever the pod read: MT5 writes the Experts log late."""
    if not t.enabled:
        return "disabled", None
    if not paid(t, now):
        if t.stripe_period_end is None:
            return "unpaid", "Aguardando o pagamento da hospedagem"
        return "unpaid", "A hospedagem venceu. Assine de novo para o terminal voltar a copiar"
    if t.pod is None:
        return "pending", "Aguardando um pod com espaço livre"
    if not pod_online(t.pod, now):
        return "pod_offline", f"O pod {t.pod.name} não responde"
    if connected:
        return "running", t.status_detail if t.status == "running" else None
    return t.status, t.status_detail


def terminal_out(t: models.HostedTerminal, now: datetime.datetime, connected: bool = False) -> dict:
    """Never the password nor the key."""
    st, detail = state(t, now, connected)
    return {"license_id": t.license_id, "server": t.server, "enabled": t.enabled,
            "inputs": json.loads(t.license.settings or "{}"), "state": st, "detail": detail, "status_at": t.status_at,
            "pod": t.pod.name if t.pod else None, "created_at": t.created_at, "updated_at": t.updated_at,
            "billing": billing_out(t, now)}


def billing_out(t: models.HostedTerminal, now: datetime.datetime) -> dict:
    """How the hosting is paid: exempt, or its Stripe subscription."""
    return {"exempt": bool(t.exempt), "paid": paid(t, now), "status": t.stripe_status,
            "renewing": t.stripe_status in ("active", "trialing", "past_due"),
            "cancel_at_period_end": bool(t.stripe_cancel_at_period_end), "period_end": t.stripe_period_end}


def set_exempt(t: models.HostedTerminal, exempt: bool, now: datetime.datetime) -> bool:
    """Exempts the terminal from paying, or makes it pay again: without a paid subscription it stops. A terminal
    that starts running again gets a new configuration version, which the pod restarts it on. Whether it changed."""
    if bool(t.exempt) == exempt:
        return False
    was_paid = paid(t, now)
    t.exempt = exempt
    if paid(t, now) and not was_paid:
        t.config_version += 1
    t.updated_at = now
    return True


def pod_out(pod: models.HostedPod, terminals: List[models.HostedTerminal], now: datetime.datetime) -> dict:
    """A pod as the platform's admin sees it: never its key."""
    try:
        info = json.loads(pod.info or "{}")
    except ValueError:
        info = {}
    return {"id": pod.id, "name": pod.name, "online": pod_online(pod, now), "last_seen_at": pod.last_seen_at,
            "capacity": pod.capacity, "running": sum(1 for t in terminals if t.pod_id == pod.id and runs(t, now)),
            "assigned": sum(1 for t in terminals if t.pod_id == pod.id), "agent": info.get("agent"),
            "memory_mb": info.get("memory_mb"),
            "servers": len(info.get("servers") or [])}


def known_servers(db: Session, now: datetime.datetime) -> List[str]:
    """Broker servers the pods online have a servers.dat for: a terminal on any other cannot connect."""
    servers = set()
    for pod in db.query(models.HostedPod).filter(models.HostedPod.revoked_at.is_(None)):
        if pod_online(pod, now):
            try:
                servers.update(s for s in json.loads(pod.info or "{}").get("servers", []) if isinstance(s, str))
            except ValueError:
                pass
    return sorted(servers)


def sync(db: Session, pod: models.HostedPod, report: PodSync, f: Fernet, now: datetime.datetime,
         make_key: Callable[[models.License], str]) -> dict:
    """Records what the pod reports, gives it pending terminals while it has room, and returns all of its own. A
    terminal not paid is handed over as disabled, and a paid one without a key yet gets the license's new key
    (make_key)."""
    pod.capacity = min(report.capacity, MAX_CAPACITY)
    pod.info = json.dumps(report.info)[:10_000]
    pod.last_seen_at = now
    mine = {t.id: t for t in db.query(models.HostedTerminal).filter(models.HostedTerminal.pod_id == pod.id)}
    for r in report.terminals:
        t = mine.get(r.id)
        # A report about an older configuration is stale: the pod is about to restart that terminal
        if t is None or r.config_version != t.config_version or r.status not in POD_STATUSES:
            continue
        detail = (r.detail or "")[:255] or None
        if (t.status, t.status_detail) != (r.status, detail):
            t.status, t.status_detail, t.status_at = r.status, detail, now

    free = pod.capacity - sum(1 for t in mine.values() if runs(t, now))
    if free > 0:
        pending = [t.id for t in (db.query(models.HostedTerminal)
                                  .filter(models.HostedTerminal.pod_id.is_(None), models.HostedTerminal.enabled.is_(True))
                                  .order_by(models.HostedTerminal.id)) if paid(t, now)][:free]
        for tid in pending:
            # Two pods syncing at once: only one gets each terminal
            taken = (db.query(models.HostedTerminal)
                     .filter(models.HostedTerminal.id == tid, models.HostedTerminal.pod_id.is_(None))
                     .update({models.HostedTerminal.pod_id: pod.id, models.HostedTerminal.status: "starting",
                              models.HostedTerminal.status_detail: None, models.HostedTerminal.status_at: now},
                             synchronize_session=False))
            if taken:
                mine[tid] = db.get(models.HostedTerminal, tid)
                db.refresh(mine[tid])

    terminals = []
    for t in sorted(mine.values(), key=lambda t: t.id):
        entry = {"id": t.id, "enabled": runs(t, now), "config_version": t.config_version}
        if entry["enabled"]:
            if not t.license_key_enc:
                t.license_key_enc = encrypt(f, make_key(t.license))
            try:
                entry.update(server=t.server, login=t.license.client_mt5_login,
                             password=f.decrypt(t.password_enc.encode()).decode(),
                             license_key=f.decrypt(t.license_key_enc.encode()).decode(),
                             inputs=slave_inputs(t.license.settings))
            except InvalidToken:
                t.status, t.status_detail, t.status_at = "error", "Credenciais ilegíveis: o HOSTING_SECRET mudou", now
                entry["enabled"] = False
        terminals.append(entry)
    return {"sync_seconds": SYNC_SECONDS, "terminals": terminals}
