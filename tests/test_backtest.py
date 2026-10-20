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

    def fetch(t, after=None):
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
    dash_bridge.run_once(post=FakeDash(), fetch=lambda t, after=None: (500, '{"error": "x"}'), now=later)
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
    dash_bridge.run_once(post=FakeDash(), fetch=lambda t, after=None: (200, dash_answer(bt_pnls)) if t == token else (403, "{}"))

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
                         fetch=lambda t, after=None: (200, dash_answer([10.0] * 50, initial=0)) if t == token else (403, "{}"))
    view = client.get(f"/portfolios/{portfolio_id}/backtest", headers=mgr).json()
    assert view["available"] and view["cone"] is None and view["cone_missing"] == "capital"
    assert view["backtest"]["return_pct"] is None and view["backtest"]["net"] == 500.0


def iso(at: datetime.datetime) -> str:
    return at.strftime("%Y-%m-%dT%H:%M:%S.%f+00:00")


def live_trade(dash_id, days_ago, pnl, recorded_days_ago=None, **extra):
    """A Dash live tracking trade closed days_ago, recorded as it closed unless told otherwise."""
    closed = NOW - datetime.timedelta(days=days_ago)
    recorded = NOW - datetime.timedelta(days=days_ago if recorded_days_ago is None else recorded_days_ago)
    return {"id": dash_id, "t": iso(closed), "created": iso(recorded + datetime.timedelta(seconds=1)), "pnl": pnl,
            "lots": 1, "strategy": "777", "account": None, "same_portfolio": True, "verified": False, **extra}


def with_live(trades, truncated=False):
    answer = json.loads(dash_answer([100.0] * 40))
    answer["live"] = {"trades": trades, "truncated": truncated}
    return json.dumps(answer)


def test_the_live_tracking_is_frozen_as_the_homologation(client, monkeypatch):
    """The Dash live tracking is taken once, from the origin account, and kept: the Dash sends only what it recorded
    after the portfolio's cursor, so what a strategy taken out had stays and one put in later brings nothing older."""
    manager_id, mgr, portfolio_id, _ = published(client, title=f"Homologação {uuid.uuid4().hex[:6]}")
    db = database.SessionLocal()
    db.get(models.Portfolio, portfolio_id).master_login = 555
    db.commit()
    db.close()
    monkeypatch.setattr(dash_bridge, "send", FakeDash())
    token = new_token()
    client.put(f"/portfolios/{portfolio_id}/dash", headers=mgr, json={"token": token})
    asked = []
    first = [live_trade("a1", 60, 200.0, account="555", verified=True),
             live_trade("a2", 50, -100.0),  # Before the Dash kept the account, from the portfolio's own token
             live_trade("a3", 45, 900.0, same_portfolio=False),  # Another Dash portfolio of the same strategy
             live_trade("a4", 44, 900.0, account="999"),  # Another account
             live_trade("a5", 43, "x")]  # Not a number
    answer = {"body": with_live(first)}

    def fetch(t, after=None):
        asked.append(after)
        return 200, answer["body"]

    dash_bridge.run_once(post=FakeDash(), fetch=fetch)
    db = database.SessionLocal()
    taken = db.query(models.IncubationTrade).filter_by(portfolio_id=portfolio_id).order_by(models.IncubationTrade.traded_at).all()
    assert [(t.dash_id, t.pnl, t.verified, t.account_login) for t in taken] == [("a1", 200.0, True, "555"),
                                                                             ("a2", -100.0, False, None)]
    assert asked == [None] and db.get(models.Portfolio, portfolio_id).incubation_cursor == first[4]["created"]
    db.close()

    later = datetime.datetime.utcnow() + datetime.timedelta(seconds=dash_bridge.BACKTEST_REFRESH_SECONDS + 60)
    answer["body"] = with_live([first[4],  # The cursor is inclusive: the Mirror drops what it has
                                live_trade("b1", 30, 50.0, recorded_days_ago=0),  # History sent afterwards
                                live_trade("b2", 20, 300.0, account="555")])
    dash_bridge.run_once(post=FakeDash(), fetch=fetch, now=later)
    assert asked[-1] == first[4]["created"]
    much_later = later + datetime.timedelta(seconds=dash_bridge.BACKTEST_REFRESH_SECONDS + 60)
    answer["body"] = with_live([])  # The strategies were taken out of the Dash portfolio
    dash_bridge.run_once(post=FakeDash(), fetch=fetch, now=much_later)

    performance = client.get(f"/portfolios/{portfolio_id}/performance", headers=mgr, params={"days": 365}).json()
    assert (performance["trades"], performance["net"], performance["lots"]) == (3, 400.0, 3)
    assert performance["homologation"]["trades"] == 3 and performance["homologation"]["copy_start"] is None
    assert performance["strategies"][0]["trades"] == 3  # The manager's strategy with the magic number 777
    view = client.get(f"/portfolios/{portfolio_id}/backtest", headers=mgr, params={"days": 365}).json()
    assert (view["incubation"]["trades"], view["incubation"]["verified"], view["incubation"]["official"]) == (3, 1, 3)

    # The copy starts: the homologation ends at its first trade, and the cone runs over both
    seed_live(manager_id, portfolio_id, [100.0] * 5)
    db = database.SessionLocal()
    db.query(models.PortfolioTrade).filter_by(portfolio_id=portfolio_id).update(
        {"sent_at": NOW - datetime.timedelta(days=25)})
    db.commit()
    db.close()
    performance = client.get(f"/portfolios/{portfolio_id}/performance", headers=mgr, params={"days": 365}).json()
    assert performance["homologation"]["trades"] == 2 and performance["trades"] == 7  # b2 came after the copy started
    view = client.get(f"/portfolios/{portfolio_id}/backtest", headers=mgr, params={"days": 365}).json()
    assert view["incubation"]["official"] == 2 and view["cone"]["trades"] == 7


def test_with_nothing_to_take_the_homologation_starts_now(client, monkeypatch):
    """A Dash portfolio without live tracking yet: what it records afterwards comes, a strategy's older trades
    never."""
    _, mgr, portfolio_id, _ = published(client, title=f"Sem incubação {uuid.uuid4().hex[:6]}")
    monkeypatch.setattr(dash_bridge, "send", FakeDash())
    token = new_token()
    client.put(f"/portfolios/{portfolio_id}/dash", headers=mgr, json={"token": token})
    now = datetime.datetime.utcnow()
    dash_bridge.run_once(post=FakeDash(), fetch=lambda t, after=None: (200, with_live([])), now=now)
    db = database.SessionLocal()
    try:
        cursor = db.get(models.Portfolio, portfolio_id).incubation_cursor
        assert dash_bridge._utc(cursor) == now.replace(microsecond=0)
        assert db.query(models.IncubationTrade).filter_by(portfolio_id=portfolio_id).count() == 0
    finally:
        db.close()
    # A Dash from before the live tracking sends none: nothing changes
    assert backtest.incubation(database.SessionLocal(), models.Portfolio(id=-1), {}) is None


def test_a_dash_from_before_the_cursor_does_not_start_it(client, monkeypatch):
    """Trades without ids or recording times come from a Dash not yet updated: nothing is taken and the cursor waits,
    so the history comes in full once the Dash is."""
    _, mgr, portfolio_id, _ = published(client, title=f"Dash antigo {uuid.uuid4().hex[:6]}")
    monkeypatch.setattr(dash_bridge, "send", FakeDash())
    token = new_token()
    client.put(f"/portfolios/{portfolio_id}/dash", headers=mgr, json={"token": token})
    old = with_live([{"t": iso(NOW - datetime.timedelta(days=10)), "pnl": 100.0, "verified": False}])
    dash_bridge.run_once(post=FakeDash(), fetch=lambda t, after=None: (200, old))
    db = database.SessionLocal()
    try:
        assert db.get(models.Portfolio, portfolio_id).incubation_cursor is None
        assert db.query(models.IncubationTrade).filter_by(portfolio_id=portfolio_id).count() == 0
    finally:
        db.close()


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
