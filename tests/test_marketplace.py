"""Marketplace: listings, the public catalog, subscription requests and their approval (marketplace.py)."""
import datetime
import os
import uuid

import pytest

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402
import marketplace  # noqa: E402
import models  # noqa: E402
import server  # noqa: E402
from test_clients import client_headers, fresh_limits  # noqa: E402,F401
from test_hosting import master_runs_on  # noqa: E402
from test_management import make_manager, make_portfolio  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


LISTING = {"title": "Tendência no Índice", "summary": "Mini índice, tendência", "description": "Linha 1\nLinha 2",
           "markets": ["B3"], "price": 197.0, "checkout_url": "https://pay.example.com/abc", "default_days": 30,
           "default_max_lots": 2, "min_capital": 5000}


SELLER = {"name": "Trader Teste da Silva", "document": "529.982.247-25", "address": "Rua das Flores, 100, São Paulo/SP",
          "email": "Contato@Trader.com", "credential": "CNPI 1234"}


def set_seller(client, mgr, **changes):
    r = client.put("/me/seller", headers=mgr, json={**SELLER, **changes})
    assert r.status_code == 200, r.text
    return r.json()


def verified_seller(client, mgr):
    """Seller details in, and the credential checked by an admin: what publishing needs."""
    set_seller(client, mgr)
    _, admin = make_manager(role="TDM_DEV")
    trader_id = next(t["id"] for t in client.get("/admin/credentials", headers=admin).json()["traders"]
                     if t["email"] == client.get("/me", headers=mgr).json()["email"])
    r = client.post(f"/admin/users/{trader_id}/credential", headers=admin, json={"verified": True})
    assert r.status_code == 200, r.text
    return trader_id


def published(client, title=LISTING["title"]):
    manager_id, mgr = make_manager()
    portfolio_id, _ = make_portfolio(manager_id, with_strategy=True)
    assert client.put("/me/profile", headers=mgr, json={"name": "Gestor Teste", "bio": "Opera índice"}).status_code == 200
    verified_seller(client, mgr)
    r = client.put(f"/portfolios/{portfolio_id}/listing", headers=mgr, json={**LISTING, "title": title})
    assert r.status_code == 200, r.text
    assert client.post(f"/portfolios/{portfolio_id}/listing/publish", headers=mgr).status_code == 200
    return manager_id, mgr, portfolio_id, r.json()


def test_listing_drafts_slugs_and_publishing(client):
    manager_id, mgr = make_manager()
    portfolio_id, _ = make_portfolio(manager_id)  # No strategy yet
    r = client.put(f"/portfolios/{portfolio_id}/listing", headers=mgr, json={**LISTING, "title": "Ação & Reação!"})
    assert r.status_code == 200 and r.json()["status"] == "draft" and r.json()["slug"].startswith("acao-reacao")
    assert client.post(f"/portfolios/{portfolio_id}/listing/publish", headers=mgr).status_code == 409  # No strategy
    other_portfolio, _ = make_portfolio(manager_id, with_strategy=True)
    r2 = client.put(f"/portfolios/{other_portfolio}/listing", headers=mgr, json={**LISTING, "title": "Ação & Reação!"})
    assert r2.json()["slug"] != r.json()["slug"]  # Unique address
    r = client.post(f"/portfolios/{other_portfolio}/listing/publish", headers=mgr)
    assert r.status_code == 409 and "nome" in r.json()["detail"]  # The public name first
    assert client.put("/me/profile", headers=mgr, json={"name": "Trader Sem Dados"}).status_code == 200
    r = client.post(f"/portfolios/{other_portfolio}/listing/publish", headers=mgr)
    assert r.status_code == 409 and "vendedor" in r.json()["detail"]  # Then who sells
    for bad in ({**LISTING, "checkout_url": "http://pay.example.com"}, {**LISTING, "markets": ["Ações"]},
                {**LISTING, "slug": "Com Espaço"}, {**LISTING, "price": -1}):
        assert client.put(f"/portfolios/{portfolio_id}/listing", headers=mgr, json=bad).status_code == 422, bad
    _, intruder = make_manager()
    assert client.put(f"/portfolios/{portfolio_id}/listing", headers=intruder, json=LISTING).status_code == 404


def test_public_catalog_shows_only_published(client):
    _, mgr, portfolio_id, listing = published(client, title=f"Catálogo {uuid.uuid4().hex[:6]}")
    slugs = [l["slug"] for l in client.get("/api/marketplace").json()]
    assert listing["slug"] in slugs
    detail = client.get(f"/api/marketplace/{listing['slug']}").json()
    assert detail["manager"] == {"name": "Gestor Teste", "bio": "Opera índice", "youtube_url": None, "instagram_url": None}
    assert detail["strategies"] == ["Scalper"]
    assert "portfolio_id" not in detail and detail["stats"]["trades"] == 0 and detail["stats"]["per_lot"] is None
    assert detail["stats"]["assets"] == []
    assert client.get(f"/api/marketplace/{listing['slug']}/performance", params={"days": 100}).status_code == 200
    client.post(f"/portfolios/{portfolio_id}/listing/unpublish", headers=mgr)
    assert client.get(f"/api/marketplace/{listing['slug']}").status_code == 404
    assert listing["slug"] not in [l["slug"] for l in client.get("/api/marketplace").json()]


def test_profile_links_go_only_to_their_network(client):
    _, mgr, _, listing = published(client, title=f"Links {uuid.uuid4().hex[:6]}")
    links = {"youtube_url": "https://www.youtube.com/@gestor", "instagram_url": "https://instagram.com/gestor"}
    r = client.put("/me/profile", headers=mgr, json={"name": "Gestor Teste", "bio": None, **links})
    assert r.status_code == 200 and r.json()["youtube_url"] == links["youtube_url"]
    manager = client.get(f"/api/marketplace/{listing['slug']}").json()["manager"]
    assert (manager["youtube_url"], manager["instagram_url"]) == (links["youtube_url"], links["instagram_url"])
    for bad in ({"youtube_url": "https://evil.example.com/youtube.com"}, {"youtube_url": "http://youtube.com/@gestor"},
                {"instagram_url": "https://www.youtube.com/@gestor"}, {"instagram_url": "https://instagram.com.evil.io/x"},
                {"youtube_url": "javascript:alert(1)"}):
        assert client.put("/me/profile", headers=mgr, json={"name": "Gestor Teste", **bad}).status_code == 422, bad
    assert client.put("/me/profile", headers=mgr, json={"name": "Gestor Teste"}).json()["instagram_url"] is None  # Cleared


def test_subscription_approved_creates_the_linked_license_and_renewal_extends_it(client):
    _, mgr, portfolio_id, listing = published(client, title=f"Assinatura {uuid.uuid4().hex[:6]}")
    cli, _ = client_headers(client)
    login = uuid.uuid4().int % 10**8
    assert client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=mgr, json={"risk_ack": True, "mt5_login": login}).status_code == 403
    r = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"risk_ack": True, "mt5_login": login, "note": "Paguei"})
    assert r.status_code == 200 and r.json()["status"] == "pending" and r.json()["kind"] == "new"
    assert r.json()["listing"]["checkout_url"] == LISTING["checkout_url"]
    assert client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"risk_ack": True, "mt5_login": login}).status_code == 409

    [pending] = client.get("/me/subscriptions", headers=mgr, params={"status_filter": "pending"}).json()
    assert pending["client"]["name"] == "Cliente" and pending["note"] == "Paguei"
    _, intruder = make_manager()
    assert client.post(f"/subscriptions/{pending['id']}/approve", headers=intruder, json={}).status_code == 404
    r = client.post(f"/subscriptions/{pending['id']}/approve", headers=mgr, json={"note": "Bem-vindo"})
    assert r.status_code == 200 and r.json()["status"] == "approved"
    assert client.post(f"/subscriptions/{pending['id']}/approve", headers=mgr, json={}).status_code == 409

    [lic] = client.get("/me/licenses", headers=cli).json()["licenses"]
    assert lic["mt5_login"] == login and lic["max_lots"] == 2 and lic["valid"]
    first_expiry = datetime.datetime.fromisoformat(lic["expires_at"])
    assert 29 <= (first_expiry - datetime.datetime.utcnow()).days <= 30

    r = client.post(f"/me/licenses/{lic['id']}/renew", headers=cli)
    assert r.status_code == 200 and r.json()["kind"] == "renewal"
    client.post(f"/subscriptions/{r.json()['id']}/approve", headers=mgr, json={"days": 60})
    [lic] = client.get("/me/licenses", headers=cli).json()["licenses"]
    assert (datetime.datetime.fromisoformat(lic["expires_at"]) - first_expiry).days == 60  # From the current expiry


def test_buy_without_the_account_and_connect_it_on_the_license(client):
    _, mgr, portfolio_id, listing = published(client, title=f"Sem conta {uuid.uuid4().hex[:6]}")
    cli, _ = client_headers(client)
    other, _ = client_headers(client)
    r = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"risk_ack": True})
    assert r.status_code == 200 and r.json()["mt5_login"] is None and r.json()["kind"] == "new"
    assert client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"risk_ack": True}).status_code == 409
    client.post(f"/subscriptions/{r.json()['id']}/approve", headers=mgr, json={})
    [lic] = client.get("/me/licenses", headers=cli).json()["licenses"]
    assert lic["mt5_login"] is None and lic["valid"]
    # Nothing copies, and nothing renews, before the account is there
    assert client.post(f"/me/licenses/{lic['id']}/key", headers=cli).status_code == 409
    assert client.post(f"/me/licenses/{lic['id']}/renew", headers=cli).status_code == 409

    login = uuid.uuid4().int % 10**8
    taken = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=other, json={"risk_ack": True, "mt5_login": login}).json()
    client.post(f"/subscriptions/{taken['id']}/approve", headers=mgr, json={})
    assert client.put(f"/me/licenses/{lic['id']}/account", headers=cli, json={"mt5_login": login}).status_code == 409
    assert client.put(f"/me/licenses/{lic['id']}/account", headers=other, json={"mt5_login": login + 1}).status_code == 404
    r = client.put(f"/me/licenses/{lic['id']}/account", headers=cli, json={"mt5_login": login + 1})
    assert r.status_code == 200 and r.json()["mt5_login"] == login + 1
    assert client.put(f"/me/licenses/{lic['id']}/account", headers=cli, json={"mt5_login": login + 2}).status_code == 409
    assert client.post(f"/me/licenses/{lic['id']}/key", headers=cli).status_code == 200


def test_a_master_account_is_neither_bought_for_nor_connected(client):
    manager_id, mgr, portfolio_id, listing = published(client, title=f"Conta do master {uuid.uuid4().hex[:6]}")
    cli, _ = client_headers(client)
    login = uuid.uuid4().int % 10**8
    master_runs_on(manager_id, login)
    r = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"risk_ack": True, "mt5_login": login})
    assert r.status_code == 409 and "conta de um Master" in r.json()["detail"]
    r = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"risk_ack": True})
    client.post(f"/subscriptions/{r.json()['id']}/approve", headers=mgr, json={})
    [lic] = client.get("/me/licenses", headers=cli).json()["licenses"]
    assert client.put(f"/me/licenses/{lic['id']}/account", headers=cli, json={"mt5_login": login}).status_code == 409


def test_reject_cancel_and_someone_elses_account(client):
    _, mgr, portfolio_id, listing = published(client, title=f"Recusa {uuid.uuid4().hex[:6]}")
    cli, _ = client_headers(client)
    other, _ = client_headers(client)
    a = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"risk_ack": True, "mt5_login": 111}).json()
    b = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"risk_ack": True, "mt5_login": 222}).json()
    r = client.post(f"/subscriptions/{a['id']}/reject", headers=mgr, json={"note": "Conta errada"})
    assert r.json()["status"] == "rejected" and r.json()["decision_note"] == "Conta errada"
    assert client.post(f"/me/subscriptions/{b['id']}/cancel", headers=other).status_code == 404
    assert client.post(f"/me/subscriptions/{b['id']}/cancel", headers=cli).json()["status"] == "cancelled"
    assert client.post(f"/subscriptions/{b['id']}/approve", headers=mgr, json={}).status_code == 409
    # An account already licensed to another client cannot be taken over by asking for it
    c = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"risk_ack": True, "mt5_login": 333}).json()
    client.post(f"/subscriptions/{c['id']}/approve", headers=mgr, json={})
    r = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=other, json={"risk_ack": True, "mt5_login": 333})
    assert r.status_code == 409


def test_cancel_and_ask_again_is_limited_per_day(client, monkeypatch):
    _, _, _, listing = published(client, title=f"Limite {uuid.uuid4().hex[:6]}")
    cli, _ = client_headers(client)
    monkeypatch.setattr(server, "subscribe_limiter", server.FailureLimiter(2, 86400))
    for _ in range(2):
        sub = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"risk_ack": True, "mt5_login": 444}).json()
        client.post(f"/me/subscriptions/{sub['id']}/cancel", headers=cli)
    r = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"risk_ack": True, "mt5_login": 444})
    assert r.status_code == 429


def test_admin_suspends_and_the_manager_cannot_republish(client):
    _, mgr, portfolio_id, listing = published(client, title=f"Suspensa {uuid.uuid4().hex[:6]}")
    _, admin = make_manager(role="TDM_DEV")
    assert client.post(f"/admin/listings/{listing['id']}/suspend", headers=mgr, json={"reason": "x" * 5}).status_code == 403
    r = client.post(f"/admin/listings/{listing['id']}/suspend", headers=admin, json={"reason": "Desempenho falso"})
    assert r.json()["status"] == "suspended"
    assert client.get(f"/api/marketplace/{listing['slug']}").status_code == 404
    r = client.post(f"/portfolios/{portfolio_id}/listing/publish", headers=mgr)
    assert r.status_code == 409 and "Desempenho falso" in r.json()["detail"]
    assert client.post(f"/admin/listings/{listing['id']}/restore", headers=admin).json()["status"] == "draft"
    assert client.post(f"/portfolios/{portfolio_id}/listing/publish", headers=mgr).status_code == 200


def test_slugify():
    assert marketplace.slugify("  Índice — Tendência 2026! ") == "indice-tendencia-2026"
    assert marketplace.slugify("***") == "portfolio"


def test_a_request_without_an_account_approved_twice_keeps_one_license(client):
    """Stripe's events for one purchase arrive together: approving the same request again (the webhook seeing it
    pending twice) extends its license instead of making another one."""
    _, _, portfolio_id, listing = published(client, title=f"Sem conta {uuid.uuid4().hex[:6]}")
    cli, _ = client_headers(client)
    sub_id = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"risk_ack": True}).json()["id"]
    now = datetime.datetime.utcnow()
    with database.SessionLocal() as db:
        sub = db.get(models.Subscription, sub_id)
        first = marketplace.approve(db, sub, marketplace.Decision(), now)
        sub.status = "pending"  # What a second event saw before the first one committed
        again = marketplace.approve(db, sub, marketplace.Decision(), now)
        db.commit()
        assert again.id == first.id
        assert db.query(models.License).filter(models.License.portfolio_id == portfolio_id).count() == 1


def _valid_cpf(seed: str) -> str:
    """Builds a valid 11-digit CPF from a 9-digit numeric seed."""
    digits = [int(c) for c in seed[:9].ljust(9, "0")]
    if len(set(digits)) == 1:
        digits[0] = (digits[0] + 1) % 10
    for length in (9, 10):
        total = sum(digits[i] * (length + 1 - i) for i in range(length))
        check = (total * 10) % 11
        digits.append(0 if check == 10 else check)
    return "".join(str(d) for d in digits)


def test_checkout_email_check_cpf_onboarding_and_hosting_choice(client, fresh_limits):
    _, mgr, _, listing = published(client, title=f"Checkout {uuid.uuid4().hex[:6]}")
    email = f"guest_{uuid.uuid4().hex[:8]}@cliente.com"
    assert client.post("/auth/email-check", json={"email": "invalido"}).status_code == 422
    assert client.post("/auth/email-check", json={"email": email}).json() == {"exists": False}

    # Invalid CPFs are rejected at sign-up
    for bad_cpf in ("111.111.111-11", "123.456.789-00", "12345"):
        r = client.post("/register", json={"terms_accepted": True, "email": email, "password": "s3nha-forte", "name": "João", "cpf": bad_cpf})
        assert r.status_code == 422, bad_cpf

    cpf = _valid_cpf(str(uuid.uuid4().int)[:9])
    formatted_cpf = f"{cpf[:3]}.{cpf[3:6]}.{cpf[6:9]}-{cpf[9:]}"
    r = client.post("/register", json={"terms_accepted": True,
        "email": email, "password": "s3nha-forte", "name": "João Silva",
        "cpf": formatted_cpf, "broker": "XP", "advisor": "EQI Investimentos", "advisor_unknown": False,
    })
    assert r.status_code == 200, r.text
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert client.post("/auth/email-check", json={"email": email.upper()}).json() == {"exists": True}

    # Duplicate CPF is rejected on another account
    r_dup = client.post("/register", json={"terms_accepted": True,
        "email": f"other_{uuid.uuid4().hex[:8]}@cliente.com", "password": "s3nha-forte", "cpf": cpf,
    })
    assert r_dup.status_code == 409

    me = client.get("/me", headers=headers).json()
    assert me["cpf"] == cpf and me["broker"] == "XP" and me["advisor"] == "EQI Investimentos" and not me["advisor_unknown"]

    # Subscribing through the checkout wizard records wants_hosting and updates broker/advisor when changed
    sub = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=headers, json={"risk_ack": True,
        "wants_hosting": True, "broker": "Clear", "advisor_unknown": True,
    }).json()
    assert sub["wants_hosting"] is True
    me_after = client.get("/me", headers=headers).json()
    assert me_after["broker"] == "Clear" and me_after["advisor"] is None and me_after["advisor_unknown"] is True

    client.post(f"/subscriptions/{sub['id']}/approve", headers=mgr, json={})
    [lic] = client.get("/me/licenses", headers=headers).json()["licenses"]
    assert lic["wants_hosting"] is True


def test_marketplace_simulation_scales_profit_capital_and_drawdown(client):
    _, mgr, portfolio_id, listing = published(client, title=f"Simulador {uuid.uuid4().hex[:6]}")
    now = datetime.datetime.utcnow()
    with database.SessionLocal() as db:
        db.add_all([
            models.IncubationTrade(portfolio_id=portfolio_id, dash_id="t1", traded_at=now - datetime.timedelta(days=20),
                                   pnl=600.0, lots=2.0, verified=True),
            models.IncubationTrade(portfolio_id=portfolio_id, dash_id="t2", traded_at=now - datetime.timedelta(days=10),
                                   pnl=-200.0, lots=2.0, verified=True),
            models.IncubationTrade(portfolio_id=portfolio_id, dash_id="t3", traded_at=now - datetime.timedelta(days=5),
                                   pnl=400.0, lots=2.0, verified=True),
        ])
        db.commit()
    marketplace.clear_cache()

    sim = client.get(f"/api/marketplace/{listing['slug']}/simulation").json()
    # Normalized per 1 lot: +300, -100, +200 -> net = 400 per lot, max_drawdown = 100 per lot
    # Base lots = 2, min_capital = 5000 -> unit_capital = 2500 per lot
    assert sim["trades"] == 3 and sim["unit_net"] == 400.0 and sim["unit_max_drawdown"] == 100.0
    assert sim["unit_capital"] == 2500.0 and sim["base_capital"] == 5000.0
    by_lots = {s["lots"]: s for s in sim["steps"]}
    assert by_lots[1.0]["simulated_profit"] == 400.0 and by_lots[1.0]["recommended_capital"] == 2500.0
    assert by_lots[2.0]["simulated_profit"] == 800.0 and by_lots[2.0]["recommended_capital"] == 5000.0
    assert by_lots[5.0]["simulated_profit"] == 2000.0 and by_lots[5.0]["max_drawdown"] == 500.0


def test_the_buyer_sees_who_sells_and_only_once_it_is_complete(client):
    _, mgr = make_manager()
    assert client.get("/me", headers=mgr).json()["seller"] is None
    for bad in ({"document": "111.111.111-11"}, {"document": "11.222.333/0001-82"}, {"email": "sem-arroba"},
                {"address": "curto"}, {"name": "Linha" + chr(10) + "quebrada"}):
        assert client.put("/me/seller", headers=mgr, json={**SELLER, **bad}).status_code == 422, bad
    me = set_seller(client, mgr)
    assert me["seller"] == {"name": SELLER["name"], "document": "52998224725", "address": SELLER["address"],
                            "email": "contato@trader.com", "credential": "CNPI 1234", "complete": True,
                            "credential_status": "pending", "credential_note": None, "credential_checked_at": None}
    # A company sells too, and the credential is optional
    assert set_seller(client, mgr, document="11.222.333/0001-81", credential=None)["seller"]["credential"] is None
    cli, _ = client_headers(client)
    assert client.put("/me/seller", headers=cli, json=SELLER).status_code == 403
    assert client.get("/me", headers=cli).json()["seller"] is None

    _, trader, _, listing = published(client, title=f"Vendedor {uuid.uuid4().hex[:6]}")
    detail = client.get(f"/api/marketplace/{listing['slug']}").json()
    seller = detail["seller"]
    assert seller["credential_verified"] is True and seller["credential_checked_at"]
    assert {k: v for k, v in seller.items() if not k.startswith("credential_")} == {
        "name": SELLER["name"], "document": "529.982.247-25", "document_kind": "CPF",
        "address": SELLER["address"], "email": "contato@trader.com", "credential": "CNPI 1234"}
    # Not in the catalog's list: the seller's document only where the buyer is about to contract
    catalog = client.get("/api/marketplace").json()
    assert all("seller" not in item for item in catalog)
    set_seller(client, trader, document="11.222.333/0001-81")
    assert client.get(f"/api/marketplace/{listing['slug']}").json()["seller"]["document"] == "11.222.333/0001-81"


def test_only_a_checked_credential_publishes_and_a_refusal_takes_the_portfolios_down(client, monkeypatch):
    import mailer
    sent = []
    monkeypatch.setattr(mailer, "send", lambda to, subject, body: sent.append((to, subject)))
    manager_id, mgr = make_manager()
    portfolio_id, _ = make_portfolio(manager_id, with_strategy=True)
    assert client.put("/me/profile", headers=mgr, json={"name": "Trader Conferido"}).status_code == 200
    assert client.put(f"/portfolios/{portfolio_id}/listing", headers=mgr,
                      json={**LISTING, "title": f"Conferido {uuid.uuid4().hex[:6]}"}).status_code == 200
    _, admin = make_manager(role="TDM_DEV")
    admin_email = client.get("/me", headers=admin).json()["email"]
    publish = lambda: client.post(f"/portfolios/{portfolio_id}/listing/publish", headers=mgr)  # noqa: E731

    # Without a credential, and while it waits for the check
    set_seller(client, mgr, credential=None)
    assert client.get("/me", headers=mgr).json()["seller"]["credential_status"] is None
    r = publish()
    assert r.status_code == 409 and "Informe o seu credenciamento" in r.json()["detail"]
    set_seller(client, mgr)
    assert any(to == admin_email and "Credenciamento para conferir" in subject for to, subject in sent)
    r = publish()
    assert r.status_code == 409 and "em conferência" in r.json()["detail"]

    listing = client.get("/admin/credentials", headers=admin).json()
    assert listing["list_url"].startswith("https://www.apimecbrasil.com.br/")
    row = next(t for t in listing["traders"] if t["id"] == manager_id)
    assert row["status"] == "pending" and row["credential"] == "CNPI 1234" and row["document"] == "529.982.247-25"
    assert client.get("/admin/credentials", headers=mgr).status_code == 403
    assert client.post(f"/admin/users/{manager_id}/credential", headers=mgr, json={"verified": True}).status_code == 403
    assert client.post(f"/admin/users/{manager_id}/credential", headers=admin, json={"verified": False}).status_code == 422

    # Checked: it publishes, and the buyer sees it checked
    r = client.post(f"/admin/users/{manager_id}/credential", headers=admin, json={"verified": True})
    assert r.status_code == 200 and r.json()["status"] == "verified"
    assert publish().status_code == 200
    slug = next(i["listing"]["slug"] for i in client.get("/me/listings", headers=mgr).json() if i["portfolio"]["id"] == portfolio_id)
    assert client.get(f"/api/marketplace/{slug}").json()["seller"]["credential_verified"] is True

    # Editing the address keeps the check; another credential goes back to the admin, the portfolio stays up
    set_seller(client, mgr, address="Avenida Paulista, 1000, São Paulo/SP")
    assert client.get("/me", headers=mgr).json()["seller"]["credential_status"] == "verified"
    set_seller(client, mgr, credential="CNPI 9999")
    assert client.get("/me", headers=mgr).json()["seller"]["credential_status"] == "pending"
    assert client.get(f"/api/marketplace/{slug}").json()["seller"]["credential_verified"] is False

    # Refused: the reason goes to the trader, the portfolio leaves the vitrine, and it cannot come back
    r = client.post(f"/admin/users/{manager_id}/credential", headers=admin,
                    json={"verified": False, "note": "Número não consta na lista da APIMEC"})
    assert r.status_code == 200 and r.json()["withdrawn"] == 1
    assert client.get(f"/api/marketplace/{slug}").status_code == 404
    trader_email = client.get("/me", headers=mgr).json()["email"]
    assert any(to == trader_email and "Não conseguimos confirmar" in subject for to, subject in sent)
    r = publish()
    assert r.status_code == 409 and "Número não consta" in r.json()["detail"]
