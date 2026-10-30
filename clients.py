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
from collections import Counter
from typing import Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func
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
CLOSING = ("CLOSE", "PARTIAL", "CLOSE_EXT")  # CLOSE_EXT: SL, TP or a hand close (Slave 4.04+)


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
    symbol_map: Optional[str] = Field(default=None, max_length=500, pattern=hosting.MAP_PATTERN)
    suffix_map: Optional[str] = Field(default=None, max_length=200, pattern=hosting.MAP_PATTERN)


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
                  "status_at": terminal.status_at, "billing": hosting.billing_out(terminal, now)}
    return {
        "id": lic.id,
        "portfolio": {"id": lic.portfolio_id, "name": lic.portfolio.name if lic.portfolio else None},
        "manager": manager_name(lic.portfolio),
        "mt5_login": lic.client_mt5_login,
        "max_lots": lic.max_lots,
        "is_active": lic.is_active,
        "is_paused": bool(lic.is_paused),
        "paused_at": lic.paused_at,
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
    is in price (close minus open, signed by direction); profit, in money, is there when the Slave reports it
    (4.04+): every deal of the copy, commission and swap included."""
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
        profits = [e.profit for e in done if e.profit is not None]
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
            "profit": round(sum(profits), 2) if profits else None,
            "failures": sum(1 for e in execs if e.retcode not in DONE),
        })
    out.sort(key=lambda c: c["opened_at"], reverse=True)
    return out[:COPIES_LIMIT]


def set_pause(lic: models.License, paused: bool, now: datetime.datetime):
    lic.is_paused = paused
    lic.paused_at = now if paused else None


def client_dashboard(db: Session, user: models.User, now: datetime.datetime, days: int = 30) -> dict:
    """Subscriber dashboard: today/week/month profit, running strategies today, cumulative curve and traders list."""
    lics = db.query(models.License).filter(models.License.client_user_id == user.id).order_by(models.License.id).all()
    if not lics:
        # Lead view: no licenses claimed yet, highlight published marketplace portfolios
        import marketplace
        listings = (db.query(models.Listing).filter(models.Listing.status == "published")
                    .order_by(models.Listing.published_at.desc()).limit(4).all())
        lead_highlights = [marketplace.public_listing(db, l, now) for l in listings]
        return {
            "is_lead": True,
            "profit_today": 0.0,
            "trades_today": 0,
            "profit_week": 0.0,
            "trades_week": 0,
            "profit_month": 0.0,
            "trades_month": 0,
            "total_profit": 0.0,
            "currency": "BRL",
            "curve": [],
            "running_today": [],
            "traders": [],
            "all_paused": False,
            "lead_highlights": lead_highlights,
        }

    since = now - datetime.timedelta(days=max(1, min(days, 365)))
    today_start = datetime.datetime(now.year, now.month, now.day)
    week_start = now - datetime.timedelta(days=7)
    month_start = now - datetime.timedelta(days=30)

    # Map (portfolio_id, mt5_login) -> license
    lic_map: Dict[Tuple[int, int], models.License] = {}
    portfolio_ids, mt5_logins = set(), set()
    for l in lics:
        if l.portfolio_id and l.client_mt5_login:
            lic_map[(l.portfolio_id, l.client_mt5_login)] = l
            portfolio_ids.add(l.portfolio_id)
            mt5_logins.add(l.client_mt5_login)

    closed_trades: List[Tuple[datetime.datetime, float, int, Optional[str], Optional[int]]] = []
    open_trades: List[dict] = []

    if portfolio_ids and mt5_logins:
        rows = (db.query(models.Execution)
                .filter(models.Execution.portfolio_id.in_(list(portfolio_ids)),
                        models.Execution.mt5_login.in_(list(mt5_logins)),
                        models.Execution.created_at >= since)
                .order_by(models.Execution.id).all())

        by_uid: Dict[Tuple[int, int, str], list] = {}
        for r in rows:
            if r.action in OPENING + CLOSING or r.retcode not in DONE:
                by_uid.setdefault((r.portfolio_id, r.mt5_login, r.uid), []).append(r)

        # Lookup MasterPositions
        uids = {uid for (_, _, uid) in by_uid}
        pairs = [uid.split("_", 1) for uid in uids if "_" in uid]
        pos_ids = [int(p) for _, p in pairs if p.isdigit()]
        positions = {}
        if pos_ids:
            for mp in db.query(models.MasterPosition).filter(models.MasterPosition.pos_id.in_(pos_ids)).all():
                positions[f"{mp.master_login}_{mp.pos_id}"] = mp

        for (pid, login, uid), execs in by_uid.items():
            done = [e for e in execs if e.retcode in DONE]
            opened = [e for e in done if e.action in OPENING and e.volume and e.price]
            closed = [e for e in done if e.action in CLOSING and e.volume and e.price]
            vol_in = sum(e.volume for e in opened)
            vol_out = sum(e.volume for e in closed)
            profits = [e.profit for e in done if e.profit is not None]
            pos_profit = sum(profits) if profits else 0.0

            mp = positions.get(uid)
            lic = lic_map.get((pid, login))
            lic_id = lic.id if lic else 0
            sym = mp.symbol if mp else None
            strat_id = mp.strategy_id if mp else None

            if vol_in - vol_out > 1e-9 and opened:
                open_trades.append({
                    "license_id": lic_id,
                    "portfolio_id": pid,
                    "symbol": sym,
                    "strategy_id": strat_id,
                    "opened_at": opened[0].created_at,
                    "volume": round(vol_in - vol_out, 8),
                })
            elif closed:
                close_time = closed[-1].created_at
                closed_trades.append((close_time, pos_profit, lic_id, sym, strat_id))

    # Calculate aggregate profit and trade counts
    profit_today = sum(p for t, p, _, _, _ in closed_trades if t >= today_start)
    trades_today = sum(1 for t, _, _, _, _ in closed_trades if t >= today_start)
    profit_week = sum(p for t, p, _, _, _ in closed_trades if t >= week_start)
    trades_week = sum(1 for t, _, _, _, _ in closed_trades if t >= week_start)
    profit_month = sum(p for t, p, _, _, _ in closed_trades if t >= month_start)
    trades_month = sum(1 for t, _, _, _, _ in closed_trades if t >= month_start)
    total_profit = sum(p for _, p, _, _, _ in closed_trades)

    # Cumulative curve
    closed_trades.sort(key=lambda x: x[0])
    curve = []
    cum = 0.0
    for t, p, _, _, _ in closed_trades:
        cum += p
        curve.append({"t": t.isoformat(), "v": round(cum, 2)})

    # Each copy in its own account's currency, from the account's latest snapshot. The totals in the currency of
    # the accounts that traded: the latest snapshot of any account painted a BRL result as USD when another
    # license of the same client sat on a USD account without trades
    latest = (db.query(models.AccountSnapshot.owner_id, func.max(models.AccountSnapshot.hour).label("hour"))
              .filter(models.AccountSnapshot.kind == "slave",
                      models.AccountSnapshot.owner_id.in_([l.id for l in lics]),
                      models.AccountSnapshot.currency.isnot(None))
              .group_by(models.AccountSnapshot.owner_id).subquery())
    currencies = dict(db.query(models.AccountSnapshot.owner_id, models.AccountSnapshot.currency)
                      .join(latest, (models.AccountSnapshot.owner_id == latest.c.owner_id)
                            & (models.AccountSnapshot.hour == latest.c.hour))
                      .filter(models.AccountSnapshot.kind == "slave",
                              models.AccountSnapshot.currency.isnot(None)).all())
    traded = Counter(currencies.get(lid, "BRL") for _, _, lid, _, _ in closed_trades)
    currency = (traded.most_common(1)[0][0] if traded
                else Counter(currencies.get(l.id, "BRL") for l in lics).most_common(1)[0][0])

    # Running today strategies
    running_today = []
    for l in lics:
        if not license_valid(l, now) or not l.portfolio:
            continue
        p = l.portfolio
        for s in p.strategies:
            s_trades_today = [pnl for t, pnl, lid, _, sid in closed_trades
                              if lid == l.id and sid == s.id and t >= today_start]
            s_open = [op for op in open_trades if op["license_id"] == l.id and op["strategy_id"] == s.id]
            
            if l.is_paused:
                status = "Pausado"
            elif s_open:
                status = "Posição aberta"
            elif s_trades_today:
                status = "Operou hoje"
            else:
                status = "Ativo"

            running_today.append({
                "license_id": l.id,
                "portfolio_name": p.name or f"Portfólio #{p.id}",
                "manager_name": manager_name(p),
                "strategy_name": s.name,
                "magic_number": s.magic_number,
                "is_paused": bool(l.is_paused),
                "status": status,
                "trades_today": len(s_trades_today),
                "profit_today": round(sum(s_trades_today), 2),
                "open_positions": len(s_open),
                "currency": currencies.get(l.id, "BRL"),
            })

    # Traders summary list
    traders = []
    valid_lics = [l for l in lics if license_valid(l, now)]
    all_paused = bool(valid_lics) and all(bool(l.is_paused) for l in valid_lics)

    for l in lics:
        p_today = sum(pnl for t, pnl, lid, _, _ in closed_trades if lid == l.id and t >= today_start)
        p_week = sum(pnl for t, pnl, lid, _, _ in closed_trades if lid == l.id and t >= week_start)
        p_month = sum(pnl for t, pnl, lid, _, _ in closed_trades if lid == l.id and t >= month_start)
        open_count = sum(1 for op in open_trades if op["license_id"] == l.id)
        trades_count = sum(1 for _, _, lid, _, _ in closed_trades if lid == l.id)

        traders.append({
            "license_id": l.id,
            "portfolio_id": l.portfolio_id,
            "portfolio_name": l.portfolio.name if l.portfolio else f"Portfólio #{l.portfolio_id}",
            "manager_name": manager_name(l.portfolio),
            "mt5_login": l.client_mt5_login,
            "max_lots": l.max_lots,
            "is_active": l.is_active,
            "is_paused": bool(l.is_paused),
            "paused_at": l.paused_at.isoformat() if l.paused_at else None,
            "valid": license_valid(l, now),
            "expires_at": l.expires_at.isoformat() if l.expires_at else None,
            "profit_today": round(p_today, 2),
            "profit_week": round(p_week, 2),
            "profit_month": round(p_month, 2),
            "open_positions": open_count,
            "trades_count": trades_count,
            "currency": currencies.get(l.id, "BRL"),
            "strategies": [s.name for s in l.portfolio.strategies] if l.portfolio else [],
        })

    return {
        "is_lead": False,
        "profit_today": round(profit_today, 2),
        "trades_today": trades_today,
        "profit_week": round(profit_week, 2),
        "trades_week": trades_week,
        "profit_month": round(profit_month, 2),
        "trades_month": trades_month,
        "total_profit": round(total_profit, 2),
        "currency": currency,
        "curve": curve,
        "running_today": running_today,
        "traders": traders,
        "all_paused": all_paused,
        "lead_highlights": [],
    }

