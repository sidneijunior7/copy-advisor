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
- The same answer brings the live tracking of the Dash portfolio's strategies, which is frozen as the portfolio's
  homologation (freeze_incubation): the Dash sends it in the order it recorded it, from the portfolio's cursor on. The
  first time it is their whole live tracking, also from before the Dash portfolio was put together (composed_at, which
  the listing shows). A trade the manager's EA sent counts only if recorded as it closed: history it sent afterwards
  was not followed live. One verified by OnTick counts whenever recorded: it comes from the broker's statement of the
  account, and connecting OnTick brings the account's past in one go. Later, a
  strategy put into the Dash portfolio brings only what is recorded after that, and one taken out keeps what it had.
"""
import datetime
import json
import logging
import os
import re
import threading
import urllib.error
import urllib.parse
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
# A live tracking trade from the manager's EA recorded this long after it closed is left out of the homologation: the
# EA records a trade as it closes, so a late one is history sent afterwards, not followed live. OnTick's are exempt:
# they come from the broker, and connecting OnTick records the account's past all at once.
LATE_LIMIT = datetime.timedelta(days=3)

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


def fetch_backtest(token: str, live_after: Optional[str] = None) -> Tuple[int, str]:
    """GET the linked Dash portfolio's backtest, with its live tracking recorded from live_after on: (HTTP status,
    body); status 0 when the Dash did not answer."""
    url = BACKTEST_URL + (f"?live_after={urllib.parse.quote(live_after)}" if live_after else "")
    req = urllib.request.Request(url, method="GET", headers={
        "x-api-token": token, "x-mirror-key": MIRROR_KEY, "User-Agent": "TrademetricMirror/1"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read(5_000_000).decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(500).decode(errors="replace")
    except (urllib.error.URLError, OSError) as e:
        return 0, str(e)[:200]


def compact_backtest(body: str) -> dict:
    """What the Mirror keeps of the Dash answer: the net result of each trade, in order, and what describes them. The
    live tracking is not kept here but frozen apart (freeze_incubation)."""
    data = json.loads(body)
    trades = [t for t in data.get("trades") or [] if isinstance(t, dict) and isinstance(t.get("pnl"), (int, float))]
    capital = data.get("capital") if isinstance(data.get("capital"), dict) else {}
    capital_value = capital.get("value") if isinstance(capital.get("value"), (int, float)) else 0
    portfolio = data.get("portfolio") if isinstance(data.get("portfolio"), dict) else {}
    return {
        "name": str(portfolio.get("name") or "")[:100],
        # When the Dash portfolio was put together: its homologation from before is its strategies' live tracking
        "composed_at": str(portfolio["created_at"])[:40] if portfolio.get("created_at") else None,
        "initial_balance": float(data.get("initial_balance") or 0),
        "capital": round(float(capital_value), 2) if capital_value > 0 else None,  # Monte Carlo DD + 3 sigma
        "currency": (str(data["currency"])[:3] if data.get("currency") else None),
        "strategies": [{"name": str(s.get("name") or "")[:100], "magic_number": s.get("magic_number")}
                       for s in (data.get("strategies") or [])[:50] if isinstance(s, dict)],
        "pnl": [round(float(t["pnl"]), 2) for t in trades],
        "from": trades[0].get("t") if trades else None,
        "to": trades[-1].get("t") if trades else None,
        "truncated": bool(data.get("truncated")),
    }


def _utc(text) -> Optional[datetime.datetime]:
    """A Dash timestamp as naive UTC, like the Mirror's; None when it is not one."""
    try:
        t = datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t.astimezone(datetime.timezone.utc).replace(tzinfo=None) if t.tzinfo else t


def freeze_incubation(db: Session, portfolio: models.Portfolio, live: dict, now: datetime.datetime) -> int:
    """Takes the Dash live tracking trades into the portfolio's homologation (IncubationTrade); how many it took.

    - A trade with its MT5 account must be from the account the portfolio copies from, when it names one. A trade
      without it (recorded before the Dash kept the account) only from the Dash portfolio's own token or OnTick, not
      from another Dash portfolio of the same strategies, which may be a demo.
    - A trade from the manager's EA recorded more than LATE_LIMIT after it closed is left out: it was not followed
      live. One verified by OnTick is taken whenever recorded: the broker's statement says it happened.
    - The cursor moves past every trade the Dash sent, taken or not, so none comes back. With no trade at all on the
      first import it starts now: what the Dash records afterwards comes, a strategy's older trades never."""
    trades = [t for t in live.get("trades") or [] if isinstance(t, dict)]
    first = portfolio.incubation_cursor is None
    cursor, cursor_at = portfolio.incubation_cursor, _utc(portfolio.incubation_cursor)
    origin = str(portfolio.master_login) if portfolio.master_login is not None else None
    ids = [str(t.get("id"))[:64] for t in trades if t.get("id")]
    known = {i for (i,) in db.query(models.IncubationTrade.dash_id)
             .filter(models.IncubationTrade.portfolio_id == portfolio.id, models.IncubationTrade.dash_id.in_(ids))}
    taken = 0
    for t in trades:
        recorded = _utc(t.get("created"))
        if recorded is not None and (cursor_at is None or recorded > cursor_at):
            cursor, cursor_at = str(t["created"])[:40], recorded
        traded = _utc(t.get("t"))
        dash_id = str(t.get("id") or "")[:64]
        if not dash_id or dash_id in known or traded is None or not isinstance(t.get("pnl"), (int, float)):
            continue
        account = str(t["account"]).strip()[:20] if t.get("account") not in (None, "") else None
        if account is not None:
            if origin is not None and account != origin:
                continue
        elif t.get("same_portfolio") is not True and t.get("verified") is not True:
            continue
        if recorded is not None and recorded - traded > LATE_LIMIT and t.get("verified") is not True:
            continue
        lots = t.get("lots")
        db.add(models.IncubationTrade(
            portfolio_id=portfolio.id, dash_id=dash_id, strategy=str(t.get("strategy") or "")[:64] or None,
            account_login=account, traded_at=traded, recorded_at=recorded, pnl=round(float(t["pnl"]), 2),
            lots=float(lots) if isinstance(lots, (int, float)) else None, verified=t.get("verified") is True,
            received_at=now))
        known.add(dash_id)
        taken += 1
    if cursor is None and not trades:
        cursor = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    # Trades but no recording time: a Dash from before the cursor, which sends no ids either. The cursor waits for one
    # that does, or the history would be lost
    portfolio.incubation_cursor = cursor
    return taken


def composed_at(db: Session, portfolio_id: int) -> Optional[datetime.datetime]:
    """When the linked Dash portfolio was put together, as its last backtest said; None without."""
    link = db.query(models.DashLink).filter(models.DashLink.portfolio_id == portfolio_id).first()
    try:
        data = json.loads(link.backtest) if link is not None and link.backtest else {}
    except ValueError:
        return None
    return _utc(data["composed_at"]) if data.get("composed_at") else None


Fetch = Callable[[str, Optional[str]], Tuple[int, str]]


def refresh_backtest(db: Session, link: models.DashLink, token: str, fetch: Fetch, now: datetime.datetime):
    """Keeps a fresh copy of the backtest on the link and freezes the new live tracking trades; a failure keeps the
    last copy and says why. A live tracking cut short is asked for again the next round, from where it stopped."""
    status, body = fetch(token, link.portfolio.incubation_cursor)
    link.backtest_fetched_at = now  # Also on failure: the next try waits for the next refresh
    if status == 200:
        try:
            link.backtest = json.dumps(compact_backtest(body), separators=(",", ":"))
            link.backtest_error = None
            live = json.loads(body).get("live")
            if isinstance(live, dict):  # A Dash from before the live tracking sends none: the cursor stays
                freeze_incubation(db, link.portfolio, live, now)
                if live.get("truncated"):
                    link.backtest_fetched_at = None
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
                        "initial_balance": data.get("initial_balance") or None, "capital": data.get("capital"),
                        "currency": data.get("currency")}
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
                 and d.time >= link.send_since
                 and (portfolio.master_login is None or d.master_login == portfolio.master_login)]
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
             now: Optional[datetime.datetime] = None, fetch: Optional[Fetch] = None) -> int:
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
