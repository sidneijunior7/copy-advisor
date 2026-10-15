"""Managers editing licenses (limit, revoke, reactivate) and portfolio composition."""
import datetime
import os
import uuid

import pytest

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import hub  # noqa: E402
import keys  # noqa: E402
import models  # noqa: E402
import server  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


@pytest.fixture(autouse=True)
def fresh_limiter():
    # Revoked licenses fail the license check, which counts towards the per-IP rate limit
    server.failure_limiter.reset()
    yield
    server.failure_limiter.reset()


def make_manager(role="MANAGER"):
    db = database.SessionLocal()
    try:
        user = models.User(email=f"{uuid.uuid4().hex}@x.com", role=role, status="active", password_hash="x")
        db.add(user)
        db.commit()
        token = auth.create_access_token({"sub": user.email, "role": role})
        return user.id, {"Authorization": f"Bearer {token}"}
    finally:
        db.close()


def make_portfolio(manager_id, with_strategy=False):
    db = database.SessionLocal()
    try:
        portfolio = models.Portfolio(user_id=manager_id, name="P")
        db.add(portfolio)
        strategy = None
        if with_strategy:
            strategy = models.Strategy(user_id=manager_id, name="Scalper", magic_number=uuid.uuid4().int % 10**9)
            portfolio.strategies.append(strategy)
        db.commit()
        return portfolio.id, portfolio.public_key, strategy.id if strategy else None
    finally:
        db.close()


def open_position(manager_id, strategy_id):
    db = database.SessionLocal()
    try:
        now = datetime.datetime.utcnow()
        position = models.MasterPosition(manager_id=manager_id, strategy_id=strategy_id, master_login=1,
                                         pos_id=uuid.uuid4().int % 10**9, symbol="EURUSD", type=0, volume=1.0,
                                         price_open=1.1, sl=0, tp=0, opened_at=now, updated_at=now)
        db.add(position)
        db.commit()
        return position.id
    finally:
        db.close()


def close_position(position_id):
    db = database.SessionLocal()
    try:
        db.get(models.MasterPosition, position_id).closed_at = datetime.datetime.utcnow()
        db.commit()
    finally:
        db.close()


def create_license(client, headers, portfolio_id, login, max_lots=1.0):
    return client.post("/licenses", headers=headers,
                       json={"portfolio_id": portfolio_id, "client_mt5_login": login, "max_lots": max_lots})


def check(client, key, login):
    return client.post("/api/license/check", json={"connection_key": key, "mt5_login": login})


def load_directory():
    db = database.SessionLocal()
    try:
        return hub.load_directory(db)
    finally:
        db.close()


# --- Licenses ---

def test_license_key_is_shown_once_and_a_new_one_replaces_it(client):
    manager_id, headers = make_manager()
    portfolio_id, _, _ = make_portfolio(manager_id)
    created = create_license(client, headers, portfolio_id, 2001).json()
    key = created["license_key"]
    assert key.startswith("lic_") and created["key_prefix"] == key[:12] and created["has_key"] is True

    listed = client.get("/licenses", headers=headers).json()
    assert [(l["id"], l["key_prefix"]) for l in listed] == [(created["id"], key[:12])]
    assert all("license_key" not in l and "key_hash" not in l for l in listed)
    lic = load_directory().licenses_by_hash[keys.key_hash(key)]
    assert (lic.id, lic.portfolio_id, lic.login, lic.max_lots) == (created["id"], portfolio_id, 2001, 1.0)

    renewed = client.post(f"/licenses/{created['id']}/key", headers=headers).json()
    assert renewed["license_key"] != key
    directory = load_directory()
    assert keys.key_hash(key) not in directory.licenses_by_hash
    assert directory.licenses_by_hash[keys.key_hash(renewed["license_key"])].id == created["id"]

    _, intruder = make_manager()
    assert client.post(f"/licenses/{created['id']}/key", headers=intruder).status_code == 404


def test_revocation_time_and_expiry_are_recorded(client):
    manager_id, headers = make_manager()
    portfolio_id, key, _ = make_portfolio(manager_id)
    license_id = create_license(client, headers, portfolio_id, 2002).json()["id"]

    revoked = client.patch(f"/licenses/{license_id}", headers=headers, json={"is_active": False}).json()
    assert revoked["revoked_at"] is not None
    assert client.patch(f"/licenses/{license_id}", headers=headers, json={"is_active": False}).json()["revoked_at"] == revoked["revoked_at"]
    assert client.patch(f"/licenses/{license_id}", headers=headers, json={"is_active": True}).json()["revoked_at"] is None

    expired = client.patch(f"/licenses/{license_id}", headers=headers, json={"expires_at": "2020-01-01T03:00:00-03:00"}).json()
    assert expired["expires_at"].startswith("2020-01-01T06:00:00")  # Stored in UTC
    assert check(client, key, 2002).status_code == 403              # The legacy check honours the expiry too
    assert client.patch(f"/licenses/{license_id}", headers=headers, json={"max_lots": 2}).json()["expires_at"] is not None
    assert client.patch(f"/licenses/{license_id}", headers=headers, json={"expires_at": None}).json()["expires_at"] is None
    assert check(client, key, 2002).status_code == 200


def test_connections_show_only_the_managers_own_sessions(client, monkeypatch):
    manager_id, headers = make_manager()
    portfolio_id, _, _ = make_portfolio(manager_id)
    other_id, _ = make_manager()
    other_portfolio, _, _ = make_portfolio(other_id)
    assert client.get("/me/connections", headers=headers).json() == {"available": False, "masters": [], "slaves": []}

    monkeypatch.setattr(server, "fetch_hub_sessions", lambda: [
        {"kind": "slave", "portfolio_id": portfolio_id, "license_id": 1, "login": 1},
        {"kind": "slave", "portfolio_id": other_portfolio, "license_id": 2, "login": 2},
        {"kind": "master", "manager_id": manager_id, "key_id": 9, "login": 900},
        {"kind": "master", "manager_id": other_id, "key_id": 8, "login": 901},
    ])
    body = client.get("/me/connections", headers=headers).json()
    assert body["available"] is True
    assert [s["login"] for s in body["slaves"]] == [1] and body["slaves"][0]["portfolio_name"] == "P"
    assert [m["login"] for m in body["masters"]] == [900]

def test_manager_edits_the_lot_limit_and_the_ea_receives_it(client):
    manager_id, headers = make_manager()
    portfolio_id, key, _ = make_portfolio(manager_id)
    license_id = create_license(client, headers, portfolio_id, 1001).json()["id"]

    r = client.patch(f"/licenses/{license_id}", headers=headers, json={"max_lots": 0.5})
    assert r.status_code == 200 and r.json()["max_lots"] == 0.5 and r.json()["is_active"] is True
    assert check(client, key, 1001).json()["max_lots"] == 0.5


def test_revoked_license_fails_the_check_until_reactivated(client):
    manager_id, headers = make_manager()
    portfolio_id, key, _ = make_portfolio(manager_id)
    license_id = create_license(client, headers, portfolio_id, 1002).json()["id"]

    assert client.patch(f"/licenses/{license_id}", headers=headers, json={"is_active": False}).json()["is_active"] is False
    assert check(client, key, 1002).status_code == 403

    r = client.patch(f"/licenses/{license_id}", headers=headers, json={"is_active": True})
    assert r.json()["is_active"] is True and r.json()["max_lots"] == 1.0  # Fields left out are kept
    assert check(client, key, 1002).status_code == 200


def test_license_of_another_manager_is_not_found(client):
    owner_id, owner_headers = make_manager()
    portfolio_id, _, _ = make_portfolio(owner_id)
    license_id = create_license(client, owner_headers, portfolio_id, 1003).json()["id"]

    _, intruder_headers = make_manager()
    assert client.patch(f"/licenses/{license_id}", headers=intruder_headers, json={"is_active": False}).status_code == 404
    assert client.patch("/licenses/999999", headers=owner_headers, json={"is_active": False}).status_code == 404
    _, dev_headers = make_manager(role="TDM_DEV")
    assert client.patch(f"/licenses/{license_id}", headers=dev_headers, json={"is_active": False}).status_code == 403


@pytest.mark.parametrize("max_lots", [0, -1])
def test_lot_limit_must_be_positive(client, max_lots):
    manager_id, headers = make_manager()
    portfolio_id, _, _ = make_portfolio(manager_id)
    assert create_license(client, headers, portfolio_id, 1004, max_lots=max_lots).status_code == 422
    license_id = create_license(client, headers, portfolio_id, 1004).json()["id"]
    assert client.patch(f"/licenses/{license_id}", headers=headers, json={"max_lots": max_lots}).status_code == 422


def test_same_account_cannot_be_licensed_twice_in_a_portfolio(client):
    manager_id, headers = make_manager()
    portfolio_id, _, _ = make_portfolio(manager_id)
    license_id = create_license(client, headers, portfolio_id, 1005).json()["id"]

    r = create_license(client, headers, portfolio_id, 1005)
    assert r.status_code == 409 and "ativa" in r.json()["detail"]
    client.patch(f"/licenses/{license_id}", headers=headers, json={"is_active": False})
    assert "revogada" in create_license(client, headers, portfolio_id, 1005).json()["detail"]

    other_portfolio_id, _, _ = make_portfolio(manager_id)
    assert create_license(client, headers, other_portfolio_id, 1005).status_code == 200


# --- Portfolio composition ---

def test_strategy_cannot_be_linked_twice(client):
    manager_id, headers = make_manager()
    portfolio_id, _, strategy_id = make_portfolio(manager_id, with_strategy=True)
    assert client.post(f"/portfolios/{portfolio_id}/add_strategy/{strategy_id}", headers=headers).status_code == 409


def test_strategy_with_open_positions_stays_in_the_portfolio(client):
    manager_id, headers = make_manager()
    portfolio_id, _, strategy_id = make_portfolio(manager_id, with_strategy=True)
    position_id = open_position(manager_id, strategy_id)
    url = f"/portfolios/{portfolio_id}/strategies/{strategy_id}"

    r = client.delete(url, headers=headers)
    assert r.status_code == 409 and "1 posição aberta" in r.json()["detail"]

    close_position(position_id)
    assert client.delete(url, headers=headers).status_code == 200
    strategies = next(p for p in client.get("/portfolios", headers=headers).json() if p["id"] == portfolio_id)["strategies"]
    assert strategies == []
    assert client.delete(url, headers=headers).status_code == 404  # No longer linked


def test_strategy_of_another_managers_portfolio_is_not_found(client):
    owner_id, _ = make_manager()
    portfolio_id, _, strategy_id = make_portfolio(owner_id, with_strategy=True)
    _, intruder_headers = make_manager()
    assert client.delete(f"/portfolios/{portfolio_id}/strategies/{strategy_id}", headers=intruder_headers).status_code == 404
