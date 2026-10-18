"""
How the followers of a portfolio copied it: for each copy that closed, the prices the Slave got against the Master's,
in points (price units), so that accounts of any size compare.

A copy is one license's executions for one Master position (uid <master login>_<position>). It counts once both
sides are closed and the Master's deals are known (Master 4.01+). A position reversed on either side is left out:
its entry is not one price.

    master points   = (master exit - master entry) x d        d = +1 buy, -1 sell; prices weighted by volume
    follower points = (follower exit - follower entry) x d
    entry cost      = (follower entry - master entry) x d     positive is worse for the follower
    exit cost       = (master exit - follower exit) x d

Points of different symbols do not add up, so the numbers are per symbol (the Master's). Capture, the follower's
points over the Master's, is the one figure across symbols: weighted by copies, and only where the Master gained.
"""
import datetime
import os
import statistics
from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

import models
import performance

DONE = models.EXECUTION_DONE
OPENING = ("OPEN", "ADD")
CLOSING = ("CLOSE", "PARTIAL", "CLOSE_EXT")
MASTER_IN, MASTER_OUT, MASTER_INOUT = (0,), (1, 3), 2  # DEAL_ENTRY
LOT_LIMIT = 10034  # The license's lot limit held the copy back: the manager's setting, not a failure to copy
CHUNK = 500  # uids per IN (...) query
# The public page shows the figures only past these: fewer followers could be told apart
MIN_FOLLOWERS = int(os.getenv("FOLLOWER_STATS_MIN_FOLLOWERS", "5"))
MIN_COPIES = int(os.getenv("FOLLOWER_STATS_MIN_COPIES", "20"))


def _vwap(rows) -> Tuple[float, Optional[float]]:
    volume = sum(r.volume for r in rows)
    return volume, (sum(r.volume * r.price for r in rows) / volume if volume > 0 else None)


def _chunks(items: list):
    for i in range(0, len(items), CHUNK):
        yield items[i:i + CHUNK]


def _master_uid(uid: str) -> Optional[Tuple[int, int]]:
    login, _, pos = uid.partition("_")
    return (int(login), int(pos)) if login.isdigit() and pos.isdigit() else None


def portfolio(db: Session, p: models.Portfolio, days: int, now: datetime.datetime) -> dict:
    start = performance.since(days, now)

    # Copy rate and latency: the copies whose opening was asked in the period
    opened, refused, latencies = set(), set(), []
    for login, uid, retcode, latency in (
            db.query(models.Execution.mt5_login, models.Execution.uid, models.Execution.retcode, models.Execution.latency_ms)
            .filter(models.Execution.portfolio_id == p.id, models.Execution.created_at >= start,
                    models.Execution.action == "OPEN")):
        if retcode in DONE:
            opened.add((login, uid))
            if latency is not None:
                latencies.append(latency)
        elif retcode != LOT_LIMIT:
            refused.add((login, uid))
    refused -= opened  # Refused, then opened on a later try
    asked = len(opened) + len(refused)

    # The copies that closed in the period, then every report of them: their entries may be older
    closed = (db.query(models.Execution.mt5_login, models.Execution.uid)
              .filter(models.Execution.portfolio_id == p.id, models.Execution.created_at >= start,
                      models.Execution.action.in_(CLOSING), models.Execution.retcode.in_(DONE))
              .distinct().all())
    closed = set(closed)
    uids = sorted({uid for _, uid in closed if _master_uid(uid)})
    copies: Dict[Tuple[int, str], List[models.Execution]] = {}
    for part in _chunks(uids):
        for e in (db.query(models.Execution)
                  .filter(models.Execution.portfolio_id == p.id, models.Execution.uid.in_(part),
                          models.Execution.retcode.in_(DONE))):
            if (e.mt5_login, e.uid) in closed:  # Another follower's copy of the position may have closed earlier
                copies.setdefault((e.mt5_login, e.uid), []).append(e)

    masters: Dict[str, Tuple[models.MasterPosition, List[models.MasterDeal]]] = {}
    pos_ids = sorted({_master_uid(uid)[1] for uid in uids})
    for part in _chunks(pos_ids):
        for mp in (db.query(models.MasterPosition)
                   .filter(models.MasterPosition.manager_id == p.user_id, models.MasterPosition.pos_id.in_(part))):
            masters[f"{mp.master_login}_{mp.pos_id}"] = (mp, [])
        for d in (db.query(models.MasterDeal)
                  .filter(models.MasterDeal.manager_id == p.user_id, models.MasterDeal.pos_id.in_(part))):
            hit = masters.get(f"{d.master_login}_{d.pos_id}")
            if hit is not None:
                hit[1].append(d)

    by_symbol: Dict[str, List[Tuple[float, float, float, float]]] = {}
    followers = set()
    for (login, uid), execs in copies.items():
        master = masters.get(uid)
        if master is None or any(e.action == "REVERSE" for e in execs):
            continue
        mp, deals = master
        if mp.closed_at is None or any(d.entry == MASTER_INOUT for d in deals):
            continue
        _, m_out = _vwap([d for d in deals if d.entry in MASTER_OUT and d.volume and d.price])
        _, m_in = _vwap([d for d in deals if d.entry in MASTER_IN and d.volume and d.price])
        m_in = m_in if m_in is not None else mp.price_open  # Opened before the Master's first deals
        vol_in, f_in = _vwap([e for e in execs if e.action in OPENING and e.volume and e.price])
        vol_out, f_out = _vwap([e for e in execs if e.action in CLOSING and e.volume and e.price])
        if None in (m_in, m_out, f_in, f_out) or abs(vol_in - vol_out) > 1e-6:
            continue  # Still open on the client, or a side without prices
        d = 1 if mp.type == 0 else -1
        by_symbol.setdefault(mp.symbol, []).append(
            ((m_out - m_in) * d, (f_out - f_in) * d, (f_in - m_in) * d, (m_out - f_out) * d))
        followers.add(login)

    symbols, weighted, weight = [], 0.0, 0
    for symbol, rows in sorted(by_symbol.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        master_sum, follower_sum = sum(r[0] for r in rows), sum(r[1] for r in rows)
        capture = round(follower_sum / master_sum * 100, 1) if master_sum > 0 else None
        if capture is not None:
            weighted += capture * len(rows)
            weight += len(rows)
        mean = lambda i: round(statistics.fmean(r[i] for r in rows), 6)
        symbols.append({"symbol": symbol, "copies": len(rows), "master_points": mean(0), "follower_points": mean(1),
                        "entry_cost": mean(2), "exit_cost": mean(3), "capture": capture})
    return {
        "followers": len(followers),
        "copies": sum(len(rows) for rows in by_symbol.values()),
        "capture": round(weighted / weight, 1) if weight else None,
        "copy_rate": round(len(opened) / asked * 100, 1) if asked else None,
        "latency_ms": round(statistics.median(latencies)) if latencies else None,
        "symbols": symbols,
    }


def public(stats: dict) -> dict:
    """What the marketplace shows: the figures only with enough followers and copies behind them."""
    enough = stats["followers"] >= MIN_FOLLOWERS and stats["copies"] >= MIN_COPIES
    return {"enough": enough, "min_followers": MIN_FOLLOWERS, "min_copies": MIN_COPIES} | (stats if enough else {})
