"""Privacy (privacy.py): the proof of what was accepted, the access records, the holder's export, closing an account
and the deadlines the Privacy Policy gives each kind of data."""
import datetime
import json
import os
import uuid

import pytest

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402
import mailer  # noqa: E402
import models  # noqa: E402
import privacy  # noqa: E402
import server  # noqa: E402
from test_clients import client_headers, fresh_limits  # noqa: E402,F401
from test_management import make_manager, make_portfolio  # noqa: E402
from test_marketplace import published  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


@pytest.fixture
def outbox(monkeypatch):
    sent = []
    monkeypatch.setattr(mailer, "enabled", lambda: True)
    monkeypatch.setattr(mailer, "send", lambda to, subject, body: sent.append((to, subject, body)))
    return sent


def user_of(email):
    with database.SessionLocal() as db:
        return db.query(models.User).filter(models.User.email == email).one()


def give_license(email, mt5_login=None, hosted=False):
    """A license of a fresh portfolio linked to the client, as after an approved purchase."""
    manager_id, _ = make_manager()
    portfolio_id, _ = make_portfolio(manager_id, with_strategy=True)
    with database.SessionLocal() as db:
        user = db.query(models.User).filter(models.User.email == email).one()
        lic = models.License(portfolio_id=portfolio_id, client_mt5_login=mt5_login or uuid.uuid4().int % 10**8,
                             max_lots=1.0, is_active=True, client_user_id=user.id)
        db.add(lic)
        db.flush()
        if hosted:
            db.add(models.HostedTerminal(license_id=lic.id, server="Corretora-Demo", password_enc="cifrada",
                                         license_key_enc="cifrada"))
        db.commit()
        return lic.id, lic.client_mt5_login


def test_sign_up_keeps_the_version_and_the_origin_of_what_was_accepted(client):
    email = f"{uuid.uuid4().hex[:10]}@cliente.com"
    body = {"email": email, "password": "s3nha-forte", "terms_accepted": True}
    assert client.post("/register", json={**body, "terms_version": "versão 1"}).status_code == 422
    assert client.post("/register", json={**body, "terms_version": "1.0"}).status_code == 200
    user = user_of(email)
    assert user.terms_version == "1.0" and user.terms_ip and user.terms_accepted_at is not None
    # Without the version, the one the server knows as current
    other = f"{uuid.uuid4().hex[:10]}@cliente.com"
    assert client.post("/register", json={**body, "email": other}).status_code == 200
    assert user_of(other).terms_version == privacy.TERMS_VERSION


def test_using_the_account_leaves_an_access_record_kept_for_six_months(client):
    cli, email = client_headers(client)
    assert client.post("/token", data={"username": email, "password": "s3nha-forte"}).status_code == 200
    assert client.post("/token", data={"username": email, "password": "errada"}).status_code == 401  # Not an access
    assert client.post("/token/refresh", headers=cli).status_code == 200
    user = user_of(email)
    with database.SessionLocal() as db:
        rows = db.query(models.AccessLog).filter(models.AccessLog.user_id == user.id).order_by(models.AccessLog.id).all()
        assert [r.event for r in rows] == ["signup", "login", "refresh"] and all(r.ip for r in rows)
        seen = rows[0].created_at
    assert server.purge_expired_data(seen + datetime.timedelta(days=183))["access_records"] == 0  # Six months: kept
    server.purge_expired_data(seen + datetime.timedelta(days=privacy.ACCESS_LOG_DAYS + 1))
    with database.SessionLocal() as db:
        assert db.query(models.AccessLog).filter(models.AccessLog.user_id == user.id).count() == 0


def test_the_holder_downloads_everything_and_no_secret(client):
    cli, email = client_headers(client)
    _, _, _, listing = published(client, title=f"Exporta {uuid.uuid4().hex[:6]}")
    client.post(f"/api/marketplace/{listing['slug']}/lead", json={"email": email, "lots": 2})
    client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"risk_ack": True})
    license_id, login = give_license(email, hosted=True)
    with database.SessionLocal() as db:
        db.add(models.Execution(uid="1_1", mt5_login=login, action="OPEN", volume=1.0, price=10.0, retcode=10009))
        db.add(models.AccountSnapshot(kind="slave", owner_id=license_id, login=login, balance=5000.0, equity=5100.0,
                                      currency="BRL", hour=datetime.datetime(2026, 11, 1, 10)))
        db.commit()
    r = client.get("/me/export", headers=cli)
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    data = r.json()
    assert data["account"]["email"] == email and data["account"]["terms_version"] == privacy.TERMS_VERSION
    assert [l["mt5_login"] for l in data["licenses"]] == [login]
    assert data["hosted_accounts"] == [{"license_id": license_id, "server": "Corretora-Demo", "enabled": True,
                                        "status": "pending", "created_at": data["hosted_accounts"][0]["created_at"]}]
    assert data["subscriptions"][0]["risk_ack_at"] and data["checkout_simulations"][0]["lots"] == 2
    assert data["copies"][0]["price"] == 10.0 and data["balance_records"][0]["equity"] == 5100.0
    assert [a["event"] for a in data["access_records"]] == ["signup"]
    text = r.text
    assert "cifrada" not in text and "password" not in text and "key" not in text  # Never a credential
    assert client.get("/me/export").status_code == 401

    # Only the holder's own: another client's export has none of it
    other, _ = client_headers(client)
    assert str(login) not in client.get("/me/export", headers=other).text


def test_exports_are_limited_per_day(client, monkeypatch):
    cli, _ = client_headers(client)
    monkeypatch.setattr(server, "export_limiter", server.FailureLimiter(1, 86400))
    assert client.get("/me/export", headers=cli).status_code == 200
    assert client.get("/me/export", headers=cli).status_code == 429


def test_asking_to_close_the_account_tells_the_privacy_channel_once(client, outbox):
    cli, email = client_headers(client)
    assert client.get("/me", headers=cli).json()["closure_requested_at"] is None
    r = client.post("/me/closure-request", headers=cli)
    assert r.status_code == 200 and r.json()["days"] == 15 and r.json()["closure_requested_at"]
    asked = [m for m in outbox if "encerramento" in m[1]]
    assert sorted(m[0] for m in asked) == sorted([mailer.privacy_address(), email])
    assert client.post("/me/closure-request", headers=cli).json() == r.json()  # Again: the same request, no email
    assert len([m for m in outbox if "encerramento" in m[1]]) == 2
    assert client.get("/me", headers=cli).json()["closure_requested_at"] == r.json()["closure_requested_at"]

    _, admin = make_manager(role="TDM_DEV")
    waiting = client.get("/admin/closure-requests", headers=admin).json()
    mine = next(w for w in waiting if w["email"] == email)
    assert mine["blockers"] == [] and mine["due_at"] > mine["requested_at"]
    assert client.get("/admin/closure-requests", headers=cli).status_code == 403

    assert client.delete("/me/closure-request", headers=cli).json() == {"closure_requested_at": None}
    assert all(w["email"] != email for w in client.get("/admin/closure-requests", headers=admin).json())


def test_closing_an_account_ends_access_and_credentials_and_keeps_the_legal_record_apart(client, outbox):
    cli, email = client_headers(client, name="Cliente Que Sai")
    _, admin = make_manager(role="TDM_DEV")
    _, _, _, listing = published(client, title=f"Encerra {uuid.uuid4().hex[:6]}")
    pending = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"risk_ack": True}).json()
    license_id, login = give_license(email, hosted=True)
    user_id = user_of(email).id
    with database.SessionLocal() as db:
        portfolio_id = db.get(models.License, license_id).portfolio_id
        db.add(models.Execution(uid="9_9", portfolio_id=portfolio_id, mt5_login=login, action="OPEN", volume=1.0,
                                price=10.0, retcode=10009))
        db.add(models.AccountSnapshot(kind="slave", owner_id=license_id, login=login, balance=1.0, equity=1.0,
                                      currency="BRL", hour=datetime.datetime(2026, 11, 1, 10)))
        db.commit()
    client.post("/me/closure-request", headers=cli)

    assert client.post(f"/admin/users/{user_id}/close", headers=cli).status_code == 403
    assert client.post("/admin/users/999999/close", headers=admin).status_code == 404
    manager_id, _ = make_manager()
    r = client.post(f"/admin/users/{manager_id}/close", headers=admin)
    assert r.status_code == 409 and "trader" in r.json()["detail"]

    # A subscription Stripe still renews is settled by a person first
    with database.SessionLocal() as db:
        paid = models.Subscription(listing_id=listing["id"], client_user_id=user_id, status="approved",
                                   stripe_subscription_id="sub_viva", stripe_status="active")
        db.add(paid)
        db.commit()
        paid_id = paid.id
    r = client.post(f"/admin/users/{user_id}/close", headers=admin)
    assert r.status_code == 409 and "Stripe" in r.json()["detail"]
    assert client.get("/me", headers=cli).status_code == 200  # Nothing was done
    with database.SessionLocal() as db:
        db.get(models.Subscription, paid_id).stripe_status = "canceled"
        db.commit()

    r = client.post(f"/admin/users/{user_id}/close", headers=admin)
    assert r.status_code == 200 and r.json()["removed"]["hosted_accounts"] == 1, r.text
    assert client.get("/me", headers=cli).status_code in (401, 403)  # The open session is over
    assert client.post("/token", data={"username": email, "password": "s3nha-forte"}).status_code == 401
    with database.SessionLocal() as db:
        user = db.get(models.User, user_id)
        assert user.status == "archived" and user.password_hash is None and user.cpf is None and user.name is None
        assert user.email != email and json.loads(user.closed_identity)["email"] == email
        lic = db.get(models.License, license_id)
        assert lic.is_active is False and lic.revoked_at is not None and lic.client_mt5_login == login  # The record stays
        assert db.query(models.HostedTerminal).filter(models.HostedTerminal.license_id == license_id).count() == 0
        assert db.get(models.Subscription, pending["id"]).status == "cancelled"
        closed_at = user.closed_at
    assert [m for m in outbox if m[0] == email and "encerrada" in m[1]]
    assert client.post(f"/admin/users/{user_id}/close", headers=admin).status_code == 409  # Once
    assert all(w["id"] != user_id for w in client.get("/admin/closure-requests", headers=admin).json())

    # The address is free for a new account, and the old identity goes after the legal period
    assert client.post("/register", json={"email": email, "password": "s3nha-forte", "terms_accepted": True}).status_code == 200
    assert server.purge_expired_data(closed_at + privacy.KEEP_CLOSED - datetime.timedelta(days=1))["closed_accounts"] == 0
    assert server.purge_expired_data(closed_at + privacy.KEEP_CLOSED + datetime.timedelta(days=1))["closed_accounts"] == 1
    with database.SessionLocal() as db:
        assert db.get(models.User, user_id).closed_identity is None
        # Nor the account number, nor what was recorded under it
        assert db.get(models.License, license_id).client_mt5_login is None
        assert db.query(models.Execution).filter(models.Execution.mt5_login == login).count() == 0
        assert db.query(models.AccountSnapshot).filter(models.AccountSnapshot.owner_id == license_id).count() == 0


def test_a_checkout_lead_is_deleted_after_thirty_days(client):
    _, _, _, listing = published(client, title=f"Prazo {uuid.uuid4().hex[:6]}")
    email = f"{uuid.uuid4().hex[:10]}@visitante.com"
    client.post(f"/api/marketplace/{listing['slug']}/lead", json={"email": email})
    with database.SessionLocal() as db:
        seen = db.query(models.CheckoutLead).filter(models.CheckoutLead.email == email).one().updated_at
    server.purge_expired_data(seen + datetime.timedelta(days=privacy.LEAD_DAYS - 1))
    with database.SessionLocal() as db:
        assert db.query(models.CheckoutLead).filter(models.CheckoutLead.email == email).count() == 1
    server.purge_expired_data(seen + datetime.timedelta(days=privacy.LEAD_DAYS + 1))
    with database.SessionLocal() as db:
        assert db.query(models.CheckoutLead).filter(models.CheckoutLead.email == email).count() == 0
