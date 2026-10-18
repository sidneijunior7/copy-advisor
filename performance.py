"""
Performance of a portfolio (from the Master's deals, V2DEAL) and of a client's copies (from the profit its Slave
reports, Slave 4.04+). Both come out in the same shape (stats), in the account's currency.

A trade is a position that closed: its result is every deal of it, entry commission and swap included. Return and
drawdown in percent need the balance of the Master account at the start of the period (V2ACC); with more than one
Master account behind a portfolio they are left out, since the balances do not add up to one account.
"""
import datetime
from collections import OrderedDict
from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

import models

MAX_DAYS = 3650
DEAL_OUT = (1, 2, 3)  # DEAL_ENTRY_OUT, INOUT, OUT_BY: deals that realize a result
EQUITY_POINTS = 400  # Hourly snapshots are thinned to about this many points


def since(days: int, now: datetime.datetime) -> datetime.datetime:
    return now - datetime.timedelta(days=max(1, min(days, MAX_DAYS)))


def stats(results: List[Tuple[datetime.datetime, float]], start_balance: Optional[float] = None,
          currency: Optional[str] = None) -> dict:
    """Trade statistics from (close time, net result) pairs. The curve is the cumulative result after each trade;
    the drawdown is the deepest fall of that curve from a previous high."""
    results = sorted(results, key=lambda r: r[0])
    wins = [r for _, r in results if r > 0]
    losses = [r for _, r in results if r < 0]
    gross_profit, gross_loss = sum(wins), -sum(losses)
    net = sum(r for _, r in results)
    curve, months = [], OrderedDict()
    total = peak = 0.0
    drawdown = 0.0
    for at, r in results:
        total += r
        peak = max(peak, total)
        drawdown = max(drawdown, peak - total)
        curve.append({"t": at, "v": round(total, 2)})
        key = at.strftime("%Y-%m")
        months[key] = round(months.get(key, 0.0) + r, 2)
    pct = (lambda v: round(v / start_balance * 100, 2)) if start_balance and start_balance > 0 else (lambda v: None)
    return {
        "currency": currency,
        "trades": len(results),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": round(len(wins) / len(results) * 100, 1) if results else None,
        "net": round(net, 2),
        "gross_profit": round(gross_profit, 2),
        "gross_loss": round(gross_loss, 2),
        "profit_factor": round(gross_profit / gross_loss, 2) if gross_loss > 0 else None,
        "avg_win": round(gross_profit / len(wins), 2) if wins else None,
        "avg_loss": round(-gross_loss / len(losses), 2) if losses else None,
        "best": round(max(r for _, r in results), 2) if results else None,
        "worst": round(min(r for _, r in results), 2) if results else None,
        "max_drawdown": round(drawdown, 2),
        "start_balance": start_balance,
        "return_pct": pct(net),
        "max_drawdown_pct": pct(drawdown),
        "months": [{"month": k, "net": v} for k, v in months.items()],
        "curve": curve,
    }


def _first_balance(db: Session, kind: str, owner_id: int, logins: List[int], start: datetime.datetime):
    """(balance, currency) of the first snapshot of the period, when there is a single account."""
    if len(logins) != 1:
        return None, None
    snap = (db.query(models.AccountSnapshot)
            .filter(models.AccountSnapshot.kind == kind, models.AccountSnapshot.owner_id == owner_id,
                    models.AccountSnapshot.login == logins[0], models.AccountSnapshot.hour >= start)
            .order_by(models.AccountSnapshot.hour).first())
    if snap is None:  # The period started before the first snapshot: the latest one is the best guess
        snap = (db.query(models.AccountSnapshot)
                .filter(models.AccountSnapshot.kind == kind, models.AccountSnapshot.owner_id == owner_id,
                        models.AccountSnapshot.login == logins[0])
                .order_by(models.AccountSnapshot.hour.desc()).first())
    return (snap.balance, snap.currency) if snap else (None, None)


def _results(db: Session, p: models.Portfolio, start: datetime.datetime):
    """(close time, result, strategy id) of each position of the portfolio's strategies that closed since start,
    and the Master accounts behind them."""
    strategy_ids = [s.id for s in p.strategies]
    if not strategy_ids:
        return [], []
    positions = (db.query(models.MasterPosition)
                 .filter(models.MasterPosition.manager_id == p.user_id,
                         models.MasterPosition.strategy_id.in_(strategy_ids),
                         models.MasterPosition.closed_at.isnot(None),
                         models.MasterPosition.closed_at >= start)
                 .all())
    by_key = {(mp.master_login, mp.pos_id): mp for mp in positions}
    if not by_key:
        return [], []
    out = []
    deals: Dict[Tuple[int, int], List[models.MasterDeal]] = {}
    logins = sorted({k[0] for k in by_key})
    for d in (db.query(models.MasterDeal)
              .filter(models.MasterDeal.manager_id == p.user_id, models.MasterDeal.master_login.in_(logins),
                      models.MasterDeal.pos_id.in_([k[1] for k in by_key]))):
        if (d.master_login, d.pos_id) in by_key:
            deals.setdefault((d.master_login, d.pos_id), []).append(d)
    for key, ds in deals.items():
        outs = [d for d in ds if d.entry in DEAL_OUT]
        if not outs:
            continue  # The hub has the close but not its deal yet (a Master before 4.01)
        result = sum((d.profit or 0) + (d.swap or 0) + (d.commission or 0) for d in ds)
        out.append((max(d.time for d in outs), result, by_key[key].strategy_id))
    return out, logins


def portfolio_results(db: Session, p: models.Portfolio, start: datetime.datetime):
    """(close time, result) of each closed position since start, and the Master accounts behind them."""
    rows, logins = _results(db, p, start)
    return [(at, result) for at, result, _ in rows], logins


def portfolio(db: Session, p: models.Portfolio, days: int, now: datetime.datetime) -> dict:
    """The closed positions of the portfolio's strategies in the period, as the Master's deals tell them."""
    start = since(days, now)
    if not p.strategies:
        return {**stats([]), "strategies": []}
    rows, logins = _results(db, p, start)
    results: List[Tuple[datetime.datetime, float]] = [(at, result) for at, result, _ in rows]
    by_strategy: Dict[int, List[Tuple[datetime.datetime, float]]] = {}
    for at, result, strategy_id in rows:
        by_strategy.setdefault(strategy_id, []).append((at, result))
    balance, currency = _first_balance(db, "master", p.user_id, logins, start)
    names = {s.id: s.name for s in p.strategies}
    return {
        **stats(results, balance, currency),
        "strategies": [{"id": sid, "name": names.get(sid), "trades": len(rs), "net": round(sum(r for _, r in rs), 2)}
                       for sid, rs in sorted(by_strategy.items())],
    }


def copies(db: Session, lic: models.License, days: int, now: datetime.datetime) -> dict:
    """The client's own result: the profit its Slave reported for each copy that closed in the period, and the
    balance and equity of its account (ACC)."""
    start = since(days, now)
    rows = (db.query(models.Execution)
            .filter(models.Execution.portfolio_id == lic.portfolio_id,
                    models.Execution.mt5_login == lic.client_mt5_login,
                    models.Execution.retcode.in_(models.EXECUTION_DONE),
                    models.Execution.profit.isnot(None))
            .order_by(models.Execution.id).all())
    by_uid: Dict[str, List[models.Execution]] = {}
    for r in rows:
        by_uid.setdefault(r.uid, []).append(r)
    results = []
    for execs in by_uid.values():
        closes = [e for e in execs if e.action in ("CLOSE", "PARTIAL", "CLOSE_EXT")]
        if not closes or closes[-1].created_at < start:
            continue
        results.append((closes[-1].created_at, sum(e.profit for e in execs)))
    snaps = (db.query(models.AccountSnapshot)
             .filter(models.AccountSnapshot.kind == "slave", models.AccountSnapshot.owner_id == lic.id,
                     models.AccountSnapshot.hour >= start)
             .order_by(models.AccountSnapshot.hour).all())
    step = max(1, len(snaps) // EQUITY_POINTS)
    equity = [{"t": s.hour, "balance": s.balance, "equity": s.equity} for s in snaps[::step]]
    if snaps and (not equity or equity[-1]["t"] != snaps[-1].hour):
        equity.append({"t": snaps[-1].hour, "balance": snaps[-1].balance, "equity": snaps[-1].equity})
    first = snaps[0] if snaps else None
    return {**stats(results, first.balance if first else None, snaps[-1].currency if snaps else None),
            "equity": equity}
