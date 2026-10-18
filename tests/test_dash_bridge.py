"""Bridge to the Trademetric Dash: linking a portfolio by the Dash token and sending the Master's closed trades in
the Dash EA's format (dash_bridge.py). Nothing here reaches a real Dash: send is replaced."""
import datetime
import os
import uuid

import pytest
from cryptography.fernet import Fernet

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import dash_bridge  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import server  # noqa: E402
from test_management import make_manager, make_portfolio  # noqa: E402

NOW = datetime.datetime.utcnow().replace(microsecond=0)


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


@pytest.fixture(autouse=True)
def hosting_secret(monkeypatch):
    monkeypatch.setenv("HOSTING_SECRET", Fernet.generate_key().decode())


def new_token():
    return "tc_" + uuid.uuid4().hex + uuid.uuid4().hex[:16]


class FakeDash:
    """Answers like the Dash ingest and keeps what it got, per token."""

    def __init__(self, status=201):
        self.status = status
        self.calls = []

    def __call__(self, token, items):
        self.calls.append((token, items))
        return self.status, '{"error": "Invalid or expired API token"}' if self.status == 401 else "{}"

    def items(self, token):
        return [i for t, items in self.calls if t == token for i in items]


def linked(client, monkeypatch, history_days=0):
    manager_id, mgr = make_manager()
    portfolio_id, strategy_id = make_portfolio(manager_id, with_strategy=True)
    token = new_token()
    monkeypatch.setattr(dash_bridge, "send", FakeDash())
    r = client.put(f"/portfolios/{portfolio_id}/dash", headers=mgr, json={"token": token, "history_days": history_days})
    assert r.status_code == 200, r.text
    db = database.SessionLocal()
    try:
        magic = db.get(models.Strategy, strategy_id).magic_number
    finally:
        db.close()
    return manager_id, mgr, portfolio_id, magic, token


def seed_deals(manager_id, magic, login):
    """Position 1 (a buy, entry commission 2) closed in two parts after the link was made; another strategy's
    trade; a deposit; a sale closed 10 days ago. Returns the time the closes are counted from."""
    base = datetime.datetime.utcnow().replace(microsecond=0)
    db = database.SessionLocal()
    try:
        def deal(deal_id, pos_id, entry, kind, volume, price, profit, commission, at, deal_magic=magic):
            db.add(models.MasterDeal(manager_id=manager_id, master_login=login, deal_id=deal_id, pos_id=pos_id, entry=entry,
                                     type=kind, symbol="EURUSD", magic=deal_magic, volume=volume, price=price, profit=profit,
                                     swap=0, commission=commission, time=at))
        minutes = lambda n: base + datetime.timedelta(minutes=n)
        deal(10, 1, 0, 0, 1.0, 1.1000, 0, -2.0, minutes(-120))  # Entries count whenever they happened
        deal(11, 1, 1, 1, 0.4, 1.1050, 20.0, -0.8, minutes(1))
        deal(12, 1, 1, 1, 0.6, 1.1100, 60.0, -1.2, minutes(2))
        deal(20, 2, 0, 1, 1.0, 1.2, 0, 0, minutes(-60), deal_magic=magic + 1)
        deal(21, 2, 1, 0, 1.0, 1.1, 100.0, 0, minutes(3), deal_magic=magic + 1)
        deal(30, 0, 0, 2, 0, 0, 5000.0, 0, minutes(1), deal_magic=0)  # A deposit
        deal(40, 4, 0, 1, 1.0, 1.3, 0, 0, minutes(-11 * 1440))
        deal(41, 4, 1, 0, 1.0, 1.2, 100.0, 0, minutes(-10 * 1440))
        db.commit()
    finally:
        db.close()
    return base


def link_row(portfolio_id):
    db = database.SessionLocal()
    try:
        return db.query(models.DashLink).filter_by(portfolio_id=portfolio_id).one()
    finally:
        db.close()


def test_linking_checks_the_token_with_the_dash(client, monkeypatch):
    manager_id, mgr = make_manager()
    portfolio_id, _ = make_portfolio(manager_id, with_strategy=True)
    url = f"/portfolios/{portfolio_id}/dash"
    assert client.get(url, headers=mgr).json() == {"available": True, "link": None}
    assert client.put(url, headers=mgr, json={"token": "abc"}).status_code == 422
    monkeypatch.setattr(dash_bridge, "send", FakeDash(status=401))
    r = client.put(url, headers=mgr, json={"token": new_token()})
    assert r.status_code == 422 and "revogado" in r.json()["detail"]
    monkeypatch.setattr(dash_bridge, "send", FakeDash(status=0))
    assert client.put(url, headers=mgr, json={"token": new_token()}).status_code == 502
    dash = FakeDash()
    monkeypatch.setattr(dash_bridge, "send", dash)
    token = new_token()
    r = client.put(url, headers=mgr, json={"token": token, "history_days": 30})
    assert r.status_code == 200 and r.json()["token_hint"] == token[-4:] and r.json()["status"] == "active"
    assert dash.calls == [(token, [])]  # Only the check: nothing to ingest
    assert token not in link_row(portfolio_id).token_encrypted  # Kept encrypted
    _, other = make_manager()
    assert client.get(url, headers=other).status_code == 404
    assert client.put(url, headers=mgr, json={"token": token, "history_days": 91}).status_code == 422
    assert client.delete(url, headers=mgr).status_code == 200
    assert client.get(url, headers=mgr).json()["link"] is None


def test_without_the_secret_there_is_no_link(client, monkeypatch):
    manager_id, mgr = make_manager()
    portfolio_id, _ = make_portfolio(manager_id, with_strategy=True)
    monkeypatch.delenv("HOSTING_SECRET")
    assert client.get(f"/portfolios/{portfolio_id}/dash", headers=mgr).json()["available"] is False
    assert client.put(f"/portfolios/{portfolio_id}/dash", headers=mgr, json={"token": new_token()}).status_code == 503


def test_closed_trades_go_once_in_the_dash_ea_format(client, monkeypatch):
    manager_id, _, portfolio_id, magic, token = linked(client, monkeypatch)
    login = uuid.uuid4().int % 10**9
    base = seed_deals(manager_id, magic, login)
    dash = FakeDash()
    dash_bridge.run_once(post=dash)
    first, second = dash.items(token)
    assert first == {
        "strategy_id": str(magic), "symbol": "EURUSD", "side": "LONG", "entry_price": 1.1, "exit_price": 1.105,
        "quantity": 0.4, "pnl": 20.0, "fees": -1.6,  # Its commission and 40% of the entry commission
        "duration": 7260, "traded_at": (base + datetime.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "external_id": f"mirror:{login}:11", "source": "mirror"}
    assert (second["quantity"], second["fees"], second["external_id"]) == (0.6, -2.4, f"mirror:{login}:12")
    row = link_row(portfolio_id)
    assert row.sent_count == 2 and row.last_sent_at is not None and row.deal_cursor > 0
    dash_bridge.run_once(post=dash)
    assert len(dash.items(token)) == 2  # Nothing twice


def test_history_goes_when_asked(client, monkeypatch):
    manager_id, _, _, magic, token = linked(client, monkeypatch, history_days=30)
    seed_deals(manager_id, magic, uuid.uuid4().int % 10**9)
    dash = FakeDash()
    dash_bridge.run_once(post=dash)
    assert len(dash.items(token)) == 3  # The trade of 10 days ago too
    assert dash.items(token)[-1]["side"] == "SHORT"


def test_a_refused_token_stops_the_link_until_retry(client, monkeypatch):
    manager_id, _, portfolio_id, magic, token = linked(client, monkeypatch)
    seed_deals(manager_id, magic, uuid.uuid4().int % 10**9)
    refused = FakeDash(status=402)
    dash_bridge.run_once(post=refused)
    row = link_row(portfolio_id)
    assert row.status == "error" and "plano" in row.last_error and row.sent_count == 0
    dash_bridge.run_once(post=refused)
    assert len([c for c in refused.calls if c[0] == token]) == 1  # Not before ERROR_RETRY_SECONDS
    dash = FakeDash()
    dash_bridge.run_once(post=dash, now=NOW + datetime.timedelta(seconds=dash_bridge.ERROR_RETRY_SECONDS + 60))
    assert len(dash.items(token)) == 2 and link_row(portfolio_id).status == "active"


def test_a_dash_that_fails_gets_the_same_trades_again(client, monkeypatch):
    manager_id, _, portfolio_id, magic, token = linked(client, monkeypatch)
    seed_deals(manager_id, magic, uuid.uuid4().int % 10**9)
    dash_bridge.run_once(post=FakeDash(status=500))
    row = link_row(portfolio_id)
    assert row.status == "active" and "500" in row.last_error and row.sent_count == 0
    dash = FakeDash()
    dash_bridge.run_once(post=dash)
    assert len(dash.items(token)) == 2 and link_row(portfolio_id).last_error is None
