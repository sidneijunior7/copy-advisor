"""The checkout's trust and recovery: the terms at sign-up, the risk before subscribing, another broker by name, and
the emails to a visitor who stopped halfway (leads.py)."""
import datetime
import os
import uuid

import pytest

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402
import leads  # noqa: E402
import mailer  # noqa: E402
import models  # noqa: E402
import server  # noqa: E402
from test_clients import client_headers, fresh_limits  # noqa: E402,F401
from test_marketplace import published  # noqa: E402
from test_payments import fake, stripe_listing  # noqa: E402,F401


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


def test_sign_up_needs_the_terms_and_records_when(client):
    email = f"{uuid.uuid4().hex[:10]}@cliente.com"
    body = {"email": email, "password": "s3nha-forte", "name": "Cliente"}
    r = client.post("/register", json=body)
    assert r.status_code == 422 and "Termos" in r.json()["detail"]
    assert client.post("/register", json={**body, "terms_accepted": True}).status_code == 200
    with database.SessionLocal() as db:
        user = db.query(models.User).filter(models.User.email == email).one()
        assert user.terms_accepted_at is not None


def test_subscribing_and_redeeming_need_the_risk_and_record_when(client):
    _, mgr, portfolio_id, listing = published(client, title=f"Risco {uuid.uuid4().hex[:6]}")
    cli, _ = client_headers(client)
    url = f"/api/marketplace/{listing['slug']}/subscribe"
    r = client.post(url, headers=cli, json={})
    assert r.status_code == 422 and "riscos" in r.json()["detail"]
    sub = client.post(url, headers=cli, json={"risk_ack": True}).json()
    with database.SessionLocal() as db:
        assert db.get(models.Subscription, sub["id"]).risk_ack_at is not None

    assert client.post(f"/portfolios/{portfolio_id}/listing/promos", headers=mgr,
                       json={"code": "RISCO", "free_days": 7}).status_code == 200
    other, _ = client_headers(client)
    redeem = f"/api/marketplace/{listing['slug']}/redeem"
    assert client.post(redeem, headers=other, json={"code": "RISCO"}).status_code == 422
    lic = client.post(redeem, headers=other, json={"code": "RISCO", "risk_ack": True})
    assert lic.status_code == 200, lic.text
    with database.SessionLocal() as db:
        promo = db.query(models.Subscription).filter(models.Subscription.license_id == lic.json()["id"]).one()
        assert promo.kind == "promo" and promo.risk_ack_at is not None


def test_another_broker_by_name_asked_when_activating(client):
    cli, _ = client_headers(client)
    r = client.put("/me/broker", headers=cli, json={"broker": "other", "broker_other": "Pepperstone"})
    assert r.status_code == 200 and r.json()["broker"] == "other" and r.json()["broker_other"] == "Pepperstone"
    # Only what comes changes: the advisor alone keeps the broker
    r = client.put("/me/broker", headers=cli, json={"advisor": "Escritório X", "advisor_unknown": False})
    assert r.json()["broker"] == "other" and r.json()["broker_other"] == "Pepperstone" and r.json()["advisor"] == "Escritório X"
    # A listed broker drops the free name
    assert client.put("/me/broker", headers=cli, json={"broker": "XP", "broker_other": "Ignorado"}).json()["broker_other"] is None
    assert client.put("/me/broker", headers=cli, json={"broker": "Inventada"}).status_code == 422
    assert client.put("/me/broker", headers=cli, json={"broker": "other", "broker_other": "a\nb"}).status_code == 422
    _, mgr, _, _ = published(client, title=f"Gestor {uuid.uuid4().hex[:6]}")
    assert client.put("/me/broker", headers=mgr, json={"broker": "XP"}).status_code == 403


def lead(client, slug, email, **kw):
    return client.post(f"/api/marketplace/{slug}/lead", json={"email": email, **kw})


def test_a_lead_gets_the_simulation_then_one_reminder_and_nothing_after(client, outbox):
    _, _, _, listing = published(client, title=f"Lead {uuid.uuid4().hex[:6]}")
    email = f"{uuid.uuid4().hex[:10]}@visitante.com"
    assert lead(client, listing["slug"], "invalido").status_code == 422
    assert client.post("/api/marketplace/nao-existe/lead", json={"email": email}).status_code == 404
    assert lead(client, listing["slug"], email.upper(), lots=2, step="email").json() == {"ok": True}
    assert lead(client, listing["slug"], email, wants_hosting=True, step="hosting").status_code == 200  # The same lead
    with database.SessionLocal() as db:
        [row] = db.query(models.CheckoutLead).filter(models.CheckoutLead.email == email).all()
        assert row.lots == 2 and row.wants_hosting is True and row.step == "hosting"
        seen = row.updated_at

    def mine(at):
        server.send_lead_emails(at)
        return [m for m in outbox if m[0] == email]

    assert mine(seen + datetime.timedelta(minutes=30)) == []  # Still choosing
    [first] = mine(seen + datetime.timedelta(hours=1, minutes=1))
    assert listing["title"] in first[1] and f"/assinar/{listing['slug']}?contratos=2" in first[2]
    assert "parar-emails?token=" in first[2] and "não garantem" in first[2]
    assert len(mine(seen + datetime.timedelta(hours=2))) == 1  # Once
    assert len(mine(seen + datetime.timedelta(hours=25))) == 2  # The reminder
    assert len(mine(seen + datetime.timedelta(days=3))) == 2  # And nothing after


def test_subscribing_or_stopping_ends_the_emails(client, outbox):
    _, _, _, listing = published(client, title=f"Fim {uuid.uuid4().hex[:6]}")
    cli, email = client_headers(client)
    lead(client, listing["slug"], email, lots=2)
    client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"risk_ack": True})
    server.send_lead_emails(datetime.datetime.utcnow() + datetime.timedelta(hours=2))
    assert [m for m in outbox if m[0] == email and listing["title"] in m[1]] == []  # The sign-up's link aside

    visitor = f"{uuid.uuid4().hex[:10]}@visitante.com"
    lead(client, listing["slug"], visitor)
    with database.SessionLocal() as db:
        token = db.query(models.CheckoutLead).filter(models.CheckoutLead.email == visitor).one().token
    assert client.post("/leads/stop", json={"token": "x" * 20}).status_code == 404
    assert client.post("/leads/stop", json={"token": token}).status_code == 200
    server.send_lead_emails(datetime.datetime.utcnow() + datetime.timedelta(hours=2))
    assert [m for m in outbox if m[0] == visitor] == []


def test_an_old_lead_gets_nothing(client, outbox):
    _, _, _, listing = published(client, title=f"Velho {uuid.uuid4().hex[:6]}")
    email = f"{uuid.uuid4().hex[:10]}@visitante.com"
    lead(client, listing["slug"], email)
    later = datetime.datetime.utcnow() + leads.MAX_AGE + datetime.timedelta(hours=1)
    server.send_lead_emails(later)
    assert [m for m in outbox if m[0] == email] == []


def test_leads_are_limited_per_network(client, monkeypatch):
    _, _, _, listing = published(client, title=f"Limite {uuid.uuid4().hex[:6]}")
    monkeypatch.setattr(server, "lead_limiter", server.FailureLimiter(2, 3600))
    for _ in range(2):
        assert lead(client, listing["slug"], f"{uuid.uuid4().hex[:10]}@visitante.com").status_code == 200
    assert lead(client, listing["slug"], f"{uuid.uuid4().hex[:10]}@visitante.com").status_code == 429


def test_the_most_chosen_plan_is_marked_only_once_enough_paid_for_it(client, fake):
    mgr, listing = stripe_listing(client, fake)
    small, big = listing["plans"]

    def popular():
        import marketplace
        marketplace.clear_cache()
        steps = client.get(f"/api/marketplace/{listing['slug']}/simulation").json()["steps"]
        return [s["plan_id"] for s in steps if s["popular"]]

    def paid(plan_id, n):
        with database.SessionLocal() as db:
            for _ in range(n):
                user = models.User(email=f"{uuid.uuid4().hex[:10]}@cliente.com", role="CLIENT")
                db.add(user)
                db.flush()
                db.add(models.Subscription(listing_id=listing["id"], client_user_id=user.id, plan_id=plan_id,
                                           status="approved", stripe_subscription_id=f"sub_{uuid.uuid4().hex[:10]}"))
            db.commit()

    paid(big["id"], 2)
    assert popular() == []  # Too few to say
    paid(big["id"], 1)
    paid(small["id"], 1)
    assert popular() == [big["id"]]
