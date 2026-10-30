"""Launch codes: a listing's codes, using one, the free days starting with the account, the emails before they end,
and subscribing in Stripe before the end (promos.py)."""
import datetime
import os
import uuid

import pytest

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy.exc import IntegrityError  # noqa: E402

import clients  # noqa: E402
import database  # noqa: E402
import mailer  # noqa: E402
import models  # noqa: E402
import payments  # noqa: E402
import server  # noqa: E402
from test_clients import client_headers, fresh_limits  # noqa: E402,F401
from test_management import make_manager  # noqa: E402
from test_marketplace import LISTING, published  # noqa: E402
from test_payments import fake, mine, send, stripe_listing  # noqa: E402,F401


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


def new_code(client, mgr, portfolio_id, **body):
    r = client.post(f"/portfolios/{portfolio_id}/listing/promos", headers=mgr, json={"free_days": 30, **body})
    assert r.status_code == 200, r.text
    return r.json()


def codes(client, mgr, portfolio_id):
    return client.get(f"/portfolios/{portfolio_id}/listing/promos", headers=mgr).json()


def redeem(client, headers, slug, code):
    return client.post(f"/api/marketplace/{slug}/redeem", headers=headers, json={"code": code})


def login():
    return uuid.uuid4().int % 10**8


def utc(value):
    return datetime.datetime.fromisoformat(value)


def test_the_manager_creates_typed_and_generated_codes(client):
    _, mgr, portfolio_id, listing = published(client, title=f"Códigos {uuid.uuid4().hex[:6]}")
    typed = new_code(client, mgr, portfolio_id, code="lanca-mento 30", label="Lançamento de novembro")
    assert typed["code"] == "LANCAMENTO30" and typed["usable"] and typed["uses"] == 0 and typed["free_days"] == 30
    generated = new_code(client, mgr, portfolio_id, free_days=60)
    assert len(generated["code"]) == 8 and set(generated["code"]) <= set(clients.CLAIM_ALPHABET)
    assert client.post(f"/portfolios/{portfolio_id}/listing/promos", headers=mgr,
                       json={"code": "LANCAMENTO-30", "free_days": 30}).status_code == 409  # The same, dashes aside
    for bad in ({"code": "abc"}, {"code": "LANÇAMENTO"}, {"code": "x" * 21}, {"free_days": 0}, {"free_days": 366},
                {"max_uses": 0}, {"label": "duas\nlinhas"}):
        assert client.post(f"/portfolios/{portfolio_id}/listing/promos", headers=mgr,
                           json={"free_days": 30, **bad}).status_code == 422, bad
    _, intruder = make_manager()
    assert client.get(f"/portfolios/{portfolio_id}/listing/promos", headers=intruder).status_code == 404
    assert client.post(f"/portfolios/{portfolio_id}/listing/promos", headers=intruder, json={"free_days": 30}).status_code == 404
    assert [c["id"] for c in codes(client, mgr, portfolio_id)] == [generated["id"], typed["id"]]  # Newest first

    # The page offers a field for a code, and says nothing about which
    page = client.get(f"/api/marketplace/{listing['slug']}")
    assert page.json()["has_promo"] is True and "LANCAMENTO30" not in page.text and generated["code"] not in page.text
    r = client.put(f"/portfolios/{portfolio_id}/listing/promos/{typed['id']}", headers=mgr,
                   json={"label": "Lançamento", "free_days": 45, "max_uses": 100, "active": False})
    assert r.status_code == 200 and not r.json()["usable"] and r.json()["code"] == "LANCAMENTO30" and r.json()["free_days"] == 45
    assert client.delete(f"/portfolios/{portfolio_id}/listing/promos/{generated['id']}", headers=mgr).status_code == 200
    assert client.get(f"/api/marketplace/{listing['slug']}").json()["has_promo"] is False  # Only a turned off one left
    assert [c["id"] for c in codes(client, mgr, portfolio_id)] == [typed["id"]]


def test_a_client_uses_a_code_and_the_days_start_with_the_account(client):
    _, mgr, portfolio_id, listing = published(client, title=f"Grátis {uuid.uuid4().hex[:6]}")
    new_code(client, mgr, portfolio_id, code="GRATIS30")
    cli, _ = client_headers(client)
    assert redeem(client, mgr, listing["slug"], "GRATIS30").status_code == 403  # Clients only

    r = redeem(client, cli, listing["slug"], " gratis-30 ")
    assert r.status_code == 200, r.text
    lic = r.json()
    assert lic["mt5_login"] is None and lic["max_lots"] == LISTING["default_max_lots"]
    assert lic["promo"] == {"free_days": 30, "started_at": None, "ends_at": None}
    assert lic["listing_slug"] == listing["slug"] and lic["renew_plans"] == []  # Paid by hand: no plans
    assert redeem(client, cli, listing["slug"], "GRATIS30").status_code == 409  # Once per client
    [sub] = [s for s in client.get("/me/subscriptions", headers=cli).json() if s["listing"]["id"] == listing["id"]]
    assert (sub["kind"], sub["status"], sub["license_id"]) == ("promo", "approved", lic["id"])
    [code] = codes(client, mgr, portfolio_id)
    assert (code["uses"], code["started"]) == (1, 0)

    # The client takes a month to set the EA up: the free days still start when the account is connected
    db = database.SessionLocal()
    db.get(models.License, lic["id"]).expires_at = datetime.datetime.utcnow() - datetime.timedelta(days=1)
    db.commit()
    db.close()
    r = client.put(f"/me/licenses/{lic['id']}/account", headers=cli, json={"mt5_login": login()})
    assert r.status_code == 200 and r.json()["valid"]
    started = utc(r.json()["promo"]["started_at"])
    assert abs((utc(r.json()["expires_at"]) - started) - datetime.timedelta(days=30)) < datetime.timedelta(seconds=1)
    assert utc(r.json()["promo"]["ends_at"]) == utc(r.json()["expires_at"])
    assert abs(started - datetime.datetime.utcnow()) < datetime.timedelta(minutes=1)
    assert codes(client, mgr, portfolio_id)[0]["started"] == 1


def test_a_code_is_once_per_client_and_account_within_its_limits(client):
    _, mgr, portfolio_id, listing = published(client, title=f"Limites {uuid.uuid4().hex[:6]}")
    slug = listing["slug"]
    two = new_code(client, mgr, portfolio_id, code="DOISUSOS", max_uses=2)
    first, _ = client_headers(client)
    lic = redeem(client, first, slug, "DOISUSOS").json()
    account = login()
    assert client.put(f"/me/licenses/{lic['id']}/account", headers=first, json={"mt5_login": account}).status_code == 200

    # Another sign-up of the same person: a code, but not the account that had the free days
    second, _ = client_headers(client)
    other = redeem(client, second, slug, "DOISUSOS").json()
    assert client.put(f"/me/licenses/{other['id']}/account", headers=second, json={"mt5_login": account}).status_code == 409
    third, _ = client_headers(client)
    r = redeem(client, third, slug, "DOISUSOS")
    assert r.status_code == 409 and "máximo" in r.json()["detail"]  # Used up
    assert client.put(f"/portfolios/{portfolio_id}/listing/promos/{two['id']}", headers=mgr,
                      json={"free_days": 30, "max_uses": 1}).status_code == 422  # Below the uses already made

    # Someone who copies the portfolio already, a turned off code, an expired one, another listing's, none
    new_code(client, mgr, portfolio_id, code="SEMLIMITE")
    buyer, _ = client_headers(client)
    sub = client.post(f"/api/marketplace/{slug}/subscribe", headers=buyer, json={}).json()
    client.post(f"/subscriptions/{sub['id']}/approve", headers=mgr, json={})
    r = redeem(client, buyer, slug, "SEMLIMITE")
    assert r.status_code == 409 and "já tem uma licença" in r.json()["detail"]
    off = new_code(client, mgr, portfolio_id, code="DESLIGADO", active=False)
    late = new_code(client, mgr, portfolio_id, code="ATRASADO",
                    valid_until=(datetime.datetime.utcnow() - datetime.timedelta(hours=1)).isoformat() + "Z")
    assert not off["usable"] and not late["usable"]
    _, other_mgr, other_portfolio, other_listing = published(client, title=f"Outro {uuid.uuid4().hex[:6]}")
    new_code(client, other_mgr, other_portfolio, code="DOOUTRO")
    newcomer, _ = client_headers(client)
    assert redeem(client, newcomer, slug, "DESLIGADO").status_code == 404
    assert redeem(client, newcomer, slug, "ATRASADO").status_code == 409
    assert redeem(client, newcomer, slug, "DOOUTRO").status_code == 404
    assert redeem(client, newcomer, slug, "NAOEXISTE").status_code == 404
    client.post(f"/portfolios/{portfolio_id}/listing/unpublish", headers=mgr)
    assert redeem(client, newcomer, slug, "SEMLIMITE").status_code == 404  # Off the marketplace

    # Two uses at once by the same client: the database keeps one
    db = database.SessionLocal()
    try:
        row = db.query(models.PromoRedemption).filter(models.PromoRedemption.license_id == lic["id"]).one()
        db.add(models.PromoRedemption(promo_code_id=row.promo_code_id, portfolio_id=row.portfolio_id, user_id=row.user_id,
                                      license_id=other["id"], free_days=30))
        with pytest.raises(IntegrityError):
            db.commit()
    finally:
        db.rollback()
        db.close()


def test_wrong_codes_are_rate_limited(client):
    _, mgr, portfolio_id, listing = published(client, title=f"Chutes {uuid.uuid4().hex[:6]}")
    new_code(client, mgr, portfolio_id, code="CERTO123")
    cli, _ = client_headers(client)
    for _ in range(server.AUTH_MAX_FAILURES):
        assert redeem(client, cli, listing["slug"], f"CHUTE{uuid.uuid4().hex[:6]}").status_code == 404
    assert redeem(client, cli, listing["slug"], "CERTO123").status_code == 429  # Blocked, even with the right one


def test_the_code_needs_a_confirmed_email(client, monkeypatch):
    _, mgr, portfolio_id, listing = published(client, title=f"Email {uuid.uuid4().hex[:6]}")
    new_code(client, mgr, portfolio_id, code="CONFIRME")
    cli, email = client_headers(client)
    monkeypatch.setattr(mailer, "enabled", lambda: True)
    r = redeem(client, cli, listing["slug"], "CONFIRME")
    assert r.status_code == 403 and "Confirme seu email" in r.json()["detail"]
    db = database.SessionLocal()
    db.query(models.User).filter(models.User.email == email).one().email_verified_at = datetime.datetime.utcnow()
    db.commit()
    db.close()
    assert redeem(client, cli, listing["slug"], "CONFIRME").status_code == 200


def test_the_end_is_emailed_twice_and_not_after_a_renewal(client, monkeypatch):
    _, mgr, portfolio_id, listing = published(client, title=f"Avisos {uuid.uuid4().hex[:6]}")
    new_code(client, mgr, portfolio_id, code="AVISOS")
    sent = []
    monkeypatch.setattr(mailer, "send", lambda to, subject, body: sent.append((to, subject, body)))

    def mine_sent(email):  # The reminders only: approving a renewal emails too
        return [(subject, body) for to, subject, body in sent if to == email and "acesso grátis" in subject]

    cli, email = client_headers(client)
    lic = redeem(client, cli, listing["slug"], "AVISOS").json()
    ends = utc(client.put(f"/me/licenses/{lic['id']}/account", headers=cli, json={"mt5_login": login()}).json()["expires_at"])
    server.send_promo_reminders(datetime.datetime.utcnow())
    assert mine_sent(email) == []  # A month to go
    server.send_promo_reminders(ends - datetime.timedelta(days=4))
    server.send_promo_reminders(ends - datetime.timedelta(days=4))
    [(subject, body)] = mine_sent(email)
    assert "termina em 4 dias" in subject and f"/client/licenses/{lic['id']}" in body
    assert "assine o portfólio" in body  # Paid by hand: no promise about when the charge starts
    server.send_promo_reminders(ends - datetime.timedelta(hours=12))
    server.send_promo_reminders(ends - datetime.timedelta(hours=6))
    assert len(mine_sent(email)) == 2 and "termina em 1 dia" in mine_sent(email)[1][0]

    # Renewed before the end: nothing ends, nobody is told
    renewer, renewer_email = client_headers(client)
    lic = redeem(client, renewer, listing["slug"], "AVISOS").json()
    ends = utc(client.put(f"/me/licenses/{lic['id']}/account", headers=renewer, json={"mt5_login": login()}).json()["expires_at"])
    request = client.post(f"/me/licenses/{lic['id']}/renew", headers=renewer).json()
    assert client.post(f"/subscriptions/{request['id']}/approve", headers=mgr, json={}).status_code == 200
    server.send_promo_reminders(ends - datetime.timedelta(days=4))
    assert mine_sent(renewer_email) == []
    assert codes(client, mgr, portfolio_id)[0]["subscribed"] == 1


def test_subscribing_in_stripe_during_the_free_days_charges_only_when_they_end(client, fake):
    mgr, listing = stripe_listing(client, fake)
    new_code(client, mgr, listing["portfolio_id"], code="STRIPE30")
    cli, _ = client_headers(client)
    lic = redeem(client, cli, listing["slug"], "STRIPE30").json()
    assert [p["id"] for p in lic["renew_plans"]] == [p["id"] for p in listing["plans"]]
    assert client.post(f"/me/licenses/{lic['id']}/renew", headers=cli, json={}).status_code == 409  # No account yet
    lic = client.put(f"/me/licenses/{lic['id']}/account", headers=cli, json={"mt5_login": login()}).json()

    r = client.post(f"/me/licenses/{lic['id']}/renew", headers=cli, json={})
    assert r.status_code == 422  # Two plans: the client picks one
    renewal = client.post(f"/me/licenses/{lic['id']}/renew", headers=cli, json={"plan_id": listing["plans"][1]["id"]}).json()
    assert renewal["kind"] == "renewal"
    sid = client.post(f"/me/subscriptions/{renewal['id']}/checkout", headers=cli).json()["url"].rsplit("/", 1)[1]
    trial_end = fake.sessions[sid]["params"]["subscription_data"]["trial_end"]
    assert trial_end == int(utc(lic["expires_at"]).replace(tzinfo=datetime.timezone.utc).timestamp())
    send(client, fake.pay(sid))
    after = mine(client, cli, lic["id"])
    assert after["billing"]["status"] == "trialing" and after["max_lots"] == 5  # The plan's lots from now on
    gained = utc(after["expires_at"]) - utc(lic["expires_at"])  # Stripe keeps whole seconds
    assert abs(gained - payments.GRACE) < datetime.timedelta(seconds=1)  # Charged at the end, not today
    assert codes(client, mgr, listing["portfolio_id"])[0]["subscribed"] == 1

    # A listing with a single plan: the renewal takes it without asking
    small = listing["plans"][0]["stripe_price_id"]
    r = client.put(f"/portfolios/{listing['portfolio_id']}/listing", headers=mgr,
                   json={**LISTING, "title": listing["title"], "plans": [{"stripe_price_id": small, "max_lots": 2}]})
    assert r.status_code == 200, r.text
    other, _ = client_headers(client)
    lic = redeem(client, other, listing["slug"], "STRIPE30").json()
    client.put(f"/me/licenses/{lic['id']}/account", headers=other, json={"mt5_login": login()})
    r = client.post(f"/me/licenses/{lic['id']}/renew", headers=other, json={})
    assert r.status_code == 200 and r.json()["plan"]["id"] == listing["plans"][0]["id"]
