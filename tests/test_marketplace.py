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
from test_management import make_manager, make_portfolio  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


LISTING = {"title": "Tendência no Índice", "summary": "Mini índice, tendência", "description": "Linha 1\nLinha 2",
           "markets": ["B3"], "price": 197.0, "checkout_url": "https://pay.example.com/abc", "default_days": 30,
           "default_max_lots": 2, "min_capital": 5000}


def published(client, title=LISTING["title"]):
    manager_id, mgr = make_manager()
    portfolio_id, _ = make_portfolio(manager_id, with_strategy=True)
    assert client.put("/me/profile", headers=mgr, json={"name": "Gestor Teste", "bio": "Opera índice"}).status_code == 200
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
    assert "portfolio_id" not in detail and detail["stats"]["trades"] == 0
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
    assert client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=mgr, json={"mt5_login": login}).status_code == 403
    r = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"mt5_login": login, "note": "Paguei"})
    assert r.status_code == 200 and r.json()["status"] == "pending" and r.json()["kind"] == "new"
    assert r.json()["listing"]["checkout_url"] == LISTING["checkout_url"]
    assert client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"mt5_login": login}).status_code == 409

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


def test_reject_cancel_and_someone_elses_account(client):
    _, mgr, portfolio_id, listing = published(client, title=f"Recusa {uuid.uuid4().hex[:6]}")
    cli, _ = client_headers(client)
    other, _ = client_headers(client)
    a = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"mt5_login": 111}).json()
    b = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"mt5_login": 222}).json()
    r = client.post(f"/subscriptions/{a['id']}/reject", headers=mgr, json={"note": "Conta errada"})
    assert r.json()["status"] == "rejected" and r.json()["decision_note"] == "Conta errada"
    assert client.post(f"/me/subscriptions/{b['id']}/cancel", headers=other).status_code == 404
    assert client.post(f"/me/subscriptions/{b['id']}/cancel", headers=cli).json()["status"] == "cancelled"
    assert client.post(f"/subscriptions/{b['id']}/approve", headers=mgr, json={}).status_code == 409
    # An account already licensed to another client cannot be taken over by asking for it
    c = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"mt5_login": 333}).json()
    client.post(f"/subscriptions/{c['id']}/approve", headers=mgr, json={})
    r = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=other, json={"mt5_login": 333})
    assert r.status_code == 409


def test_cancel_and_ask_again_is_limited_per_day(client, monkeypatch):
    _, _, _, listing = published(client, title=f"Limite {uuid.uuid4().hex[:6]}")
    cli, _ = client_headers(client)
    monkeypatch.setattr(server, "subscribe_limiter", server.FailureLimiter(2, 86400))
    for _ in range(2):
        sub = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"mt5_login": 444}).json()
        client.post(f"/me/subscriptions/{sub['id']}/cancel", headers=cli)
    r = client.post(f"/api/marketplace/{listing['slug']}/subscribe", headers=cli, json={"mt5_login": 444})
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
