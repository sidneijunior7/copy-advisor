"""Performance of a portfolio (Master deals) and of a client's copies (Slave profit) (performance.py)."""
import datetime
import os
import uuid

import pytest

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
import performance  # noqa: E402
import server  # noqa: E402
from test_clients import claimed_license, fresh_limits  # noqa: E402,F401
from test_management import make_manager  # noqa: E402

NOW = datetime.datetime.utcnow()


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


def ago(days=0, hours=0):
    return NOW - datetime.timedelta(days=days, hours=hours)


def test_stats():
    s = performance.stats([(ago(3), 100.0), (ago(2), -40.0), (ago(1), -30.0), (ago(0, 1), 50.0)],
                          start_balance=1000.0, currency="USD")
    assert (s["trades"], s["wins"], s["losses"], s["win_rate"]) == (4, 2, 2, 50.0)
    assert (s["net"], s["gross_profit"], s["gross_loss"], s["profit_factor"]) == (80.0, 150.0, 70.0, 2.14)
    assert (s["max_drawdown"], s["max_drawdown_pct"], s["return_pct"]) == (70.0, 7.0, 8.0)
    assert [p["v"] for p in s["curve"]] == [100.0, 60.0, 30.0, 80.0]
    assert sum(m["net"] for m in s["months"]) == 80.0
    empty = performance.stats([])
    assert empty["trades"] == 0 and empty["win_rate"] is None and empty["return_pct"] is None


def seed_portfolio(client):
    """A claimed license on a portfolio whose strategy closed two positions on the Master, one of them long ago."""
    manager_id, mgr, portfolio_id, lic, cli, _ = claimed_license(client)
    db = database.SessionLocal()
    try:
        strategy = models.Strategy(user_id=manager_id, name="Trend", magic_number=uuid.uuid4().int % 10**9)
        db.add(strategy)
        db.flush()
        portfolio = db.get(models.Portfolio, portfolio_id)
        portfolio.strategies.append(strategy)
        for pos_id, closed_at in ((1, ago(2)), (2, ago(1)), (3, None), (4, ago(400))):
            db.add(models.MasterPosition(manager_id=manager_id, strategy_id=strategy.id, master_login=900, pos_id=pos_id,
                                         symbol="EURUSD", type=0, volume=1, price_open=1.1, closed_at=closed_at))

        def deal(deal_id, pos_id, entry, profit, commission, at):
            db.add(models.MasterDeal(manager_id=manager_id, master_login=900, deal_id=deal_id, pos_id=pos_id, entry=entry,
                                     type=0, volume=1, price=1.1, profit=profit, swap=0, commission=commission, time=at))
        deal(10, 1, 0, 0, -2, ago(3))
        deal(11, 1, 1, 50, -2, ago(2))
        deal(20, 2, 0, 0, -2, ago(2))
        deal(21, 2, 1, -20, -2, ago(1))
        deal(30, 3, 0, 0, -2, ago(1))  # Still open
        deal(40, 4, 1, 999, 0, ago(400))  # Outside the period
        db.add(models.AccountSnapshot(kind="master", owner_id=manager_id, login=900,
                                      hour=ago(5).replace(minute=0, second=0, microsecond=0),
                                      balance=2000, equity=2000, currency="USD"))
        db.commit()
    finally:
        db.close()
    return manager_id, mgr, portfolio_id, lic, cli


def test_portfolio_performance_from_master_deals(client):
    _, mgr, portfolio_id, _, _ = seed_portfolio(client)
    r = client.get(f"/portfolios/{portfolio_id}/performance", headers=mgr, params={"days": 30})
    assert r.status_code == 200
    p = r.json()
    assert (p["trades"], p["net"], p["currency"], p["start_balance"]) == (2, 22.0, "USD", 2000)  # 46 - 24
    assert p["return_pct"] == 1.1 and p["strategies"][0]["name"] == "Trend"
    _, other = make_manager()
    assert client.get(f"/portfolios/{portfolio_id}/performance", headers=other).status_code == 404


def test_client_sees_its_result_and_the_portfolio(client):
    _, _, portfolio_id, lic, cli = seed_portfolio(client)
    db = database.SessionLocal()
    try:
        def ex(uid, action, profit, at):
            db.add(models.Execution(uid=uid, portfolio_id=portfolio_id, mt5_login=lic["client_mt5_login"], action=action,
                                    volume=0.1, price=1.1, retcode=10009, profit=profit, created_at=at))
        ex("900_1", "OPEN", -0.2, ago(3))
        ex("900_1", "CLOSE", 5.0, ago(2))
        ex("900_2", "OPEN", -0.2, ago(2))
        ex("900_2", "CLOSE_EXT", -2.0, ago(1))  # Its SL, hit only on the client
        for h in (30, 20, 10):
            db.add(models.AccountSnapshot(kind="slave", owner_id=lic["id"], login=lic["client_mt5_login"],
                                          hour=ago(0, h).replace(minute=0, second=0, microsecond=0),
                                          balance=500 + h, equity=495 + h, currency="BRL"))
        db.commit()
    finally:
        db.close()
    r = client.get(f"/me/licenses/{lic['id']}/performance", headers=cli, params={"days": 30})
    assert r.status_code == 200
    mine, portfolio = r.json()["copies"], r.json()["portfolio"]
    assert (mine["trades"], mine["net"], mine["wins"], mine["currency"]) == (2, 2.6, 1, "BRL")
    assert [e["balance"] for e in mine["equity"]] == [530, 520, 510]
    assert portfolio["trades"] == 2
    copies = {c["uid"]: c for c in client.get(f"/me/licenses/{lic['id']}/copies", headers=cli).json()}
    assert copies["900_2"]["status"] == "closed" and copies["900_2"]["profit"] == -2.2
