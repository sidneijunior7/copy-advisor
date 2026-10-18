"""How the followers copied a portfolio, in points (followers.py), on the manager's page and in the marketplace."""
import datetime
import os
import uuid

import pytest

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402
import followers  # noqa: E402
import marketplace  # noqa: E402
import models  # noqa: E402
import server  # noqa: E402
from test_clients import client_headers, fresh_limits  # noqa: E402,F401
from test_management import make_manager  # noqa: E402
from test_marketplace import published  # noqa: E402

NOW = datetime.datetime.utcnow()
A, B, C, D = 7001, 7002, 7003, 7004  # Followers' MT5 accounts


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


def ago(hours):
    return NOW - datetime.timedelta(hours=hours)


def seed(portfolio_id):
    """Master 900: EURUSD bought 1.1000 -> 1.1100, BTCUSD sold 60000 -> 59000, a reversed position, one still open
    on a follower, and openings the followers could not make."""
    db = database.SessionLocal()
    try:
        portfolio = db.get(models.Portfolio, portfolio_id)
        manager_id, strategy = portfolio.user_id, portfolio.strategies[0]
        login = uuid.uuid4().int % 10**9
        positions = {1: ("EURUSD", 0, 1.1000, 1.1100), 2: ("BTCUSD", 1, 60000, 59000), 3: ("EURUSD", 0, 1.2, 1.3),
                     4: ("EURUSD", 0, 1.1, 1.2), 5: ("EURUSD", 0, 1.1, 1.2)}
        for pos_id, (symbol, side, price_in, price_out) in positions.items():
            db.add(models.MasterPosition(manager_id=manager_id, strategy_id=strategy.id, master_login=login, pos_id=pos_id,
                                         symbol=symbol, type=side, volume=1, price_open=price_in, closed_at=ago(1)))
            out_entry = 2 if pos_id == 3 else 1  # 3 was reversed (DEAL_ENTRY_INOUT)
            for n, (entry, price) in enumerate(((0, price_in), (out_entry, price_out))):
                db.add(models.MasterDeal(manager_id=manager_id, master_login=login, deal_id=pos_id * 10 + n, pos_id=pos_id,
                                         entry=entry, type=side if entry == 0 else 1 - side, symbol=symbol, volume=1,
                                         price=price, profit=0, swap=0, commission=0, time=ago(5 - n)))

        def ex(follower, pos_id, action, volume, price, retcode=10009, latency=None, hours=3):
            db.add(models.Execution(uid=f"{login}_{pos_id}", portfolio_id=portfolio_id, mt5_login=follower, action=action,
                                    volume=volume, price=price, retcode=retcode, latency_ms=latency, created_at=ago(hours)))
        ex(A, 1, "OPEN", 0.1, 1.1002, latency=200)
        ex(A, 1, "MODIFY", 0, 0)
        ex(A, 1, "CLOSE", 0.1, 1.1098, hours=2)
        ex(B, 1, "OPEN", 0.2, 1.1001, latency=300)
        ex(B, 1, "PARTIAL", 0.1, 1.1100, hours=2)
        ex(B, 1, "CLOSE_EXT", 0.1, 1.1090, hours=2)  # Its own SL
        ex(A, 2, "OPEN", 0.01, 59990, latency=400)
        ex(A, 2, "CLOSE", 0.01, 59010, hours=2)
        ex(A, 3, "OPEN", 0.1, 1.2)
        ex(A, 3, "REVERSE", 0.2, 1.25)
        ex(A, 3, "CLOSE", 0.1, 1.3, hours=2)
        ex(A, 4, "OPEN", 0.1, 1.1)  # Still open on the follower
        ex(C, 5, "OPEN", 0.1, 0, retcode=10019)  # No margin
        ex(D, 5, "OPEN", 0.1, 0, retcode=10034)  # The lot limit: not a failure to copy
        db.commit()
    finally:
        db.close()


def test_points_capture_costs_and_copy_rate(client):
    _, mgr, portfolio_id, _ = published(client, title=f"Seguidores {uuid.uuid4().hex[:6]}")
    seed(portfolio_id)
    r = client.get(f"/portfolios/{portfolio_id}/followers", headers=mgr, params={"days": 30})
    assert r.status_code == 200, r.text
    s = r.json()
    assert (s["followers"], s["copies"], s["latency_ms"]) == (2, 3, 300)
    assert s["copy_rate"] == 83.3  # 5 opened, 1 refused; the lot limit does not count
    eur, btc = s["symbols"]
    assert (eur["symbol"], eur["copies"], eur["capture"]) == ("EURUSD", 2, 95.0)
    assert eur["master_points"] == pytest.approx(0.01) and eur["follower_points"] == pytest.approx(0.0095)
    assert eur["entry_cost"] == pytest.approx(0.00015) and eur["exit_cost"] == pytest.approx(0.00035)
    assert (btc["symbol"], btc["capture"], btc["entry_cost"], btc["exit_cost"]) == ("BTCUSD", 98.0, 10, 10)  # A sale
    assert s["capture"] == 96.0  # (95 x 2 + 98) / 3

    _, other = make_manager()
    assert client.get(f"/portfolios/{portfolio_id}/followers", headers=other).status_code == 404
    cli, _ = client_headers(client)
    assert client.get(f"/portfolios/{portfolio_id}/followers", headers=cli).status_code == 403


def test_the_marketplace_waits_for_enough_followers(client, monkeypatch):
    _, _, portfolio_id, listing = published(client, title=f"Poucos {uuid.uuid4().hex[:6]}")
    seed(portfolio_id)
    marketplace.clear_cache()
    r = client.get(f"/api/marketplace/{listing['slug']}/followers")
    assert r.status_code == 200
    assert r.json() == {"enough": False, "min_followers": followers.MIN_FOLLOWERS, "min_copies": followers.MIN_COPIES}
    monkeypatch.setattr(followers, "MIN_FOLLOWERS", 2)
    monkeypatch.setattr(followers, "MIN_COPIES", 3)
    marketplace.clear_cache()
    s = client.get(f"/api/marketplace/{listing['slug']}/followers", params={"days": 60}).json()
    assert s["enough"] and s["capture"] == 96.0 and len(s["symbols"]) == 2
    assert client.get("/api/marketplace/nao-existe/followers").status_code == 404


def test_public_hides_the_figures_below_the_minimum():
    stats = {"followers": 0, "copies": 0}
    assert followers.public(stats)["enough"] is False and "copies" not in followers.public(stats)
