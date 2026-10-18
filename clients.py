"""
Client accounts: a client signs up on their own (POST /register) and links each license a manager sold them with a
one-time access code, which the manager generates in Clients. A client sees and changes only its own licenses.

The Slave settings live on the license (licenses.settings, hosting.SlaveInputs) and every Slave of the license
follows them. A manager sets any of them; a client sets the ones in ClientSettings, within the limits the
portfolio allows (portfolios.client_limits). The license's lot limit caps the copies whatever the settings.
"""
import datetime
import json
import secrets
from typing import Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel, Field, model_validator
from sqlalchemy.orm import Session

import hosting
import keys
import models

CLAIM_DAYS = 7
CLAIM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # No 0/O or 1/I/L: codes get read out and typed
CLAIM_LENGTH = 12  # ~59 bits; claims are rate limited per IP
COPIES_MAX_DAYS = 90
COPIES_LIMIT = 300
DONE = models.EXECUTION_DONE
OPENING = ("OPEN", "ADD", "REVERSE")
CLOSING = ("CLOSE", "PARTIAL")


class ClientLimits(BaseModel):
    """What a portfolio's clients may set on their licenses."""
    factor_min: float = Field(default=0.01, gt=0, le=1000)
    factor_max: float = Field(default=1.0, gt=0, le=1000)
    sizing_modes: List[Literal["factor", "balance", "equity"]] = Field(
        default_factory=lambda: ["factor", "balance", "equity"], min_length=1)
    sltp_modes: List[Literal["distance", "price"]] = Field(default_factory=lambda: ["distance", "price"], min_length=1)

    @model_validator(mode="after")
    def ordered(self):
        if self.factor_min > self.factor_max:
            raise ValueError("factor_min must not be above factor_max")
        return self


class ClientSettings(BaseModel):
    """The Slave settings a client may change, all of them at once."""
    sizing_mode: Literal["factor", "balance", "equity"] = "factor"
    lots_factor: float = Field(default=1.0, gt=0, le=1000)
    reference_capital: Optional[float] = Field(default=None, gt=0)
    sltp_mode: Literal["distance", "price"] = "distance"
    symbol_map: Optional[str] = Field(default=None, max_length=500, pattern=hosting.ONE_LINE)
    suffix_map: Optional[str] = Field(default=None, max_length=200, pattern=hosting.ONE_LINE)


CLIENT_FIELDS = tuple(ClientSettings.model_fields)


def limits_of(portfolio: Optional[models.Portfolio]) -> ClientLimits:
    raw = portfolio.client_limits if portfolio is not None else None
    try:
        return ClientLimits(**json.loads(raw)) if raw else ClientLimits()
    except (ValueError, TypeError):
        return ClientLimits()


def settings_of(lic: models.License) -> dict:
    try:
        return json.loads(lic.settings or "{}")
    except ValueError:
        return {}


def check_settings(s: ClientSettings, limits: ClientLimits) -> Optional[str]:
    """Why these settings are outside the portfolio's limits, in the words the client reads; None if they fit."""
    if s.sizing_mode not in limits.sizing_modes:
        return "Este portfólio não permite esse modo de tamanho"
    if s.sltp_mode not in limits.sltp_modes:
        return "Este portfólio não permite esse modo de SL/TP"
    if not limits.factor_min <= s.lots_factor <= limits.factor_max:
        return f"O fator deve ficar entre {decimal(limits.factor_min)} e {decimal(limits.factor_max)}"
    if s.sizing_mode != "factor" and s.reference_capital is None:
        return "Informe o capital de referência"
    return None


def decimal(value: float) -> str:
    """0.01 as 0,01: the dashboard is in Portuguese."""
    return f"{value:g}".replace(".", ",")


def apply_settings(lic: models.License, changes: dict) -> bool:
    """Merges these settings into the license's (keys set to None are removed). True if anything changed."""
    current = settings_of(lic)
    merged = {**current, **changes}
    merged = {k: v for k, v in merged.items() if v is not None}
    hosting.SlaveInputs(**merged)  # Fails on anything the Slave would not take
    new = json.dumps(merged, sort_keys=True)
    if new == json.dumps(current, sort_keys=True):
        return False
    lic.settings = new
    return True


def client_settings(lic: models.License) -> dict:
    current = settings_of(lic)
    return {k: current.get(k) for k in CLIENT_FIELDS}


# --- Access codes ---

def new_claim_code() -> str:
    raw = "".join(secrets.choice(CLAIM_ALPHABET) for _ in range(CLAIM_LENGTH))
    return "-".join(raw[i:i + 4] for i in range(0, CLAIM_LENGTH, 4))


def claim_hash(code: str) -> str:
    """Case, spaces and dashes do not matter when the client types the code."""
    return keys.key_hash("".join(c for c in code.upper() if c.isalnum()))


def set_claim(lic: models.License, now: datetime.datetime) -> Tuple[str, datetime.datetime]:
    code = new_claim_code()
    lic.claim_hash = claim_hash(code)
    lic.claim_expires_at = now + datetime.timedelta(days=CLAIM_DAYS)
    return code, lic.claim_expires_at


def find_claim(db: Session, code: str, now: datetime.datetime) -> Optional[models.License]:
    lic = db.query(models.License).filter(models.License.claim_hash == claim_hash(code)).first()
    if lic is None or lic.claim_expires_at is None or lic.claim_expires_at <= now:
        return None
    return lic


# --- What a client sees ---

def license_valid(lic: models.License, now: datetime.datetime) -> bool:
    return bool(lic.is_active) and (lic.expires_at is None or lic.expires_at > now)


def manager_name(portfolio: Optional[models.Portfolio]) -> Optional[str]:
    owner = portfolio.owner if portfolio is not None else None
    return (owner.name or None) if owner is not None else None


def license_view(lic: models.License, terminal: Optional[models.HostedTerminal], session: Optional[dict],
                 now: datetime.datetime) -> dict:
    """A license as its client sees it: never the key, the password or the pod."""
    hosted = None
    if terminal is not None:
        state, detail = hosting.state(terminal, now, session is not None)
        hosted = {"server": terminal.server, "enabled": terminal.enabled, "state": state, "detail": detail,
                  "status_at": terminal.status_at}
    return {
        "id": lic.id,
        "portfolio": {"id": lic.portfolio_id, "name": lic.portfolio.name if lic.portfolio else None},
        "manager": manager_name(lic.portfolio),
        "mt5_login": lic.client_mt5_login,
        "max_lots": lic.max_lots,
        "is_active": lic.is_active,
        "valid": license_valid(lic, now),
        "expires_at": lic.expires_at,
        "has_key": lic.key_hash is not None,
        "key_prefix": lic.key_prefix,
        "settings": client_settings(lic),
        "limits": limits_of(lic.portfolio).model_dump(),
        "hosting": hosted,
        "connection": None if session is None else {
            "ea_version": session.get("ea_version"), "connected_at": session.get("connected_at"),
            "active": session.get("active"), "last_ack_age_s": session.get("last_ack_age_s")},
    }


def copies(db: Session, lic: models.License, days: int, now: datetime.datetime) -> List[dict]:
    """The license's copies in the last `days` days, newest first, from the Slave's execution reports. The result
    is in price (close minus open, signed by direction): money needs the Slave to report profit."""
    since = now - datetime.timedelta(days=max(1, min(days, COPIES_MAX_DAYS)))
    rows = (db.query(models.Execution)
            .filter(models.Execution.portfolio_id == lic.portfolio_id,
                    models.Execution.mt5_login == lic.client_mt5_login,
                    models.Execution.created_at >= since)
            .order_by(models.Execution.id).all())
    by_uid: Dict[str, list] = {}
    for r in rows:
        if r.action in OPENING + CLOSING or r.retcode not in DONE:
            by_uid.setdefault(r.uid, []).append(r)

    positions = {}
    pairs = [uid.split("_", 1) for uid in by_uid if "_" in uid]
    pos_ids = [int(p) for _, p in pairs if p.isdigit()]
    if pos_ids and lic.portfolio is not None:
        for mp in (db.query(models.MasterPosition)
                   .filter(models.MasterPosition.manager_id == lic.portfolio.user_id,
                           models.MasterPosition.pos_id.in_(pos_ids))):
            positions[f"{mp.master_login}_{mp.pos_id}"] = mp

    out = []
    for uid, execs in by_uid.items():
        done = [e for e in execs if e.retcode in DONE]
        opened = [e for e in done if e.action in OPENING and e.volume and e.price]
        closed = [e for e in done if e.action in CLOSING and e.volume and e.price]
        vol_in = sum(e.volume for e in opened)
        vol_out = sum(e.volume for e in closed)
        avg_in = sum(e.volume * e.price for e in opened) / vol_in if vol_in else None
        avg_out = sum(e.volume * e.price for e in closed) / vol_out if vol_out else None
        mp = positions.get(uid)
        direction = None if mp is None else (1 if mp.type == 0 else -1)
        result = None
        if avg_in is not None and avg_out is not None and direction is not None:
            result = round((avg_out - avg_in) * direction, 10)
        if not opened and not closed:
            status = "failed"
        elif vol_in - vol_out > 1e-9:
            status = "open"
        else:
            status = "closed"
        out.append({
            "uid": uid,
            "symbol": mp.symbol if mp else None,
            "type": None if mp is None else ("buy" if mp.type == 0 else "sell"),
            "status": status,
            "opened_at": opened[0].created_at if opened else execs[0].created_at,
            "closed_at": closed[-1].created_at if closed and status == "closed" else None,
            "volume": round(vol_in, 8),
            "open_price": avg_in,
            "close_price": avg_out,
            "result": result,
            "failures": sum(1 for e in execs if e.retcode not in DONE),
        })
    out.sort(key=lambda c: c["opened_at"], reverse=True)
    return out[:COPIES_LIMIT]
