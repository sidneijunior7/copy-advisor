"""
Bridge to the Trademetric Dash: the Master's closed trades of a linked portfolio go to the Dash portfolio whose API
token the manager pasted, in the format of the Dash's own Live Tracking EA (one item per exit deal). A strategy
creator then runs one EA, the Master, for both products.

- The Dash address comes from DASH_INGEST_URL, never from the user.
- DASH_MIRROR_KEY, the key shared with the Dash (its MIRROR_INGEST_KEY), goes in x-mirror-key: with it the Dash marks
  the trades as the Mirror's, verified. Without it they arrive as plain EA trades.
- Each item carries external_id "mirror:<master login>:<deal>", which the Dash uses to drop what it already has: a
  send that timed out can be repeated.
- The token is kept encrypted with HOSTING_SECRET, like the hosted accounts' passwords.
- A link remembers the last master_deals.id it went through (deal_cursor) and sends only the deals closed from
  send_since on: the moment it was made, or up to 90 days before when the manager asked for the history.
- A token the Dash refuses (revoked, or a plan without live tracking) stops the link; it is tried again every
  ERROR_RETRY_SECONDS, so fixing the plan on the Dash is enough. Other failures are tried again the next round.
- With the shared key, the link also keeps a copy of the Dash portfolio's declared backtest (GET
  /api/mirror/backtest), refreshed every BACKTEST_REFRESH_SECONDS, for the listing page (backtest.py).
"""
import datetime
import json
import logging
import os
import re
import threading
import urllib.error
import urllib.request
from typing import Callable, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

import database
import hosting
import models

logger = logging.getLogger(__name__)

INGEST_URL = os.getenv("DASH_INGEST_URL", "https://webrequest.trademetric.com.br/api/ingest")
BACKTEST_URL = INGEST_URL.rsplit("/api/ingest", 1)[0] + "/api/mirror/backtest"
MIRROR_KEY = os.getenv("DASH_MIRROR_KEY", "").strip()
BACKTEST_REFRESH_SECONDS = 6 * 3600
INTERVAL = int(os.getenv("DASH_BRIDGE_SECONDS", "30"))  # 0 turns the bridge off
ERROR_RETRY_SECONDS = 3600
BATCH = 100  # master_deals read per step, so at most this many items per request
MAX_STEPS = 20  # per link per round: a long history goes out over several rounds
HISTORY_MAX_DAYS = 90
TOKEN_PATTERN = re.compile(r"^tc_[0-9a-f]{48}$")  # The Dash's portfolio API tokens (ApiTokenManager.tsx)
OUT = (1, 2, 3)  # DEAL_ENTRY out, in/out (reversal) and out by: the Dash EA sends one item for each

Send = Callable[[str, list], Tuple[int, str]]


def send(token: str, items: list) -> Tuple[int, str]:
    """POST to the Dash ingest: (HTTP status, the start of the body); status 0 when the Dash did not answer."""
    headers = {"Content-Type": "application/json", "x-api-token": token, "User-Agent": "TrademetricMirror/1"}
    if MIRROR_KEY:
        headers["x-mirror-key"] = MIRROR_KEY
    req = urllib.request.Request(INGEST_URL, data=json.dumps(items).encode(), method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read(500).decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(500).decode(errors="replace")
    except (urllib.error.URLError, OSError) as e:
        return 0, str(e)[:200]


def fetch_backtest(token: str) -> Tuple[int, str]:
    """GET the linked Dash portfolio's backtest: (HTTP status, body); status 0 when the Dash did not answer."""
    req = urllib.request.Request(BACKTEST_URL, method="GET", headers={
        "x-api-token": token, "x-mirror-key": MIRROR_KEY, "User-Agent": "TrademetricMirror/1"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read(5_000_000).decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(500).decode(errors="replace")
    except (urllib.error.URLError, OSError) as e:
        return 0, str(e)[:200]


def compact_backtest(body: str) -> dict:
    """What the Mirror keeps of the Dash answer: the net result of each trade, in order, and what describes them."""
    data = json.loads(body)
    trades = [t for t in data.get("trades") or [] if isinstance(t, dict) and isinstance(t.get("pnl"), (int, float))]
    return {
        "name": str((data.get("portfolio") or {}).get("name") or "")[:100],
        "initial_balance": float(data.get("initial_balance") or 0),
        "currency": (str(data["currency"])[:3] if data.get("currency") else None),
        "strategies": [{"name": str(s.get("name") or "")[:100], "magic_number": s.get("magic_number")}
                       for s in (data.get("strategies") or [])[:50] if isinstance(s, dict)],
        "pnl": [round(float(t["pnl"]), 2) for t in trades],
        "from": trades[0].get("t") if trades else None,
        "to": trades[-1].get("t") if trades else None,
        "truncated": bool(data.get("truncated")),
    }


def refresh_backtest(db: Session, link: models.DashLink, token: str, fetch: Callable[[str], Tuple[int, str]],
                     now: datetime.datetime):
    """Keeps a fresh copy of the backtest on the link; a failure keeps the last copy and says why."""
    status, body = fetch(token)
    link.backtest_fetched_at = now  # Also on failure: the next try waits for the next refresh
    if status == 200:
        try:
            link.backtest = json.dumps(compact_backtest(body), separators=(",", ":"))
            link.backtest_error = None
        except (ValueError, TypeError, KeyError) as e:
            link.backtest_error = f"O Dash mandou um backtest que o Mirror não entendeu ({type(e).__name__})."
    elif status == 403:
        link.backtest_error = "O Dash não reconheceu a chave do Mirror (DASH_MIRROR_KEY)."
    else:
        link.backtest_error = refusal(status) or failure(status, body)
    db.commit()


def refusal(status: int) -> Optional[str]:
    """What to tell the manager when the Dash refuses the token itself; None for anything else."""
    if status == 401:
        return "O Dash recusou o token: ele está errado ou foi revogado. Gere outro no portfólio do Dash e cole aqui."
    if status == 402:
        return "O plano da conta no Dash não inclui o acompanhamento ao vivo."
    if status == 403:
        return "O Dash recusou o envio."
    return None


def failure(status: int, body: str) -> str:
    if status == 0:
        return "O Dash não respondeu. O Mirror tenta de novo sozinho."
    try:
        detail = json.loads(body).get("error")
    except (ValueError, AttributeError):
        detail = None
    return f"O Dash respondeu {status}{f': {detail}' if detail else ''}. O Mirror tenta de novo sozinho."[:300]


def link_out(link: Optional[models.DashLink]) -> Optional[dict]:
    if link is None:
        return None
    backtest = None
    if link.backtest:
        try:
            data = json.loads(link.backtest)
            backtest = {"name": data.get("name"), "trades": len(data.get("pnl") or []),
                        "initial_balance": data.get("initial_balance") or None, "currency": data.get("currency")}
        except ValueError:
            pass
    return {"token_hint": link.token_hint, "status": link.status, "last_error": link.last_error,
            "last_sent_at": link.last_sent_at, "sent_count": link.sent_count, "send_since": link.send_since,
            "created_at": link.created_at, "backtest": backtest, "backtest_fetched_at": link.backtest_fetched_at,
            "backtest_error": link.backtest_error}


def _vwap(deals: List[models.MasterDeal]) -> Tuple[float, Optional[float]]:
    volume = sum(d.volume or 0 for d in deals)
    return volume, (sum((d.volume or 0) * (d.price or 0) for d in deals) / volume if volume > 0 else None)


def items_for(db: Session, manager_id: int, exits: List[models.MasterDeal]) -> List[dict]:
    """The Dash EA's item for each exit deal, with the position's entry from its entry deals (or the position the
    hub tracked, when the Master started sending deals after the entry). Fees are the exit deal's commission and
    swap plus its share of the entry commission (the Dash EA leaves the entry commission out)."""
    if not exits:
        return []
    keys = {(d.master_login, d.pos_id) for d in exits}
    pos_ids = sorted({k[1] for k in keys})
    entries: Dict[Tuple[int, int], List[models.MasterDeal]] = {}
    for d in (db.query(models.MasterDeal)
              .filter(models.MasterDeal.manager_id == manager_id, models.MasterDeal.pos_id.in_(pos_ids),
                      models.MasterDeal.entry == 0)):
        if (d.master_login, d.pos_id) in keys:
            entries.setdefault((d.master_login, d.pos_id), []).append(d)
    positions = {(mp.master_login, mp.pos_id): mp
                 for mp in db.query(models.MasterPosition)
                 .filter(models.MasterPosition.manager_id == manager_id, models.MasterPosition.pos_id.in_(pos_ids))}

    items = []
    for d in exits:
        key = (d.master_login, d.pos_id)
        ins, mp = entries.get(key), positions.get(key)
        if ins:
            volume_in, price_in = _vwap(ins)
            opened_at, long, entry_commission = min(i.time for i in ins), ins[0].type == 0, sum(i.commission or 0 for i in ins)
        elif mp is not None:
            volume_in, price_in, opened_at, long, entry_commission = mp.volume, mp.price_open, mp.opened_at, mp.type == 0, 0.0
        else:
            continue  # Opened before the Mirror knew the position: no entry to report
        if price_in is None:
            continue
        share = min(1.0, (d.volume or 0) / volume_in) if volume_in else 1.0
        items.append({
            "strategy_id": str(d.magic),
            "symbol": d.symbol or (mp.symbol if mp is not None else None),
            "side": "LONG" if long else "SHORT",
            "entry_price": price_in,
            "exit_price": d.price,
            "quantity": d.volume,
            "pnl": round(d.profit or 0, 2),
            "fees": round((d.commission or 0) + (d.swap or 0) + entry_commission * share, 2),
            "duration": max(0, int((d.time - opened_at).total_seconds())) if opened_at else 0,
            "traded_at": d.time.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "external_id": f"mirror:{d.master_login}:{d.deal_id}",
            "source": "mirror",
        })
    return items


def advance(db: Session, link: models.DashLink, token: str, post: Send, now: datetime.datetime) -> int:
    """Sends what the link has not sent yet; the number of items the Dash took."""
    portfolio = link.portfolio
    magics = {s.magic_number for s in portfolio.strategies}
    sent = 0
    for _ in range(MAX_STEPS):
        deals = (db.query(models.MasterDeal)
                 .filter(models.MasterDeal.manager_id == portfolio.user_id, models.MasterDeal.id > link.deal_cursor)
                 .order_by(models.MasterDeal.id).limit(BATCH).all())
        if not deals:
            break
        exits = [d for d in deals if d.entry in OUT and d.pos_id and d.type in (0, 1) and d.magic in magics
                 and d.time >= link.send_since]
        items = items_for(db, portfolio.user_id, exits)
        if items:
            link.last_attempt_at = now
            status, body = post(token, items)
            if status not in (200, 201):
                stop = refusal(status)
                link.status = "error" if stop else "active"
                link.last_error = stop or failure(status, body)
                db.commit()
                logger.warning(f"Dash link {link.id} (portfolio {portfolio.id}): {status} {body[:120]}")
                return sent
            sent += len(items)
            link.sent_count += len(items)
            link.last_sent_at, link.status, link.last_error = now, "active", None
        link.deal_cursor = deals[-1].id
        db.commit()
    return sent


def run_once(session_factory=database.SessionLocal, post: Optional[Send] = None,
             now: Optional[datetime.datetime] = None, fetch: Optional[Callable[[str], Tuple[int, str]]] = None) -> int:
    post = post or send
    fetch = fetch or fetch_backtest
    now = now or datetime.datetime.utcnow()
    fernet = hosting.cipher()
    if fernet is None:
        return 0
    db = session_factory()
    total = 0
    try:
        for link in db.query(models.DashLink).all():
            if (link.status == "error" and link.last_attempt_at is not None
                    and (now - link.last_attempt_at).total_seconds() < ERROR_RETRY_SECONDS):
                continue
            try:
                token = fernet.decrypt(link.token_encrypted.encode()).decode()
                total += advance(db, link, token, post, now)
                stale = (link.backtest_fetched_at is None
                         or (now - link.backtest_fetched_at).total_seconds() >= BACKTEST_REFRESH_SECONDS)
                if MIRROR_KEY and link.status == "active" and stale:
                    refresh_backtest(db, link, token, fetch, now)
            except Exception as e:
                db.rollback()
                logger.error(f"Dash link {link.id} failed this round: {type(e).__name__}: {str(e)[:200]}")
        return total
    finally:
        db.close()


def run_forever(stop: threading.Event):
    logger.info(f"Dash bridge: every {INTERVAL} s to {INGEST_URL}")
    while not stop.wait(INTERVAL):
        try:
            run_once()
        except Exception as e:
            logger.error(f"Dash bridge round failed: {type(e).__name__}: {str(e)[:200]}")
