"""Stripe (payments.py): a listing's plans, the Checkout, the webhook approving and renewing, and the client changing
the plan or cancelling from the Mirror. Stripe itself is replaced by FakeStripe; the webhook signatures are real."""
import datetime
import json
import time
import uuid
from types import SimpleNamespace

import pytest
import stripe
from cryptography.fernet import Fernet

from fastapi.testclient import TestClient

import database
import keys
import models
import payments
import server
from test_clients import claimed_license, client_headers, fresh_limits  # noqa: F401
from test_hosting import free_pods, license_hash, make_pod, sync
from test_management import make_manager, make_portfolio
from test_marketplace import LISTING

SECRET = "whsec_test"
DAY = 86400


def monthly(cents, nickname=None):
    return {"active": True, "currency": "brl", "unit_amount": cents, "nickname": nickname,
            "recurring": {"interval": "month", "interval_count": 1}}


class FakeStripe:
    def __init__(self):
        self.prices = {"price_avulso": {**monthly(500), "recurring": None}}
        self.sessions, self.subscriptions, self.expired = {}, {}, []
        self.decline = False  # The card refuses the next charge
        ns = SimpleNamespace
        self.v1 = ns(
            prices=ns(retrieve=self._price),
            checkout=ns(sessions=ns(create=self._create, retrieve=lambda i: ns(status=self.sessions[i]["status"]),
                                    expire=self._expire)),
            subscriptions=ns(retrieve=lambda i: self._dict(self.subscriptions[i]), update=self._update,
                             cancel=self._cancel),
            billing_portal=ns(sessions=ns(create=lambda p: ns(url=f"https://billing.stripe.test/{p['customer']}"))))

    @staticmethod
    def _dict(obj):
        return SimpleNamespace(to_dict=lambda: json.loads(json.dumps(obj)))

    def _price(self, price_id):
        if price_id not in self.prices:
            raise stripe.InvalidRequestError("No such price", "id")
        return self._dict(self.prices[price_id])

    def _create(self, params):
        sid = f"cs_{len(self.sessions) + 1}"
        self.sessions[sid] = {"status": "open", "params": params}
        return SimpleNamespace(id=sid, url=f"https://checkout.stripe.test/{sid}")

    def _expire(self, sid):
        self.sessions[sid]["status"] = "expired"
        self.expired.append(sid)

    def _update(self, sub_id, params):
        s = self.subscriptions[sub_id]
        if "items" in params:
            if self.decline:  # pending_if_incomplete: the change waits on the payment
                s["pending_update"] = {"subscription_items": params["items"]}
                return self._dict(s)
            s["items"]["data"][0]["price"] = {"id": params["items"][0]["price"]}
        if "cancel_at_period_end" in params:
            s["cancel_at_period_end"] = params["cancel_at_period_end"]
        self.updates.append((sub_id, params))
        return self._dict(s)

    def _cancel(self, sub_id):
        self.subscriptions[sub_id]["status"] = "canceled"
        self.cancelled.append(sub_id)
        return self._dict(self.subscriptions[sub_id])



    def pay(self, sid, status="active", period_days=30):
        """What Stripe does when the client pays a Checkout: a subscription with the Checkout's metadata."""
        params = self.sessions[sid]["params"]
        now = int(time.time())
        trial_end = params["subscription_data"].get("trial_end")
        sub_id = f"sub_{len(self.subscriptions) + 1}"
        self.subscriptions[sub_id] = {
            "id": sub_id, "customer": "cus_1", "status": "trialing" if trial_end else status, "trial_end": trial_end,
            "cancel_at_period_end": False, "metadata": params["subscription_data"]["metadata"],
            "items": {"data": [{"id": f"si_{sub_id}", "price": {"id": params["line_items"][0]["price"]},
                                "current_period_end": trial_end or now + period_days * DAY}]}}
        self.sessions[sid]["status"] = "complete"
        return {"type": "checkout.session.completed",
                "data": {"object": {"id": sid, "mode": "subscription", "subscription": sub_id,
                                    "client_reference_id": params["client_reference_id"]}}}


@pytest.fixture
def fake(monkeypatch):
    fake = FakeStripe()
    fake.updates, fake.cancelled = [], []
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_x")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", SECRET)
    monkeypatch.setattr(payments, "_client", lambda: fake)
    return fake


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


def send(client, event, secret=SECRET):
    body = json.dumps(event)
    header = stripe.WebhookSignature.generate_signature_header(body, secret)
    return client.post("/api/stripe/webhook", content=body, headers={"stripe-signature": header,
                                                                     "content-type": "application/json"})


def new_prices(fake):
    """Prices of their own: the test database is shared, and a price has one listing."""
    tag = uuid.uuid4().hex[:10]
    small, big = f"price_{tag}a", f"price_{tag}b"
    fake.prices[small], fake.prices[big] = monthly(6990), monthly(22490, "5 contratos")
    return small, big


def stripe_listing(client, fake):
    small, big = new_prices(fake)
    manager_id, mgr = make_manager()
    portfolio_id, _ = make_portfolio(manager_id, with_strategy=True)
    assert client.put("/me/profile", headers=mgr, json={"name": "Gestor Teste"}).status_code == 200
    r = client.put(f"/portfolios/{portfolio_id}/listing", headers=mgr,
                   json={**LISTING, "title": f"Stripe {uuid.uuid4().hex[:6]}", "price": 1, "default_days": 7,
                         "plans": [{"stripe_price_id": small, "max_lots": 2}, {"stripe_price_id": big, "max_lots": 5}]})
    assert r.status_code == 200, r.text
    assert client.post(f"/portfolios/{portfolio_id}/listing/publish", headers=mgr).status_code == 200
    return mgr, r.json()


def mine(client, headers, license_id):
    return next(l for l in client.get("/me/licenses", headers=headers).json()["licenses"] if l["id"] == license_id)


def paid_license(client, fake, plan=0, **body):
    """A client that subscribed to a plan and paid: its license, the Checkout's event and the Stripe subscription."""
    mgr, listing = stripe_listing(client, fake)
    cli, _ = client_headers(client)
    sub = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli,
                      json={"plan_id": listing["plans"][plan]["id"], **body}).json()
    sid = client.post(f"/me/subscriptions/{sub['id']}/checkout", headers=cli).json()["url"].rsplit("/", 1)[1]
    event = fake.pay(sid)
    assert send(client, event).status_code == 200
    [lic] = client.get("/me/licenses", headers=cli).json()["licenses"]
    return cli, listing, lic, fake.subscriptions[event["data"]["object"]["subscription"]]


def test_plans_take_price_currency_and_period_from_stripe(client, fake):
    mgr, listing = stripe_listing(client, fake)
    small, big = listing["plans"]
    assert (small["name"], small["max_lots"], small["price"]) == ("Até 2 contratos", 2, 69.9)
    assert (big["name"], big["max_lots"], big["price"]) == ("5 contratos", 5, 224.9)  # The nickname in Stripe
    assert (listing["price"], listing["currency"], listing["default_days"]) == (69.9, "BRL", 30)  # From the cheapest
    assert listing["pay_online"]
    public = client.get(f"/api/marketplace/{listing['slug']}").json()
    assert public["pay_online"] and [p["id"] for p in public["plans"]] == [small["id"], big["id"]]
    assert "stripe_price_id" not in public["plans"][0]

    url = f"/portfolios/{listing['portfolio_id']}/listing"
    for bad in ("price_nao_existe", "price_avulso", "preco"):
        r = client.put(url, headers=mgr, json={**LISTING, "plans": [{"stripe_price_id": bad, "max_lots": 1}]})
        assert r.status_code == 422, bad
    other_id, other_mgr = make_manager()
    other_portfolio, _ = make_portfolio(other_id)
    r = client.put(f"/portfolios/{other_portfolio}/listing", headers=other_mgr,
                   json={**LISTING, "plans": [{"stripe_price_id": small["stripe_price_id"], "max_lots": 2}]})
    assert r.status_code == 409  # One listing per price

    # A plan left out is archived, and comes back as it was when put back
    r = client.put(url, headers=mgr, json={**LISTING, "plans": [{"stripe_price_id": big["stripe_price_id"], "max_lots": 5}]})
    assert [p["id"] for p in r.json()["plans"]] == [big["id"]]
    r = client.put(url, headers=mgr, json={**LISTING, "plans": [{"stripe_price_id": small["stripe_price_id"], "max_lots": 3},
                                                                {"stripe_price_id": big["stripe_price_id"], "max_lots": 5}]})
    assert r.json()["plans"][0]["id"] == small["id"] and r.json()["plans"][0]["max_lots"] == 3


def test_paying_approves_the_request_and_each_renewal_extends_the_license(client, fake):
    _, listing = stripe_listing(client, fake)
    small, big = listing["plans"]
    cli, email = client_headers(client)
    url = f"/api/marketplace/{listing['slug']}/subscribe"
    assert client.post(url, headers=cli, json={}).status_code == 422  # A plan first
    sub = client.post(url, headers=cli, json={"plan_id": small["id"]}).json()
    assert sub["listing"]["pay_online"] and sub["status"] == "pending"
    # Back from the Checkout, on another plan: the same request
    again = client.post(url, headers=cli, json={"plan_id": big["id"]}).json()
    assert again["id"] == sub["id"] and again["plan"]["id"] == big["id"]
    first = client.post(f"/me/subscriptions/{sub['id']}/checkout", headers=cli).json()["url"]
    second = client.post(f"/me/subscriptions/{sub['id']}/checkout", headers=cli).json()["url"]
    sid = second.rsplit("/", 1)[1]
    assert first != second and fake.expired == [first.rsplit("/", 1)[1]]  # One request is never paid twice
    params = fake.sessions[sid]["params"]
    assert params["customer_email"] == email and params["line_items"] == [{"price": big["stripe_price_id"], "quantity": 1}]

    assert send(client, fake.pay(sid), secret="whsec_outro").status_code == 400
    assert client.get("/me/licenses", headers=cli).json()["licenses"] == []
    event = fake.pay(sid)
    assert send(client, event).status_code == 200
    assert send(client, event).status_code == 200  # Stripe sends it again: still one license
    [lic] = client.get("/me/licenses", headers=cli).json()["licenses"]
    assert lic["valid"] and lic["mt5_login"] is None and lic["max_lots"] == 5
    assert lic["billing"]["status"] == "active" and lic["billing"]["plan"]["id"] == big["id"]
    expiry = datetime.datetime.fromisoformat(lic["expires_at"])
    assert 31 <= (expiry - datetime.datetime.utcnow()).days <= 32  # The paid month plus the grace
    [mine] = client.get("/me/subscriptions", headers=cli).json()
    assert mine["status"] == "approved" and mine["paid_online"]

    # The next month: Stripe advances the period and says so
    s = fake.subscriptions[event["data"]["object"]["subscription"]]
    s["items"]["data"][0]["current_period_end"] += 30 * DAY
    assert send(client, {"type": "customer.subscription.updated", "data": {"object": s}}).status_code == 200
    [lic] = client.get("/me/licenses", headers=cli).json()["licenses"]
    assert 61 <= (datetime.datetime.fromisoformat(lic["expires_at"]) - datetime.datetime.utcnow()).days <= 62

    # A failed renewal changes nothing: the license runs out on its own
    s["status"] = "past_due"
    s["items"]["data"][0]["current_period_end"] += 30 * DAY
    send(client, {"type": "customer.subscription.updated", "data": {"object": s}})
    [lic] = client.get("/me/licenses", headers=cli).json()["licenses"]
    assert 61 <= (datetime.datetime.fromisoformat(lic["expires_at"]) - datetime.datetime.utcnow()).days <= 62
    assert lic["billing"]["status"] == "past_due"

    assert client.post("/me/billing/portal", headers=cli).json()["url"] == "https://billing.stripe.test/cus_1"


def test_the_client_changes_the_plan_in_the_mirror(client, fake):
    cli, listing, lic, s = paid_license(client, fake, plan=0)
    small, big = listing["plans"]
    sub_id = lic["billing"]["subscription_id"]
    assert lic["max_lots"] == 2
    assert client.post(f"/me/subscriptions/{sub_id}/plan", headers=cli, json={"plan_id": small["id"]}).status_code == 409

    fake.decline = True  # The difference is not paid: nothing changes
    r = client.post(f"/me/subscriptions/{sub_id}/plan", headers=cli, json={"plan_id": big["id"]})
    assert r.status_code == 402
    assert mine(client, cli, lic["id"])["max_lots"] == 2

    fake.decline = False
    s.pop("pending_update")
    r = client.post(f"/me/subscriptions/{sub_id}/plan", headers=cli, json={"plan_id": big["id"]})
    assert r.status_code == 200 and r.json()["plan"]["id"] == big["id"]
    _, params = fake.updates[-1]
    assert params["proration_behavior"] == "always_invoice" and params["items"][0]["id"] == f"si_{s['id']}"
    after = mine(client, cli, lic["id"])
    assert after["max_lots"] == 5 and after["billing"]["plan"]["id"] == big["id"]

    # Changed on Stripe's side too (the webhook): back to the small plan
    s["items"]["data"][0]["price"] = {"id": small["stripe_price_id"]}
    send(client, {"type": "customer.subscription.updated", "data": {"object": s}})
    assert mine(client, cli, lic["id"])["max_lots"] == 2


def test_the_client_cancels_and_resumes_the_renewal(client, fake):
    cli, _, lic, s = paid_license(client, fake)
    sub_id = lic["billing"]["subscription_id"]
    r = client.post(f"/me/subscriptions/{sub_id}/renewal", headers=cli, json={"renew": False})
    assert r.status_code == 200 and r.json()["stripe_cancel_at_period_end"]
    after = mine(client, cli, lic["id"])
    assert after["valid"] and after["billing"]["cancel_at_period_end"] and after["expires_at"] == lic["expires_at"]
    r = client.post(f"/me/subscriptions/{sub_id}/renewal", headers=cli, json={"renew": True})
    assert not r.json()["stripe_cancel_at_period_end"]
    assert client.post(f"/me/subscriptions/{sub_id}/renewal", headers=client_headers(client)[0],
                       json={"renew": False}).status_code == 404


def test_renewing_a_license_with_time_left_charges_only_when_it_ends(client, fake):
    cli, listing, lic, s = paid_license(client, fake, plan=1, mt5_login=uuid.uuid4().int % 10**8)
    # Renews by itself: no request by hand
    assert client.post(f"/me/licenses/{lic['id']}/renew", headers=cli).status_code == 409

    # Ended in Stripe: renewing again, on the same plan, subscribes from the license's end without charging today
    s["status"] = "canceled"
    send(client, {"type": "customer.subscription.deleted", "data": {"object": s}})
    renewal = client.post(f"/me/licenses/{lic['id']}/renew", headers=cli).json()
    assert renewal["kind"] == "renewal" and renewal["plan"]["id"] == listing["plans"][1]["id"]
    sid = client.post(f"/me/subscriptions/{renewal['id']}/checkout", headers=cli).json()["url"].rsplit("/", 1)[1]
    trial_end = fake.sessions[sid]["params"]["subscription_data"]["trial_end"]
    expires = datetime.datetime.fromisoformat(lic["expires_at"]).replace(tzinfo=datetime.timezone.utc)
    assert trial_end == int(expires.timestamp())
    send(client, fake.pay(sid))
    after = mine(client, cli, lic["id"])
    assert after["billing"]["status"] == "trialing"
    gained = datetime.datetime.fromisoformat(after["expires_at"]) - datetime.datetime.fromisoformat(lic["expires_at"])
    assert gained == payments.GRACE  # No free month: the charge at the trial's end extends it


def test_a_request_answered_by_hand_closes_its_checkout(client, fake):
    mgr, listing = stripe_listing(client, fake)
    cli, _ = client_headers(client)
    sub = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli,
                      json={"plan_id": listing["plans"][0]["id"]}).json()
    sid = client.post(f"/me/subscriptions/{sub['id']}/checkout", headers=cli).json()["url"].rsplit("/", 1)[1]
    assert client.post(f"/subscriptions/{sub['id']}/reject", headers=mgr, json={}).status_code == 200
    assert fake.sessions[sid]["status"] == "expired"
    assert client.post(f"/me/subscriptions/{sub['id']}/checkout", headers=cli).status_code == 409


def test_without_stripe_the_listing_keeps_the_manual_flow(client, monkeypatch):
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    manager_id, mgr = make_manager()
    portfolio_id, _ = make_portfolio(manager_id)
    r = client.put(f"/portfolios/{portfolio_id}/listing", headers=mgr,
                   json={**LISTING, "plans": [{"stripe_price_id": "price_x", "max_lots": 1}]})
    assert r.status_code == 409
    r = client.put(f"/portfolios/{portfolio_id}/listing", headers=mgr, json=LISTING)
    assert r.status_code == 200 and not r.json()["pay_online"] and r.json()["plans"] == []
    assert client.post("/api/stripe/webhook", content=b"{}").status_code == 503


# --- Hosting ---

@pytest.fixture
def hosting_on(monkeypatch, fake):
    monkeypatch.setenv("HOSTING_SECRET", Fernet.generate_key().decode())
    fake.prices["price_hosting"] = monthly(4990, "Hospedagem")
    monkeypatch.setenv("STRIPE_HOSTING_PRICE_ID", "price_hosting")
    payments._terms_cache.clear()
    free_pods()
    return fake


def hosting_of(client, cli, license_id):
    return mine(client, cli, license_id)["hosting"]


def terminal_version(license_id):
    db = database.SessionLocal()
    try:
        return db.query(models.HostedTerminal).filter(models.HostedTerminal.license_id == license_id).one().config_version
    finally:
        db.close()


def test_the_client_pays_for_hosting_and_the_terminal_runs_only_while_paid(client, hosting_on):
    fake = hosting_on
    _, _, _, lic, cli, email = claimed_license(client)
    old_hash = license_hash(lic["id"])
    offer = client.get("/me/licenses", headers=cli).json()
    assert offer["hosting_price"] == {"price": 49.9, "currency": "BRL", "days": 30} and not offer["hosting_room"]
    pod = make_pod("billing-pod")
    assert sync(client, pod) == []
    assert client.get("/me/licenses", headers=cli).json()["hosting_room"]

    r = client.put(f"/me/licenses/{lic['id']}/hosting", headers=cli, json={"server": "Tickmill-Demo", "password": "p4ss"})
    assert r.status_code == 200
    h = hosting_of(client, cli, lic["id"])
    assert h["state"] == "unpaid" and not h["billing"]["exempt"] and not h["billing"]["paid"]
    assert license_hash(lic["id"]) == old_hash  # Not paid yet: the client's own EA keeps copying
    assert sync(client, pod) == []  # Nothing to run before the payment

    first = client.post(f"/me/licenses/{lic['id']}/hosting/checkout", headers=cli).json()["url"].rsplit("/", 1)[1]
    sid = client.post(f"/me/licenses/{lic['id']}/hosting/checkout", headers=cli).json()["url"].rsplit("/", 1)[1]
    assert fake.sessions[first]["status"] == "expired"  # Never paid twice
    params = fake.sessions[sid]["params"]
    assert params["line_items"] == [{"price": "price_hosting", "quantity": 1}] and params["customer_email"] == email
    event = fake.pay(sid)
    assert send(client, event).status_code == 200
    s = fake.subscriptions[event["data"]["object"]["subscription"]]

    view = mine(client, cli, lic["id"])
    assert view["billing"] is None  # Apart from the portfolio's subscription
    assert view["hosting"]["billing"]["paid"] and view["hosting"]["billing"]["status"] == "active"
    [t] = sync(client, pod)
    assert t["enabled"] and t["password"] == "p4ss"
    assert keys.key_hash(t["license_key"]) == license_hash(lic["id"]) != old_hash  # The key moves to the pod now
    assert client.post(f"/me/licenses/{lic['id']}/hosting/checkout", headers=cli).status_code == 409

    # Cancelled: runs until the paid period ends
    r = client.post(f"/me/licenses/{lic['id']}/hosting/renewal", headers=cli, json={"renew": False})
    assert r.status_code == 200 and r.json()["hosting"]["billing"]["cancel_at_period_end"]
    assert sync(client, pod)[0]["enabled"]
    s["status"], s["cancel_at_period_end"] = "canceled", True  # Stripe ends it with the period
    send(client, {"type": "customer.subscription.deleted", "data": {"object": s}})
    [t] = sync(client, pod)
    assert not t["enabled"] and "password" not in t
    assert hosting_of(client, cli, lic["id"])["state"] == "unpaid"

    # Subscribing again: a new version, so the pod starts the stopped terminal
    version = terminal_version(lic["id"])
    sid = client.post(f"/me/licenses/{lic['id']}/hosting/checkout", headers=cli).json()["url"].rsplit("/", 1)[1]
    event = fake.pay(sid)
    send(client, event)
    send(client, {"type": "customer.subscription.deleted", "data": {"object": s}})  # The old one, late: ignored
    [t] = sync(client, pod)
    assert t["enabled"] and t["config_version"] == version + 1

    # Removing the hosting ends its subscription
    assert client.delete(f"/me/licenses/{lic['id']}/hosting", headers=cli).status_code == 200
    assert fake.cancelled == [event["data"]["object"]["subscription"]]
    assert sync(client, pod) == []


def test_a_failed_renewal_stops_the_terminal_after_the_grace():
    now = datetime.datetime(2026, 10, 26)
    t = models.HostedTerminal(exempt=False, stripe_status="past_due", stripe_period_end=now - datetime.timedelta(days=1))
    assert payments.hosting.paid(t, now)
    assert not payments.hosting.paid(t, now + payments.hosting.GRACE)
    t.stripe_status = "unpaid"  # Stripe gave up: at once
    assert not payments.hosting.paid(t, now)
    assert payments.hosting.paid(models.HostedTerminal(exempt=True), now)


def test_hosting_by_the_manager_is_exempt(client, hosting_on):
    _, mgr, _, lic, cli, _ = claimed_license(client)
    old_hash = license_hash(lic["id"])
    assert client.put(f"/licenses/{lic['id']}/hosting", headers=mgr, json={"server": "Demo", "password": "x"}).status_code == 200
    assert license_hash(lic["id"]) != old_hash
    h = hosting_of(client, cli, lic["id"])
    assert h["billing"]["exempt"] and h["billing"]["paid"] and h["state"] == "pending"
    assert client.post(f"/me/licenses/{lic['id']}/hosting/checkout", headers=cli).status_code == 409
    [t] = sync(client, make_pod("exempt-pod"))
    assert t["enabled"]


def test_the_admin_sees_every_terminal_and_decides_who_pays(client, hosting_on):
    _, mgr, _, lic, cli, email = claimed_license(client)
    client.put(f"/licenses/{lic['id']}/hosting", headers=mgr, json={"server": "Demo", "password": "x"})
    pod = make_pod("admin-pod")
    [t] = sync(client, pod)
    _, admin = make_manager(role="TDM_DEV")
    assert client.get("/admin/hosting", headers=cli).status_code == 403
    out = client.get("/admin/hosting", headers=admin).json()
    assert out["charged"] and out["price"]["price"] == 49.9
    row = next(r for r in out["terminals"] if r["license_id"] == lic["id"])
    assert row["client"]["email"] == email and row["billing"]["exempt"] and "password" not in row
    assert next(p for p in out["pods"] if p["name"] == "admin-pod")["running"] == 1

    # Charged from now on: without a paid subscription, it stops
    r = client.put(f"/admin/hosting/{row['id']}/exempt", headers=admin, json={"exempt": False})
    assert r.status_code == 200 and r.json()["state"] == "unpaid"
    assert not sync(client, pod)[0]["enabled"]
    # Exempt again: a new version, so the pod starts it
    client.put(f"/admin/hosting/{row['id']}/exempt", headers=admin, json={"exempt": True})
    [again] = sync(client, pod)
    assert again["enabled"] and again["config_version"] == t["config_version"] + 1


def test_no_room_in_the_pods_no_hosting_for_sale(client, hosting_on):
    fake = hosting_on
    _, _, _, lic, cli, _ = claimed_license(client)
    body = {"server": "Tickmill-Demo", "password": "p4ss"}
    assert client.put(f"/me/licenses/{lic['id']}/hosting", headers=cli, json=body).status_code == 409  # No pod online
    pod = make_pod("full-pod")
    sync(client, pod, capacity=1)
    assert client.put(f"/me/licenses/{lic['id']}/hosting", headers=cli, json=body).status_code == 200

    # A manager's terminal takes the only room before the client pays
    _, mgr, _, other, _, _ = claimed_license(client)
    assert client.put(f"/licenses/{other['id']}/hosting", headers=mgr, json={"server": "Demo", "password": "x"}).status_code == 200
    assert len(sync(client, pod, capacity=1)) == 1
    assert not client.get("/me/licenses", headers=cli).json()["hosting_room"]
    opened = len(fake.sessions)
    assert client.post(f"/me/licenses/{lic['id']}/hosting/checkout", headers=cli).status_code == 409
    assert len(fake.sessions) == opened  # Refused before Stripe

    sync(client, pod, capacity=2)  # Room again
    assert client.post(f"/me/licenses/{lic['id']}/hosting/checkout", headers=cli).status_code == 200


def test_the_admins_hear_of_a_paid_terminal_waiting_for_a_pod(client, hosting_on):
    fake = hosting_on
    _, _, _, lic, cli, email = claimed_license(client)
    pod = make_pod("busy-pod")
    sync(client, pod, capacity=1)
    client.put(f"/me/licenses/{lic['id']}/hosting", headers=cli, json={"server": "Tickmill-Demo", "password": "p4ss"})
    sid = client.post(f"/me/licenses/{lic['id']}/hosting/checkout", headers=cli).json()["url"].rsplit("/", 1)[1]
    send(client, fake.pay(sid))
    free_pods()  # The pod is gone before it took the terminal
    h = hosting_of(client, cli, lic["id"])
    assert h["state"] == "pending" and "preparando" in h["detail"]

    db = database.SessionLocal()
    try:
        t = db.query(models.HostedTerminal).filter(models.HostedTerminal.license_id == lic["id"]).one()
        now = datetime.datetime.utcnow()
        assert payments.hosting.queue_alerts(db, now) == []  # Not long enough yet
        later = now + payments.hosting.QUEUE_ALERT_AFTER + datetime.timedelta(seconds=1)
        assert [x.id for x in payments.hosting.queue_alerts(db, later)] == [t.id]
        db.commit()
        assert payments.hosting.queue_alerts(db, later) == []  # Once
    finally:
        db.close()

    [taken] = sync(client, make_pod("new-pod"))  # A pod takes it: the mark goes, for a later wait
    assert taken["enabled"]
    db = database.SessionLocal()
    try:
        assert db.query(models.HostedTerminal).filter(models.HostedTerminal.license_id == lic["id"]).one().queue_alerted_at is None
    finally:
        db.close()
