"""Client accounts: sign-up, access codes, a client's own licenses, settings within limits, copies (clients.py)."""
import datetime
import os
import uuid

import pytest
from cryptography.fernet import Fernet

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import clients  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import server  # noqa: E402
from test_hosting import make_pod, sync  # noqa: E402
from test_management import make_manager, make_portfolio  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


@pytest.fixture(autouse=True)
def fresh_limits(monkeypatch):
    monkeypatch.setenv("HOSTING_SECRET", Fernet.generate_key().decode())
    server.failure_limiter.reset()
    server.signup_limiter.reset()


def signup(client, email=None, password="s3nha-forte", name="Cliente"):
    email = email or f"{uuid.uuid4().hex[:10]}@cliente.com"
    r = client.post("/register", json={"email": email, "password": password, "name": name})
    return r, email


def client_headers(client, **kw):
    r, email = signup(client, **kw)
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}, email


def manager_license(client):
    manager_id, headers = make_manager()
    portfolio_id, _ = make_portfolio(manager_id)
    r = client.post("/licenses", headers=headers, json={"client_mt5_login": uuid.uuid4().int % 10**8, "max_lots": 1,
                                                        "portfolio_id": portfolio_id})
    return manager_id, headers, portfolio_id, r.json()


def claimed_license(client):
    manager_id, mgr, portfolio_id, lic = manager_license(client)
    cli, email = client_headers(client)
    code = client.post(f"/licenses/{lic['id']}/claim-code", headers=mgr).json()["code"]
    assert client.post("/me/licenses/claim", headers=cli, json={"code": code}).status_code == 200
    return manager_id, mgr, portfolio_id, lic, cli, email


def test_signup_rules(client):
    r, email = signup(client)
    assert r.status_code == 200
    me = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert client.get("/me/licenses", headers=me).json()["licenses"] == []
    assert signup(client, email=email.upper())[0].status_code == 409  # Same email, other case
    assert signup(client, email="sem-arroba")[0].status_code == 422
    assert signup(client, password="curta")[0].status_code == 422
    # Logging in ignores the case of the email
    r = client.post("/token", data={"username": email.upper(), "password": "s3nha-forte"})
    assert r.status_code == 200


def test_signup_rate_limit(client):
    for _ in range(server.signup_limiter.max_failures):
        assert signup(client)[0].status_code == 200
    assert signup(client)[0].status_code == 429


def test_access_code_links_once(client):
    _, mgr, _, lic = manager_license(client)
    cli, email = client_headers(client)
    code = client.post(f"/licenses/{lic['id']}/claim-code", headers=mgr).json()["code"]
    assert len(code) == 14 and code.count("-") == 2
    # Typed in lower case and without dashes, it still works
    r = client.post("/me/licenses/claim", headers=cli, json={"code": code.replace("-", "").lower()})
    assert r.status_code == 200
    assert r.json()["mt5_login"] == lic["client_mt5_login"] and r.json()["valid"]
    assert client.post("/me/licenses/claim", headers=cli, json={"code": code}).status_code == 404  # Used up

    listed = [l for l in client.get("/licenses", headers=mgr).json() if l["id"] == lic["id"]][0]
    assert listed["client"]["email"] == email and listed["claim_expires_at"] is None

    r = client.delete(f"/licenses/{lic['id']}/client", headers=mgr)
    assert r.status_code == 200 and r.json()["client"] is None
    assert client.get("/me/licenses", headers=cli).json()["licenses"] == []


def test_expired_and_guessed_codes(client):
    _, mgr, _, lic = manager_license(client)
    cli, _ = client_headers(client)
    code = client.post(f"/licenses/{lic['id']}/claim-code", headers=mgr).json()["code"]
    db = database.SessionLocal()
    try:
        db.get(models.License, lic["id"]).claim_expires_at = datetime.datetime.utcnow() - datetime.timedelta(seconds=1)
        db.commit()
    finally:
        db.close()
    assert client.post("/me/licenses/claim", headers=cli, json={"code": code}).status_code == 404
    for _ in range(server.failure_limiter.max_failures - 1):
        assert client.post("/me/licenses/claim", headers=cli, json={"code": "AAAA-BBBB-CCCC"}).status_code == 404
    assert client.post("/me/licenses/claim", headers=cli, json={"code": "AAAA-BBBB-CCCC"}).status_code == 429


def test_each_side_sees_only_its_own(client):
    _, mgr, _, lic, cli, _ = claimed_license(client)
    other, _ = client_headers(client)
    for path in (f"/me/licenses/{lic['id']}/copies", f"/me/licenses/{lic['id']}/issues"):
        assert client.get(path, headers=other).status_code == 404
        assert client.get(path, headers=mgr).status_code == 403
    assert client.put(f"/me/licenses/{lic['id']}/settings", headers=other, json={}).status_code == 404
    assert client.get("/me/licenses", headers=mgr).status_code == 403
    assert client.get("/licenses", headers=cli).status_code == 403
    assert client.post(f"/licenses/{lic['id']}/claim-code", headers=cli).status_code == 403


def test_settings_within_limits(client):
    _, mgr, portfolio_id, lic, cli, _ = claimed_license(client)
    # The manager sets a field clients cannot touch; the client's changes keep it
    assert client.put(f"/licenses/{lic['id']}/settings", headers=mgr,
                      json={"late_max_deviation_points": 300}).status_code == 200
    r = client.put(f"/me/licenses/{lic['id']}/settings", headers=cli, json={"lots_factor": 2})
    assert r.status_code == 422 and "entre 0,01 e 1" in r.json()["detail"]  # Default limits: up to 1x
    assert client.put(f"/portfolios/{portfolio_id}/limits", headers=mgr, json={
        "factor_min": 0.5, "factor_max": 3, "sizing_modes": ["factor", "balance"], "sltp_modes": ["distance"]}).status_code == 200
    assert client.put(f"/me/licenses/{lic['id']}/settings", headers=cli,
                      json={"lots_factor": 2, "sltp_mode": "price"}).status_code == 422
    assert client.put(f"/me/licenses/{lic['id']}/settings", headers=cli,
                      json={"lots_factor": 2, "sizing_mode": "equity", "reference_capital": 5000}).status_code == 422
    assert client.put(f"/me/licenses/{lic['id']}/settings", headers=cli,
                      json={"lots_factor": 2, "sizing_mode": "balance"}).status_code == 422  # Needs the capital
    r = client.put(f"/me/licenses/{lic['id']}/settings", headers=cli,
                   json={"lots_factor": 2, "sizing_mode": "balance", "reference_capital": 5000, "symbol_map": "WIN$=WINZ26"})
    assert r.status_code == 200
    assert r.json()["settings"] == {"sizing_mode": "balance", "lots_factor": 2.0, "reference_capital": 5000.0,
                                    "sltp_mode": "distance", "symbol_map": "WIN$=WINZ26", "suffix_map": None}
    assert r.json()["limits"]["factor_max"] == 3
    stored = [l for l in client.get("/licenses", headers=mgr).json() if l["id"] == lic["id"]][0]["settings"]
    assert stored["late_max_deviation_points"] == 300 and stored["lots_factor"] == 2.0
    bad_limits = {"factor_min": 3, "factor_max": 1}
    assert client.put(f"/portfolios/{portfolio_id}/limits", headers=mgr, json=bad_limits).status_code == 422


def test_client_hosts_its_own_license(client):
    db = database.SessionLocal()
    try:
        db.query(models.HostedPod).update({models.HostedPod.revoked_at: datetime.datetime.utcnow()})
        db.commit()
    finally:
        db.close()
    _, mgr, _, lic, cli, _ = claimed_license(client)
    r = client.post(f"/me/licenses/{lic['id']}/key", headers=cli)
    assert r.status_code == 200 and r.json()["license_key"].startswith("lic_")
    r = client.put(f"/me/licenses/{lic['id']}/hosting", headers=cli, json={"server": "Tickmill-Demo", "password": "p4ss"})
    assert r.status_code == 200 and "p4ss" not in r.text
    pod = make_pod("client-pod")
    [t] = sync(client, pod)
    assert t["password"] == "p4ss" and t["login"] == lic["client_mt5_login"]
    client.put(f"/me/licenses/{lic['id']}/settings", headers=cli, json={"lots_factor": 0.5})
    [t2] = sync(client, pod)
    # The running Slave gets it from the hub (CFG): no restart, but the .set the pod writes next time has it too
    assert t2["config_version"] == t["config_version"] and t2["inputs"]["inp_lots_factor"] == "0.5"
    view = client.get("/me/licenses", headers=cli).json()["licenses"][0]
    assert view["hosting"]["server"] == "Tickmill-Demo" and "pod" not in view["hosting"]
    assert client.post(f"/me/licenses/{lic['id']}/key", headers=cli).status_code == 409  # The pod has the key
    assert client.delete(f"/me/licenses/{lic['id']}/hosting", headers=cli).status_code == 200
    assert sync(client, pod) == []


def test_copies_from_execution_reports(client):
    manager_id, _, portfolio_id, lic, cli, _ = claimed_license(client)
    login = lic["client_mt5_login"]
    now = datetime.datetime.utcnow()
    db = database.SessionLocal()
    try:
        strategy = models.Strategy(user_id=manager_id, name="S", magic_number=uuid.uuid4().int % 10**9)
        db.add(strategy)
        db.flush()
        for pos_id, type_ in ((11, 0), (12, 1), (13, 0)):
            db.add(models.MasterPosition(manager_id=manager_id, strategy_id=strategy.id, master_login=777, pos_id=pos_id,
                                         symbol="BTCUSD", type=type_, volume=1, price_open=100))

        def ex(uid, action, volume, price, rc=10009, ago=60):
            db.add(models.Execution(uid=uid, portfolio_id=portfolio_id, mt5_login=login, action=action, volume=volume,
                                    price=price, retcode=rc, created_at=now - datetime.timedelta(seconds=ago)))
        ex("777_11", "OPEN", 0.10, 100, ago=300)
        ex("777_11", "PARTIAL", 0.05, 104, ago=200)
        ex("777_11", "CLOSE", 0.05, 110, ago=100)
        ex("777_12", "OPEN", 0.10, 200, ago=250)  # A sell still open
        ex("777_13", "OPEN", 0.20, 0, rc=10019, ago=50)  # Refused: no margin
        ex("777_99", "OPEN", 0.10, 50, ago=86400 * 40)  # Outside the window
        db.commit()
    finally:
        db.close()

    rows = {c["uid"]: c for c in client.get(f"/me/licenses/{lic['id']}/copies", headers=cli).json()}
    assert set(rows) == {"777_11", "777_12", "777_13"}
    closed = rows["777_11"]
    assert closed["status"] == "closed" and closed["type"] == "buy" and closed["symbol"] == "BTCUSD"
    assert closed["open_price"] == 100 and closed["close_price"] == pytest.approx(107) and closed["result"] == pytest.approx(7)
    assert rows["777_12"]["status"] == "open" and rows["777_12"]["type"] == "sell" and rows["777_12"]["result"] is None
    assert rows["777_13"]["status"] == "failed" and rows["777_13"]["failures"] == 1
    issues = client.get(f"/me/licenses/{lic['id']}/issues", headers=cli).json()
    assert [i["retcode"] for i in issues] == [10019]


def test_client_downloads_only_the_slave(client):
    cli, _ = client_headers(client)
    releases = client.get("/ea/releases", headers=cli).json()
    assert "master" not in releases
    assert client.get("/ea/releases/master", headers=cli).status_code == 404


def test_claim_code_format():
    code = clients.new_claim_code()
    assert all(c in clients.CLAIM_ALPHABET for c in code.replace("-", ""))
    assert clients.claim_hash(code) == clients.claim_hash(f" {code.lower()} ")


def test_client_dashboard_lead(client):
    cli, _ = client_headers(client)
    r = client.get("/me/dashboard", headers=cli)
    assert r.status_code == 200
    data = r.json()
    assert data["is_lead"] is True
    assert data["profit_today"] == 0.0
    assert data["traders"] == []


def test_client_pause_toggle_and_master(client):
    _, _, _, lic, cli, _ = claimed_license(client)

    # Initially not paused
    dash = client.get("/me/dashboard", headers=cli).json()
    assert dash["is_lead"] is False
    assert len(dash["traders"]) == 1
    assert dash["traders"][0]["is_paused"] is False
    assert dash["all_paused"] is False

    # Pause this license
    r = client.put(f"/me/licenses/{lic['id']}/pause", headers=cli, json={"paused": True})
    assert r.status_code == 200
    assert r.json()["is_paused"] is True
    assert r.json()["paused_at"] is not None

    # Check in dashboard
    dash = client.get("/me/dashboard", headers=cli).json()
    assert dash["traders"][0]["is_paused"] is True
    assert dash["all_paused"] is True

    # Master toggle: resume all
    r = client.post("/me/licenses/pause-all", headers=cli, json={"paused": False})
    assert r.status_code == 200 and r.json()["count"] >= 1
    dash = client.get("/me/dashboard", headers=cli).json()
    assert dash["traders"][0]["is_paused"] is False
    assert dash["all_paused"] is False

    # Master toggle: pause all
    r = client.post("/me/licenses/pause-all", headers=cli, json={"paused": True})
    assert r.status_code == 200
    dash = client.get("/me/dashboard", headers=cli).json()
    assert dash["traders"][0]["is_paused"] is True
    assert dash["all_paused"] is True



def test_client_dashboard_currency_per_account(client):
    """Each copy in its own account's currency; the totals in the currency of the accounts that traded, not of
    whichever account reported last (a BRL result was shown as USD beside a USD account without trades)."""
    manager_id, mgr, portfolio_id, brl = manager_license(client)
    usd = client.post("/licenses", headers=mgr, json={"client_mt5_login": uuid.uuid4().int % 10**8, "max_lots": 1,
                                                      "portfolio_id": portfolio_id}).json()
    cli, _ = client_headers(client)
    for lic in (brl, usd):
        code = client.post(f"/licenses/{lic['id']}/claim-code", headers=mgr).json()["code"]
        assert client.post("/me/licenses/claim", headers=cli, json={"code": code}).status_code == 200
    now = datetime.datetime.utcnow()
    hour = now.replace(minute=0, second=0, microsecond=0)
    db = database.SessionLocal()
    try:
        for uid, action, profit in (("31_1", "OPEN", 0.0), ("31_1", "CLOSE", 162.0)):
            db.add(models.Execution(uid=uid, portfolio_id=portfolio_id, mt5_login=brl["client_mt5_login"], action=action,
                                    volume=1, price=100, retcode=10009, profit=profit,
                                    created_at=now - datetime.timedelta(hours=1)))
        db.add(models.AccountSnapshot(kind="slave", owner_id=brl["id"], login=brl["client_mt5_login"],
                                      hour=hour - datetime.timedelta(hours=2), balance=1000, equity=1000, currency="BRL"))
        db.add(models.AccountSnapshot(kind="slave", owner_id=usd["id"], login=usd["client_mt5_login"],
                                      hour=hour, balance=500, equity=500, currency="USD"))  # The latest, no trades
        db.commit()
    finally:
        db.close()
    dash = client.get("/me/dashboard", headers=cli).json()
    assert dash["currency"] == "BRL" and dash["profit_week"] == 162.0
    assert {t["license_id"]: t["currency"] for t in dash["traders"]} == {brl["id"]: "BRL", usd["id"]: "USD"}
