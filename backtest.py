"""
The backtest a manager declared on the Trademetric Dash, next to the live result: its numbers, and a Monte Carlo cone
the live result is drawn in.

Both sides are in percent of the account, so a backtest of one size compares with a live account of another:
- a backtest trade is its net result over the balance before it, from the capital declared on the Dash;
- a live trade (a closed Master position, performance.py) is its result over the Master's balance before it, from
  the hourly snapshots (V2ACC). It needs a single Master account behind the portfolio.

The cone: SIMULATION_BUDGET steps of bootstrap (backtest returns drawn with replacement), as many trades as the live
result has, compounded. At each point, the 5/25/50/75/95 percentiles of the cumulative return. The live result
below the 5th percentile at the end is worse than 95% of what the backtest allowed for.
"""
import bisect
import datetime
import json
import random
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

import models
import performance

MIN_BACKTEST_TRADES = 30
MIN_LIVE_TRADES = 5
SIMULATION_BUDGET = 400_000  # Simulated trades per cone: about a second of pure Python
MAX_SIMULATIONS = 1000
CONE_POINTS = 150
CURVE_POINTS = 200
PERCENTILES = (5, 25, 50, 75, 95)


def parse(text: Optional[str]) -> Optional[dict]:
    """The backtest kept on the link (dash_bridge.py), or None."""
    if not text:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    return data if isinstance(data, dict) and isinstance(data.get("pnl"), list) else None


def returns(pnls: List[float], initial_balance: float) -> List[float]:
    """Each trade over the balance before it. Stops if the account would be gone."""
    out, balance = [], initial_balance
    for p in pnls:
        if balance <= 0:
            break
        out.append(p / balance)
        balance += p
    return out


def _thin(n: int, points: int) -> List[int]:
    """1-based trade numbers to plot: every one up to `points`, then evenly spaced, always the last."""
    if n <= points:
        return list(range(1, n + 1))
    return sorted({max(1, round(i * n / points)) for i in range(1, points + 1)} | {n})


def stats(bt: dict) -> dict:
    """The declared backtest's headline numbers and its cumulative return per trade (percent of the capital)."""
    pnls = [float(p) for p in bt["pnl"]]
    initial = float(bt.get("initial_balance") or 0)
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    gross_loss = -sum(losses)
    out = {
        "trades": len(pnls),
        "from": bt.get("from"),
        "to": bt.get("to"),
        "currency": bt.get("currency"),
        "initial_balance": initial or None,
        "net": round(sum(pnls), 2),
        "win_rate": round(len(wins) / len(pnls) * 100, 1) if pnls else None,
        "profit_factor": round(sum(wins) / gross_loss, 2) if gross_loss > 0 else None,
        "return_pct": None,
        "max_drawdown_pct": None,
        "curve": [],
        "strategies": [s.get("name") for s in bt.get("strategies") or []],
        "truncated": bool(bt.get("truncated")),
    }
    if initial > 0 and pnls:
        balance = peak = initial
        drawdown = 0.0
        path = []
        for p in pnls:
            balance += p
            peak = max(peak, balance)
            drawdown = max(drawdown, (peak - balance) / peak if peak > 0 else 0)
            path.append(balance)
        out["return_pct"] = round((balance / initial - 1) * 100, 2)
        out["max_drawdown_pct"] = round(drawdown * 100, 2)
        out["curve"] = [{"k": k, "v": round((path[k - 1] / initial - 1) * 100, 3)} for k in _thin(len(path), CURVE_POINTS)]
    return out


def live_returns(db: Session, p: models.Portfolio, days: int, now: datetime.datetime) -> Tuple[List[float], Optional[str]]:
    """The portfolio's closed trades in the period as percent of the Master's balance before each; or the reason
    there are none."""
    results, logins = performance.portfolio_results(db, p, performance.since(days, now))
    if not results:
        return [], "no-trades"
    if len(logins) != 1:
        return [], "accounts"
    snaps = (db.query(models.AccountSnapshot.hour, models.AccountSnapshot.balance)
             .filter(models.AccountSnapshot.kind == "master", models.AccountSnapshot.owner_id == p.user_id,
                     models.AccountSnapshot.login == logins[0], models.AccountSnapshot.balance.isnot(None))
             .order_by(models.AccountSnapshot.hour).all())
    if not snaps:
        return [], "balance"
    # A snapshot holds the last balance of its hour: the one before a trade is from an earlier hour
    ends = [h + datetime.timedelta(hours=1) for h, _ in snaps]
    out = []
    for at, result in sorted(results):
        i = bisect.bisect_right(ends, at) - 1
        balance = snaps[max(i, 0)][1]
        if balance and balance > 0:
            out.append(result / balance)
    return out, None


def cone(bt_returns: List[float], live: List[float], seed: int = 0) -> Optional[dict]:
    """Percentile bands of the backtest's compounded return over as many trades as the live result has, and the
    live result on the same points (percent)."""
    n = len(live)
    if n < MIN_LIVE_TRADES or len(bt_returns) < MIN_BACKTEST_TRADES:
        return None
    ks = _thin(n, CONE_POINTS)
    sims = max(100, min(MAX_SIMULATIONS, SIMULATION_BUDGET // n))
    rng = random.Random(seed)
    draw = rng.choice
    at_points: List[List[float]] = [[] for _ in ks]
    for _ in range(sims):
        growth, j = 1.0, 0
        for k in range(1, n + 1):
            growth *= 1 + draw(bt_returns)
            if k == ks[j]:
                at_points[j].append(growth - 1)
                j += 1
    live_growth, live_at, j = 1.0, [], 0
    for k, r in enumerate(live, start=1):
        live_growth *= 1 + r
        if k == ks[j]:
            live_at.append(live_growth - 1)
            j += 1

    def pick(values: List[float], q: int) -> float:
        values.sort()
        return values[min(len(values) - 1, int(q / 100 * len(values)))]

    bands = []
    for k, values, live_value in zip(ks, at_points, live_at):
        band = {"k": k, "live": round(live_value * 100, 3)}
        for q in PERCENTILES:
            band[f"p{q}"] = round(pick(values, q) * 100, 3)
        bands.append(band)
    last = bands[-1]
    verdict = "below" if last["live"] < last["p5"] else "above" if last["live"] > last["p95"] else "inside"
    return {"trades": n, "simulations": sims, "bands": bands, "verdict": verdict}


def view(db: Session, p: models.Portfolio, link: Optional[models.DashLink], days: int, now: datetime.datetime,
         seed: int = 0) -> dict:
    """What the listing page shows: the declared backtest and the cone, or why there is none."""
    bt = parse(link.backtest) if link is not None else None
    if bt is None or not bt["pnl"]:
        return {"available": False}
    out = {"available": True, "fetched_at": link.backtest_fetched_at, "backtest": stats(bt), "cone": None,
           "cone_missing": None}
    initial = float(bt.get("initial_balance") or 0)
    if initial <= 0:
        out["cone_missing"] = "capital"
        return out
    live, missing = live_returns(db, p, days, now)
    result = cone(returns([float(x) for x in bt["pnl"]], initial), live, seed=seed) if not missing else None
    out["cone"] = result
    out["cone_missing"] = missing or (None if result else "few-trades")
    return out
