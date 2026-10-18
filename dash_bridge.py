"""
Bridge to the Trademetric Dash: the Master's closed trades of a linked portfolio go to the Dash portfolio whose API
token the manager pasted, in the format of the Dash's own Live Tracking EA (one item per exit deal). A strategy
creator then runs one EA, the Master, for both products.

- The Dash address comes from DASH_INGEST_URL, never from the user.
- Each item carries external_id "mirror:<master login>:<deal>", which the Dash uses to drop what it already has: a
  send that timed out can be repeated.
- The token is kept encrypted with HOSTING_SECRET, like the hosted accounts' passwords.
- A link remembers the last master_deals.id it went through (deal_cursor) and sends only the deals closed from
  send_since on: the moment it was made, or up to 90 days before when the manager asked for the history.
- A token the Dash refuses (revoked, or a plan without live tracking) stops the link; it is tried again every
  ERROR_RETRY_SECONDS, so fixing the plan on the Dash is enough. Other failures are tried again the next round.
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
    req = urllib.request.Request(INGEST_URL, data=json.dumps(items).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "x-api-token": token,
                                          "User-Agent": "TrademetricMirror/1"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read(500).decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(500).decode(errors="replace")
    except (urllib.error.URLError, OSError) as e:
        return 0, str(e)[:200]


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
    return {"token_hint": link.token_hint, "status": link.status, "last_error": link.last_error,
            "last_sent_at": link.last_sent_at, "sent_count": link.sent_count, "send_since": link.send_since,
            "created_at": link.created_at}


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
             now: Optional[datetime.datetime] = None) -> int:
    post = post or send
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
