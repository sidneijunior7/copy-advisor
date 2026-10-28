"""Hosted terminals: managers registering them, pods syncing (hosting.py)."""
import datetime
import os
import uuid

import pytest
from cryptography.fernet import Fernet

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402
import hosting  # noqa: E402
import keys  # noqa: E402
import models  # noqa: E402
import server  # noqa: E402
from test_management import make_manager, make_portfolio  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


@pytest.fixture(autouse=True)
def secret(monkeypatch):
    monkeypatch.setenv("HOSTING_SECRET", Fernet.generate_key().decode())
    server.failure_limiter.reset()


def make_license(client, headers, portfolio_id, login=None):
    r = client.post("/licenses", headers=headers, json={"client_mt5_login": login or uuid.uuid4().int % 10**8,
                                                        "max_lots": 1, "portfolio_id": portfolio_id})
    assert r.status_code == 200
    return r.json()


def make_pod(name="pod-a"):
    key = keys.new_key(keys.POD)
    db = database.SessionLocal()
    try:
        db.add(models.HostedPod(name=name, key_hash=keys.key_hash(key), key_prefix=keys.key_prefix(key)))
        db.commit()
    finally:
        db.close()
    return {"Authorization": f"Bearer {key}"}


def sync(client, pod, capacity=10, reports=(), info=None):
    r = client.post("/pods/sync", headers=pod, json={"capacity": capacity, "info": info or {},
                                                     "terminals": list(reports)})
    assert r.status_code == 200, r.text
    return r.json()["terminals"]


def hosted(client, headers, license_id):
    return next(t for t in client.get("/hosting", headers=headers).json()["terminals"] if t["license_id"] == license_id)


def license_hash(license_id):
    db = database.SessionLocal()
    try:
        return db.get(models.License, license_id).key_hash
    finally:
        db.close()


def free_pods():
    """Earlier tests leave pods with room that would take this test's terminals"""
    db = database.SessionLocal()
    try:
        db.query(models.HostedPod).update({models.HostedPod.revoked_at: datetime.datetime.utcnow()})
        db.commit()
    finally:
        db.close()


@pytest.mark.parametrize("value", [None, "b'" + Fernet.generate_key().decode() + "'", "not-a-key"])
def test_hosting_off_without_a_valid_secret(client, monkeypatch, value):
    if value is None:
        monkeypatch.delenv("HOSTING_SECRET")
    else:
        monkeypatch.setenv("HOSTING_SECRET", value)
    manager_id, headers = make_manager()
    portfolio_id, _ = make_portfolio(manager_id)
    lic = make_license(client, headers, portfolio_id)
    r = client.put(f"/licenses/{lic['id']}/hosting", headers=headers, json={"server": "Demo", "password": "x"})
    assert r.status_code == 503
    assert client.get("/hosting", headers=headers).json()["available"] is False
    assert client.post("/pods/sync", json={"capacity": 0}).status_code == 503


def test_secret_with_surrounding_spaces_works(client, monkeypatch):
    monkeypatch.setenv("HOSTING_SECRET", f"  {Fernet.generate_key().decode()}\n")
    assert hosting.cipher() is not None


def test_pod_gets_credentials_and_a_new_license_key(client):
    free_pods()
    manager_id, headers = make_manager()
    portfolio_id, _ = make_portfolio(manager_id)
    lic = make_license(client, headers, portfolio_id)
    old_hash = license_hash(lic["id"])

    assert client.put(f"/licenses/{lic['id']}/hosting", headers=headers, json={"server": "Demo"}).status_code == 422
    r = client.put(f"/licenses/{lic['id']}/hosting", headers=headers, json={
        "server": "Tickmill-Demo", "password": "s3cr3t", "inputs": {"lots_factor": 2, "sltp_mode": "distance"}})
    assert r.status_code == 200
    out = r.json()
    assert out["state"] == "pending" and "password" not in out and "s3cr3t" not in r.text
    assert license_hash(lic["id"]) != old_hash  # The client's own Slave is cut off

    pod = make_pod()
    [t] = sync(client, pod, info={"servers": ["Tickmill-Demo"]})
    assert t["enabled"] and t["server"] == "Tickmill-Demo" and t["login"] == lic["client_mt5_login"]
    assert t["password"] == "s3cr3t"
    assert keys.key_hash(t["license_key"]) == license_hash(lic["id"])
    assert t["inputs"] == {"inp_lots_factor": "2.0", "inp_sltp_mode": "0"}
    listing = client.get("/hosting", headers=headers).json()
    assert listing["servers"] == ["Tickmill-Demo"]
    assert hosted(client, headers, lic["id"])["state"] == "starting"

    sync(client, pod, reports=[{"id": t["id"], "config_version": t["config_version"], "status": "running"}])
    assert hosted(client, headers, lic["id"])["state"] == "running"


def test_hub_session_means_running(client, monkeypatch):
    free_pods()
    manager_id, headers = make_manager()
    portfolio_id, _ = make_portfolio(manager_id)
    lic = make_license(client, headers, portfolio_id)
    client.put(f"/licenses/{lic['id']}/hosting", headers=headers, json={"server": "Demo", "password": "x"})
    sync(client, make_pod("hub"))
    assert hosted(client, headers, lic["id"])["state"] == "starting"
    # The pod has not read the Slave's log yet, but the hub already has the Slave connected
    monkeypatch.setattr(server, "fetch_hub_sessions", lambda: [{"kind": "slave", "license_id": lic["id"]}])
    assert hosted(client, headers, lic["id"])["state"] == "running"


def test_changes_restart_and_disabled_keeps_the_pod(client):
    free_pods()
    manager_id, headers = make_manager()
    portfolio_id, _ = make_portfolio(manager_id)
    lic = make_license(client, headers, portfolio_id)
    client.put(f"/licenses/{lic['id']}/hosting", headers=headers, json={"server": "Demo", "password": "a"})
    pod = make_pod()
    [t] = sync(client, pod)

    client.put(f"/licenses/{lic['id']}/hosting", headers=headers, json={"password": "b"})
    # The report is about the old configuration: ignored
    sync(client, pod, reports=[{"id": t["id"], "config_version": t["config_version"], "status": "running"}])
    assert hosted(client, headers, lic["id"])["state"] == "starting"
    [t2] = sync(client, pod)
    assert t2["config_version"] == t["config_version"] + 1 and t2["password"] == "b"

    client.put(f"/licenses/{lic['id']}/hosting", headers=headers, json={"enabled": False})
    [off] = sync(client, pod)
    assert off == {"id": t["id"], "enabled": False, "config_version": t2["config_version"] + 1}
    assert hosted(client, headers, lic["id"])["state"] == "disabled"

    # Disabled terminals still count as assigned: re-enabled, it comes back to the same pod
    other = make_pod("pod-b")
    assert sync(client, other) == []
    client.put(f"/licenses/{lic['id']}/hosting", headers=headers, json={"enabled": True})
    assert sync(client, other) == []
    assert sync(client, pod)[0]["enabled"] is True

    assert client.delete(f"/licenses/{lic['id']}/hosting", headers=headers).status_code == 200
    assert sync(client, pod) == []  # Left out: the pod deletes the folder


def test_new_license_key_reaches_the_pod(client):
    free_pods()
    manager_id, headers = make_manager()
    portfolio_id, _ = make_portfolio(manager_id)
    lic = make_license(client, headers, portfolio_id)
    client.put(f"/licenses/{lic['id']}/hosting", headers=headers, json={"server": "Demo", "password": "x"})
    pod = make_pod("rotate")
    [before] = sync(client, pod)
    key = client.post(f"/licenses/{lic['id']}/key", headers=headers).json()["license_key"]
    [after] = sync(client, pod)
    assert after["license_key"] == key != before["license_key"]
    assert after["config_version"] == before["config_version"] + 1


def test_capacity_and_one_pod_per_terminal(client):
    free_pods()
    manager_id, headers = make_manager()
    portfolio_id, _ = make_portfolio(manager_id)
    for _ in range(3):
        lic = make_license(client, headers, portfolio_id)
        client.put(f"/licenses/{lic['id']}/hosting", headers=headers, json={"server": "Demo", "password": "x"})
    a, b = make_pod("a"), make_pod("b")
    assert len(sync(client, a, capacity=2)) == 2
    assert len(sync(client, b, capacity=5)) == 1
    assert len(sync(client, a, capacity=2)) == 2  # Already full: keeps its own


def test_pod_key_checks(client):
    assert client.post("/pods/sync", json={"capacity": 1}).status_code == 401
    assert client.post("/pods/sync", headers={"Authorization": "Bearer pod_nope"}, json={"capacity": 1}).status_code == 401
    pod = make_pod("revoked")
    db = database.SessionLocal()
    try:
        db.query(models.HostedPod).filter(models.HostedPod.name == "revoked").update(
            {models.HostedPod.revoked_at: datetime.datetime.utcnow()})
        db.commit()
    finally:
        db.close()
    assert client.post("/pods/sync", headers=pod, json={"capacity": 1}).status_code == 401


def test_offline_pod_and_unreadable_credentials(client, monkeypatch):
    free_pods()
    manager_id, headers = make_manager()
    portfolio_id, _ = make_portfolio(manager_id)
    lic = make_license(client, headers, portfolio_id)
    client.put(f"/licenses/{lic['id']}/hosting", headers=headers, json={"server": "Demo", "password": "x"})
    pod = make_pod("offline")
    sync(client, pod)
    db = database.SessionLocal()
    try:
        db.query(models.HostedPod).filter(models.HostedPod.name == "offline").update(
            {models.HostedPod.last_seen_at: datetime.datetime.utcnow() - datetime.timedelta(minutes=5)})
        db.commit()
    finally:
        db.close()
    assert hosted(client, headers, lic["id"])["state"] == "pod_offline"

    monkeypatch.setenv("HOSTING_SECRET", Fernet.generate_key().decode())  # Rotated: old tokens unreadable
    [t] = sync(client, pod)
    assert t["enabled"] is False and "password" not in t
    assert "HOSTING_SECRET" in hosted(client, headers, lic["id"])["detail"]


def test_only_the_owner_and_valid_inputs(client):
    manager_id, headers = make_manager()
    portfolio_id, _ = make_portfolio(manager_id)
    lic = make_license(client, headers, portfolio_id)
    _, intruder = make_manager()
    assert client.put(f"/licenses/{lic['id']}/hosting", headers=intruder,
                      json={"server": "Demo", "password": "x"}).status_code == 404
    for bad in ({"server": "Demo\nPassword=1", "password": "x"}, {"server": "Demo", "password": "x\ny"},
                {"server": "Demo", "password": "x", "inputs": {"lots_factor": 0}},
                {"server": "Demo", "password": "x", "inputs": {"symbol_map": "A=B\nC"}}):
        assert client.put(f"/licenses/{lic['id']}/hosting", headers=headers, json=bad).status_code == 422, bad
    assert client.get("/hosting", headers=intruder).json()["terminals"] == []


def master_runs_on(manager_id, login):
    db = database.SessionLocal()
    try:
        db.add(models.MasterAccount(manager_id=manager_id, master_login=login, trade_mode="demo"))
        db.commit()
    finally:
        db.close()


def test_a_master_account_is_never_a_slave(client):
    free_pods()
    manager_id, headers = make_manager()
    portfolio_id, _ = make_portfolio(manager_id)
    login = uuid.uuid4().int % 10**8
    master_runs_on(manager_id, login)
    r = client.post("/licenses", headers=headers, json={"client_mt5_login": login, "max_lots": 1, "portfolio_id": portfolio_id})
    assert r.status_code == 409 and f"A conta {login} é a conta de um Master" in r.json()["detail"]

    db = database.SessionLocal()  # The account a portfolio copies from counts too, before its Master ever connects
    try:
        db.get(models.Portfolio, portfolio_id).master_login = login + 1
        db.commit()
    finally:
        db.close()
    r = client.post("/licenses", headers=headers, json={"client_mt5_login": login + 1, "max_lots": 1, "portfolio_id": portfolio_id})
    assert r.status_code == 409

    # A license from before the Master showed up on its account: not hosted, though one already hosted can be stopped
    lic, running = make_license(client, headers, portfolio_id), make_license(client, headers, portfolio_id)
    assert client.put(f"/licenses/{running['id']}/hosting", headers=headers, json={"server": "Demo", "password": "a"}).status_code == 200
    master_runs_on(manager_id, lic["client_mt5_login"])
    master_runs_on(manager_id, running["client_mt5_login"])
    assert client.put(f"/licenses/{lic['id']}/hosting", headers=headers, json={"server": "Demo", "password": "a"}).status_code == 409
    assert client.put(f"/licenses/{running['id']}/hosting", headers=headers, json={"enabled": False}).status_code == 200
    assert client.put(f"/licenses/{running['id']}/hosting", headers=headers, json={"enabled": True}).status_code == 409
    assert client.delete(f"/licenses/{running['id']}/hosting", headers=headers).status_code == 200
