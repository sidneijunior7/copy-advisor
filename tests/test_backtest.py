"""The backtest declared on the Trademetric Dash next to the live result: the copy the bridge keeps, its numbers and
the Monte Carlo cone in percent of the account (backtest.py, dash_bridge.py)."""
import datetime
import json
import os
import random
import uuid

import pytest
from cryptography.fernet import Fernet

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import backtest  # noqa: E402
import dash_bridge  # noqa: E402
import database  # noqa: E402
import marketplace  # noqa: E402
import models  # noqa: E402
import server  # noqa: E402
from test_dash_bridge import FakeDash, new_token  # noqa: E402
from test_marketplace import LISTING, published  # noqa: E402

NOW = datetime.datetime.utcnow().replace(microsecond=0)


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


@pytest.fixture(autouse=True)
def hosting_secret(monkeypatch):
    monkeypatch.setenv("HOSTING_SECRET", Fernet.generate_key().decode())
    monkeypatch.setattr(dash_bridge, "MIRROR_KEY", "shared")


def dash_answer(pnls, initial=10_000.0):
    return json.dumps({
        "portfolio": {"name": "WIN Tendência", "is_public": True}, "initial_balance": initial, "currency": "BRL",
        "strategies": [{"name": "Tendência", "magic_number": "777", "initial_balance": initial}],
        "trades": [{"t": f"2025-01-{1 + i % 28:02d}T10:00:00", "pnl": p} for i, p in enumerate(pnls)],
        "truncated": False})


def test_returns_stats_and_cone():
    assert backtest.returns([100, -50, 1_000_000], 1000) == [0.1, -50 / 1100, 1_000_000 / 1050]
    s = backtest.stats({"pnl": [100, -50, 200], "initial_balance": 1000, "currency": "BRL"})
    assert (s["trades"], s["net"], s["win_rate"], s["profit_factor"]) == (3, 250, 66.7, 6.0)
    assert s["return_pct"] == 25.0 and s["max_drawdown_pct"] == pytest.approx(4.55, abs=0.01)
    assert [p["k"] for p in s["curve"]] == [1, 2, 3] and s["curve"][-1]["v"] == 25.0

    rng = random.Random(1)
    bt = [rng.gauss(0.002, 0.01) for _ in range(500)]  # About +0.2% a trade
    typical = backtest.cone(bt, [rng.choice(bt) for _ in range(60)], seed=3)
    assert typical["verdict"] == "inside" and typical["trades"] == 60 and len(typical["bands"]) == 60
    last = typical["bands"][-1]
    assert last["p5"] < last["p25"] < last["p50"] < last["p75"] < last["p95"]
    assert backtest.cone(bt, [-0.01] * 60, seed=3)["verdict"] == "below"
    assert backtest.cone(bt, [0.03] * 60, seed=3)["verdict"] == "above"
    assert backtest.cone(bt, [0.01] * 3) is None  # Too few live trades
    assert len(backtest.cone(bt, [0.001] * 1000, seed=3)["bands"]) <= backtest.CONE_POINTS + 1


def test_the_bridge_keeps_a_fresh_copy_of_the_backtest(client, monkeypatch):
    manager_id, mgr, portfolio_id, _ = published(client, title=f"Backtest {uuid.uuid4().hex[:6]}")
    monkeypatch.setattr(dash_bridge, "send", FakeDash())
    token = new_token()
    assert client.put(f"/portfolios/{portfolio_id}/dash", headers=mgr, json={"token": token}).status_code == 200
    calls = []

    def fetch(t):
        calls.append(t)
        return (200, dash_answer([100, -40, 60])) if t == token else (403, "{}")

    dash_bridge.run_once(post=FakeDash(), fetch=fetch)
    link = client.get(f"/portfolios/{portfolio_id}/dash", headers=mgr).json()["link"]
    assert link["backtest"] == {"name": "WIN Tendência", "trades": 3, "initial_balance": 10_000.0, "capital": None,
                                "currency": "BRL"}
    assert link["backtest_error"] is None
    dash_bridge.run_once(post=FakeDash(), fetch=fetch)
    assert calls.count(token) == 1  # Fresh: not again before BACKTEST_REFRESH_SECONDS

    later = datetime.datetime.utcnow() + datetime.timedelta(seconds=dash_bridge.BACKTEST_REFRESH_SECONDS + 60)
    dash_bridge.run_once(post=FakeDash(), fetch=lambda t: (500, '{"error": "x"}'), now=later)
    link = client.get(f"/portfolios/{portfolio_id}/dash", headers=mgr).json()["link"]
    assert link["backtest"]["trades"] == 3 and "500" in link["backtest_error"]  # The last copy stays

    monkeypatch.setattr(dash_bridge, "MIRROR_KEY", "")
    much_later = later + datetime.timedelta(seconds=dash_bridge.BACKTEST_REFRESH_SECONDS + 60)
    dash_bridge.run_once(post=FakeDash(), fetch=fetch, now=much_later)
    assert calls.count(token) == 1  # Without the shared key the Dash would refuse: not asked


def seed_live(manager_id, portfolio_id, results):
    """Closed Master positions with these results, one a day, and a balance of 10 000 before them."""
    db = database.SessionLocal()
    try:
        strategy = db.get(models.Portfolio, portfolio_id).strategies[0]
        login = uuid.uuid4().int % 10**9
        db.add(models.AccountSnapshot(kind="master", owner_id=manager_id, login=login, balance=10_000, equity=10_000,
                                      currency="BRL", hour=(NOW - datetime.timedelta(days=len(results) + 2))
                                      .replace(minute=0, second=0)))
        for i, result in enumerate(results):
            closed = NOW - datetime.timedelta(days=len(results) - i)
            db.add(models.MasterPosition(manager_id=manager_id, strategy_id=strategy.id, master_login=login, pos_id=i + 1,
                                         symbol="WIN", type=0, volume=1, price_open=1, closed_at=closed))
            db.add(models.PortfolioTrade(portfolio_id=portfolio_id, manager_id=manager_id, master_login=login, pos_id=i + 1,
                                         strategy_id=strategy.id))
            db.add(models.MasterDeal(manager_id=manager_id, master_login=login, deal_id=i * 2 + 1, pos_id=i + 1, entry=1,
                                     type=1, symbol="WIN", volume=1, price=1, profit=result, swap=0, commission=0,
                                     time=closed))
        db.commit()
    finally:
        db.close()


def test_the_listing_shows_the_backtest_only_when_asked(client, monkeypatch):
    manager_id, mgr, portfolio_id, listing = published(client, title=f"Cone {uuid.uuid4().hex[:6]}")
    rng = random.Random(5)
    bt_pnls = [round(rng.gauss(20, 100), 2) for _ in range(300)]  # About +0.2% of 10 000 a trade
    seed_live(manager_id, portfolio_id, [rng.choice(bt_pnls) for _ in range(30)])
    url = f"/api/marketplace/{listing['slug']}/backtest"

    marketplace.clear_cache()
    assert client.get(url).json() == {"available": False}  # No link yet, and the listing does not ask

    monkeypatch.setattr(dash_bridge, "send", FakeDash())
    token = new_token()
    client.put(f"/portfolios/{portfolio_id}/dash", headers=mgr, json={"token": token})
    dash_bridge.run_once(post=FakeDash(), fetch=lambda t: (200, dash_answer(bt_pnls)) if t == token else (403, "{}"))

    preview = client.get(f"/portfolios/{portfolio_id}/backtest", headers=mgr, params={"days": 90}).json()
    assert preview["available"] and preview["backtest"]["trades"] == 300 and preview["cone"]["trades"] == 30
    assert preview["cone"]["verdict"] == "inside" and preview["cone_missing"] is None
    marketplace.clear_cache()
    assert client.get(url).json() == {"available": False}  # The manager did not choose to show it

    assert client.put(f"/portfolios/{portfolio_id}/listing", headers=mgr,
                      json={**LISTING, "title": listing["title"], "show_backtest": True}).json()["show_backtest"]
    marketplace.clear_cache()
    shown = client.get(url, params={"days": 90}).json()
    assert shown["available"] and shown["backtest"]["return_pct"] is not None and shown["cone"]["verdict"] == "inside"


def test_without_capital_there_is_no_cone(client, monkeypatch):
    manager_id, mgr, portfolio_id, _ = published(client, title=f"Sem capital {uuid.uuid4().hex[:6]}")
    seed_live(manager_id, portfolio_id, [50.0] * 10)
    monkeypatch.setattr(dash_bridge, "send", FakeDash())
    token = new_token()
    client.put(f"/portfolios/{portfolio_id}/dash", headers=mgr, json={"token": token})
    dash_bridge.run_once(post=FakeDash(),
                         fetch=lambda t: (200, dash_answer([10.0] * 50, initial=0)) if t == token else (403, "{}"))
    view = client.get(f"/portfolios/{portfolio_id}/backtest", headers=mgr).json()
    assert view["available"] and view["cone"] is None and view["cone_missing"] == "capital"
    assert view["backtest"]["return_pct"] is None and view["backtest"]["net"] == 500.0


def test_the_dash_live_tracking_is_the_incubation():
    """The Dash portfolio's live tracking comes with the backtest and shows apart, over the same capital, with how
    much of it OnTick verified."""
    answer = json.loads(dash_answer([100.0, -50.0]))
    answer["live"] = {"trades": [{"t": "2026-06-01T10:00:00", "pnl": 200.0, "verified": True},
                                 {"t": "2026-07-01T10:00:00", "pnl": -100.0, "verified": False},
                                 {"t": "2026-08-01T10:00:00", "pnl": "x"}],  # Not a number: left out
                      "truncated": False}
    bt = dash_bridge.compact_backtest(json.dumps(answer))
    assert (bt["live_pnl"], bt["live_verified"], bt["live_from"]) == ([200.0, -100.0], 1, "2026-06-01T10:00:00")
    inc = backtest.incubation(bt)
    assert (inc["trades"], inc["net"], inc["verified"], inc["return_pct"], inc["currency"]) == (2, 100.0, 1, 1.0, "BRL")
    assert backtest.incubation(dash_bridge.compact_backtest(dash_answer([1.0]))) is None  # A Dash without it


def test_the_capital_is_the_monte_carlo_drawdown_plus_3_sigma():
    """The Dash's "DD Máx +3σ" is the capital the strategies run with: the percentages are over it, not over the
    balance declared on the Dash."""
    answer = json.loads(dash_answer([100.0, -50.0], initial=113_000.0))
    answer["capital"] = {"value": 2549.0, "basis": "monte_carlo_dd_3sigma", "method": "resampling", "simulations": 1000}
    bt = dash_bridge.compact_backtest(json.dumps(answer))
    assert (bt["capital"], bt["initial_balance"]) == (2549.0, 113_000.0)
    s = backtest.stats(bt)
    assert (s["initial_balance"], s["capital_basis"], s["return_pct"]) == (2549.0, "monte_carlo", round(50 / 2549 * 100, 2))
    plain = backtest.stats(dash_bridge.compact_backtest(dash_answer([100.0])))  # A Dash without a Monte Carlo
    assert (plain["initial_balance"], plain["capital_basis"]) == (10_000.0, "declared")
