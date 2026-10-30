"""Deleting a portfolio: only when no client is left with it, and then all of it goes (deletion.py)."""
import datetime
import os
import uuid

import pytest

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
import server  # noqa: E402
from test_clients import client_headers, fresh_limits  # noqa: E402,F401
from test_management import make_manager  # noqa: E402
from test_marketplace import published  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


def deletion(client, mgr, portfolio_id):
    return client.get(f"/portfolios/{portfolio_id}/deletion", headers=mgr).json()


def count(model, **where):
    db = database.SessionLocal()
    try:
        return db.query(model).filter_by(**where).count()
    finally:
        db.close()


def test_a_portfolio_goes_only_once_no_client_is_left(client):
    manager_id, mgr, portfolio_id, listing = published(client, title=f"Excluir {uuid.uuid4().hex[:6]}")
    strategy_ids = [s["id"] for p in client.get("/portfolios", headers=mgr).json() if p["id"] == portfolio_id
                    for s in p["strategies"]]
    assert client.post(f"/portfolios/{portfolio_id}/listing/promos", headers=mgr,
                       json={"code": "SAIR", "free_days": 30}).status_code == 200
    cli, _ = client_headers(client)
    lic = client.post(f"/api/marketplace/{listing['slug']}/redeem", headers=cli, json={"code": "SAIR"}).json()
    waiting, _ = client_headers(client)
    request = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=waiting, json={}).json()

    _, intruder = make_manager()
    assert client.get(f"/portfolios/{portfolio_id}/deletion", headers=intruder).status_code == 404
    assert client.delete(f"/portfolios/{portfolio_id}", headers=intruder).status_code == 404
    check = deletion(client, mgr, portfolio_id)
    assert len(check["blockers"]) == 2 and "licença válida" in check["blockers"][0] and "pedido" in check["blockers"][1]
    assert check["removes"] == {"licenses": 1, "track_record": 0, "homologation": 0, "listing": True,
                                     "requests": 2, "codes": 1, "dash": False}
    r = client.delete(f"/portfolios/{portfolio_id}", headers=mgr)
    assert r.status_code == 409 and r.json()["detail"].startswith("Ainda não dá para excluir")

    # The client's license is revoked, the request refused: nobody is left
    assert client.patch(f"/licenses/{lic['id']}", headers=mgr, json={"is_active": False}).status_code == 200
    assert client.post(f"/subscriptions/{request['id']}/reject", headers=mgr, json={}).status_code == 200
    assert deletion(client, mgr, portfolio_id)["blockers"] == []
    assert client.delete(f"/portfolios/{portfolio_id}", headers=mgr).status_code == 200

    assert portfolio_id not in [p["id"] for p in client.get("/portfolios", headers=mgr).json()]
    assert client.get(f"/api/marketplace/{listing['slug']}").status_code == 404
    assert client.get("/me/licenses", headers=cli).json()["licenses"] == []
    assert count(models.Listing, portfolio_id=portfolio_id) == 0 and count(models.License, portfolio_id=portfolio_id) == 0
    assert count(models.PromoRedemption, portfolio_id=portfolio_id) == 0 and count(models.Subscription, id=request["id"]) == 0
    assert all(count(models.Strategy, id=sid) == 1 for sid in strategy_ids)  # The manager's strategies stay
    assert client.get(f"/portfolios/{portfolio_id}/deletion", headers=mgr).status_code == 404


def test_stripe_renewing_and_open_copies_block_it(client):
    manager_id, mgr, portfolio_id, listing = published(client, title=f"Bloqueio {uuid.uuid4().hex[:6]}")
    now = datetime.datetime.utcnow()
    login = uuid.uuid4().int % 10**8
    db = database.SessionLocal()
    try:
        expired = models.License(portfolio_id=portfolio_id, client_mt5_login=login, max_lots=1, is_active=True,
                                 expires_at=now - datetime.timedelta(days=1))
        db.add(expired)
        db.flush()
        user = db.query(models.User).filter_by(id=manager_id).one()
        sub = models.Subscription(listing_id=listing["id"], client_user_id=user.id, status="approved", kind="new",
                                  license_id=expired.id, stripe_subscription_id=f"sub_{uuid.uuid4().hex[:8]}",
                                  stripe_status="past_due", created_at=now)
        db.add(sub)
        # Opened while the license was valid, not closed yet: the Slave still follows the Master to close it
        db.add(models.Execution(uid="1_7", portfolio_id=portfolio_id, mt5_login=login, action="OPEN", volume=1,
                                price=100.0, retcode=10009, created_at=now - datetime.timedelta(days=2)))
        db.commit()
        sub_id = sub.id
    finally:
        db.close()
    blockers = deletion(client, mgr, portfolio_id)["blockers"]
    assert len(blockers) == 2 and "Stripe" in blockers[0] and "cópia ainda aberta" in blockers[1]

    db = database.SessionLocal()
    try:
        db.get(models.Subscription, sub_id).stripe_status = "canceled"
        db.add(models.Execution(uid="1_7", portfolio_id=portfolio_id, mt5_login=login, action="CLOSE", volume=1,
                                price=101.0, retcode=10009, created_at=now - datetime.timedelta(hours=1)))
        db.commit()
    finally:
        db.close()
    assert deletion(client, mgr, portfolio_id)["blockers"] == []
    assert client.delete(f"/portfolios/{portfolio_id}", headers=mgr).status_code == 200
    assert count(models.Execution, portfolio_id=portfolio_id) == 0 and count(models.Subscription, id=sub_id) == 0
