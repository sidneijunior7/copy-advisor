"""
Performance of a portfolio (from the Master's deals, V2DEAL) and of a client's copies (from the profit its Slave
reports, Slave 4.04+). Both come out in the same shape (stats), in the account's currency.

A trade is a position that closed: its result is every deal of it, entry commission and swap included. A portfolio's
trades are the positions the hub sent to its clients (portfolio_trades): its track record is what the clients got,
whatever the portfolio's strategies or account are now. The trades from before the Master connected are apart
(before_mirror).

Return and drawdown in percent are over the portfolio's capital (track_capital): the one declared on the Dash, which
sizes the strategies (Monte Carlo on the backtest), else the Master account's balance before the period's first
trade. A demo account holding far more than the strategies use would otherwise shrink them. With more than one
Master account behind a portfolio they are left out: the accounts do not add up to one.
"""
import bisect
import datetime
import json
from collections import OrderedDict
from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

import models

MAX_DAYS = 3650
DEAL_OUT = (1, 2, 3)  # DEAL_ENTRY_OUT, INOUT, OUT_BY: deals that realize a result
EQUITY_POINTS = 400  # Hourly snapshots are thinned to about this many points
CLOSE_SLACK = datetime.timedelta(days=1)  # The hub's close time trails the exit deal's by the time it took to arrive


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


def balance_at(db: Session, manager_id: int, login: int):
    """(balance at a moment, currency) of a Master account: its latest balance (V2ACC) moved back or forward by the
    deals in between, since every deal moves the balance (trades, deposits, withdrawals). So a trade from before the
    first snapshot has its own balance, not today's. (None, None) without a balance."""
    snap = (db.query(models.AccountSnapshot)
            .filter(models.AccountSnapshot.kind == "master", models.AccountSnapshot.owner_id == manager_id,
                    models.AccountSnapshot.login == login, models.AccountSnapshot.balance.isnot(None))
            .order_by(models.AccountSnapshot.hour.desc()).first())
    if snap is None:
        return None, None
    end_of_hour = snap.hour + datetime.timedelta(hours=1)
    anchor = min(snap.updated_at, end_of_hour) if snap.updated_at else end_of_hour
    times, cum = [], [0.0]  # cum[i]: what the first i deals moved
    for at, profit, swap, commission in (
            db.query(models.MasterDeal.time, models.MasterDeal.profit, models.MasterDeal.swap,
                     models.MasterDeal.commission)
            .filter(models.MasterDeal.manager_id == manager_id, models.MasterDeal.master_login == login)
            .order_by(models.MasterDeal.time)):
        times.append(at)
        cum.append(cum[-1] + (profit or 0) + (swap or 0) + (commission or 0))
    base = snap.balance - cum[bisect.bisect_left(times, anchor)]
    return (lambda at: base + cum[bisect.bisect_left(times, at)]), snap.currency


def _closed(ds: List[models.MasterDeal]) -> Optional[Tuple[datetime.datetime, float, datetime.datetime, float]]:
    """(close time, result, open time, lots closed) of a position from its deals; None until it has an exit deal."""
    outs = [d for d in ds if d.entry in DEAL_OUT]
    if not outs:
        return None  # The hub has the close but not its deal yet (a Master before 4.01)
    result = sum((d.profit or 0) + (d.swap or 0) + (d.commission or 0) for d in ds)
    return max(d.time for d in outs), result, min(d.time for d in ds), sum(d.volume or 0 for d in outs)


def _deals_of(db: Session, manager_id: int, keys) -> Dict[Tuple[int, int], List[models.MasterDeal]]:
    """The deals of these (login, pos_id) positions."""
    deals: Dict[Tuple[int, int], List[models.MasterDeal]] = {}
    if not keys:
        return deals
    for d in (db.query(models.MasterDeal)
              .filter(models.MasterDeal.manager_id == manager_id,
                      models.MasterDeal.pos_id.in_(sorted({k[1] for k in keys})))):
        if (d.master_login, d.pos_id) in keys:
            deals.setdefault((d.master_login, d.pos_id), []).append(d)
    return deals


def _results(db: Session, p: models.Portfolio, start: datetime.datetime):
    """(close time, result, strategy id, open time, lots) of each position the hub sent to the portfolio's clients
    (portfolio_trades) that closed since start, and the Master accounts behind them. What went stays: removing a
    strategy or changing the account does not take a trade out."""
    rows = (db.query(models.PortfolioTrade)
            .join(models.MasterPosition, (models.MasterPosition.manager_id == models.PortfolioTrade.manager_id)
                  & (models.MasterPosition.master_login == models.PortfolioTrade.master_login)
                  & (models.MasterPosition.pos_id == models.PortfolioTrade.pos_id))
            .filter(models.PortfolioTrade.portfolio_id == p.id, models.MasterPosition.closed_at.isnot(None),
                    models.MasterPosition.closed_at >= start - CLOSE_SLACK)
            .all())
    strategy_of = {(t.master_login, t.pos_id): t.strategy_id for t in rows}
    out, logins = [], set()
    for key, ds in _deals_of(db, p.user_id, set(strategy_of)).items():
        closed = _closed(ds)
        if closed is None or closed[0] < start:
            continue
        out.append((closed[0], closed[1], strategy_of[key], closed[2], closed[3]))
        logins.add(key[0])
    return out, sorted(logins)


def before_mirror(db: Session, p: models.Portfolio, start: datetime.datetime) -> dict:
    """The trades of the portfolio's strategies its Master account made before first connecting to the Mirror (the
    history a Master 4.01 sends, DEALS_FIRST_DAYS). No client got them and nothing shows the account was not picked
    for them, so they are shown apart, never in the track record."""
    by_magic = {s.magic_number for s in p.strategies if s.magic_number is not None}
    accounts = db.query(models.MasterAccount).filter(models.MasterAccount.manager_id == p.user_id)
    if p.master_login is not None:
        accounts = accounts.filter(models.MasterAccount.master_login == p.master_login)
    first_seen = {a.master_login: a.first_seen_at for a in accounts if a.first_seen_at is not None}
    empty = {"trades": 0, "net": 0.0, "until": None}
    if not by_magic or not first_seen:
        return empty
    keys = {(login, pos_id) for login, pos_id in (
        db.query(models.MasterDeal.master_login, models.MasterDeal.pos_id)
        .filter(models.MasterDeal.manager_id == p.user_id, models.MasterDeal.master_login.in_(list(first_seen)),
                models.MasterDeal.entry.in_(DEAL_OUT), models.MasterDeal.pos_id != 0, models.MasterDeal.time >= start)
        .distinct())}
    if not keys:
        return empty
    watched = {(login, pos_id) for login, pos_id in (
        db.query(models.MasterPosition.master_login, models.MasterPosition.pos_id)
        .filter(models.MasterPosition.manager_id == p.user_id,
                models.MasterPosition.pos_id.in_(sorted({k[1] for k in keys}))))}
    results = []
    for key, ds in _deals_of(db, p.user_id, keys - watched).items():
        ds.sort(key=lambda d: (d.entry != 0, d.time))  # The entry's magic first: a hand close has magic 0
        closed = _closed(ds)
        if closed is None or closed[2] >= first_seen[key[0]]:
            continue
        if next((d.magic for d in ds if d.magic in by_magic), None) is not None:
            results.append(closed[1])
    return {"trades": len(results), "net": round(sum(results), 2), "until": min(first_seen.values())}


def portfolio_results(db: Session, p: models.Portfolio, start: datetime.datetime):
    """(close time, result) of each closed position since start, and the Master accounts behind them."""
    rows, logins = _results(db, p, start)
    return [(at, result) for at, result, _, _, _ in rows], logins


def track_capital(db: Session, p: models.Portfolio, logins: List[int]) -> dict:
    """What the portfolio's percentages are over: {"capital", "currency", "source", "balance_at"}. source is dash-mc
    (the maximum drawdown plus 3 sigma of the portfolio's Monte Carlo on the Dash, the capital its strategies run
    with), dash (the balance declared on the Dash) or account (the balance before the period, through balance_at); currency-mismatch when the Dash declared it in another currency than the account's, accounts with
    more than one Master account, None without any. The currency is the Master account's."""
    if len(logins) > 1:
        return {"capital": None, "currency": None, "source": "accounts", "balance_at": None}
    login = logins[0] if logins else p.master_login
    at, currency = balance_at(db, p.user_id, login) if login is not None else (None, None)
    out = {"capital": None, "currency": currency, "source": "account" if at is not None else None, "balance_at": at}
    link = db.query(models.DashLink).filter(models.DashLink.portfolio_id == p.id).first()
    declared = {}
    if link is not None and link.backtest:
        try:
            declared = json.loads(link.backtest)
        except ValueError:
            declared = {}
    monte_carlo = float(declared.get("capital") or 0)
    dash_capital = monte_carlo or float(declared.get("initial_balance") or 0)
    if dash_capital <= 0:
        return out
    dash_currency = (declared.get("currency") or "").upper() or None
    if currency and dash_currency and dash_currency != currency.upper():
        return {**out, "source": "currency-mismatch"}
    return {**out, "capital": dash_capital, "currency": currency or dash_currency,
            "source": "dash-mc" if monte_carlo else "dash"}


def portfolio(db: Session, p: models.Portfolio, days: int, now: datetime.datetime) -> dict:
    """The positions the portfolio's clients got that closed in the period, as the Master's deals tell them."""
    start = since(days, now)
    rows, logins = _results(db, p, start)
    results: List[Tuple[datetime.datetime, float]] = [(at, result) for at, result, _, _, _ in rows]
    by_strategy: Dict[int, List[Tuple[datetime.datetime, float]]] = {}
    for at, result, strategy_id, _, _ in rows:
        by_strategy.setdefault(strategy_id, []).append((at, result))
    lots = sum(volume for _, _, _, _, volume in rows)  # The average result per lot is net / lots
    track = track_capital(db, p, logins)
    capital = track["capital"]
    if track["source"] == "account":
        capital = round(track["balance_at"](min(opened for _, _, _, opened, _ in rows)), 2) if rows else None
    # A strategy taken out of the portfolio still has its trades here
    names = {s.id: s.name for s in db.query(models.Strategy).filter(models.Strategy.id.in_(sorted(by_strategy)))}
    return {
        **stats(results, capital, track["currency"]),
        "strategies": [{"id": sid, "name": names.get(sid), "trades": len(rs), "net": round(sum(r for _, r in rs), 2)}
                       for sid, rs in sorted(by_strategy.items())],
        "lots": round(lots, 2),
        "per_lot": round(sum(r for _, r in results) / lots, 2) if lots > 0 else None,
        "master_login": p.master_login,
        "capital_source": track["source"],
        "before_mirror": before_mirror(db, p, start),
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
