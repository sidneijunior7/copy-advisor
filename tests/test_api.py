import datetime
import logging
import os
import threading
import time

import pytest
from sqlalchemy.exc import OperationalError
from starlette.websockets import WebSocketDisconnect

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import migrate  # noqa: E402
import models  # noqa: E402
import server  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


def test_health_reports_hub_without_failing(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "degraded" and body["hub"]["status"] == "unreachable"


def test_dead_database_is_reported_without_details_and_liveness_stays_up(client):
    class Broken:
        def query(self, *_):
            raise RuntimeError("could not connect to db.internal as user secret_user")

    server.app.dependency_overrides[server.get_session] = lambda: Broken()
    try:
        r = client.get("/health")
        assert r.status_code == 503
        assert r.json()["database"] == "unavailable" and "secret_user" not in r.text
        assert client.get("/health/live").json() == {"status": "alive"}
    finally:
        server.app.dependency_overrides.pop(server.get_session)


def test_ws_state_comes_from_open_master_positions(client):
    db = database.SessionLocal()
    try:
        manager = models.User(email="state@x.com", password_hash="x", role="MANAGER")
        db.add(manager)
        db.flush()
        strategy = models.Strategy(user_id=manager.id, name="Scalper", magic_number=777)
        db.add(strategy)
        db.flush()
        now = datetime.datetime.utcnow()
        db.add_all([
            models.MasterPosition(manager_id=manager.id, strategy_id=strategy.id, master_login=11, pos_id=1,
                                  symbol="EURUSD", type=0, volume=1.0, price_open=1.1, sl=0, tp=0, magic=777,
                                  opened_at=now, updated_at=now),
            models.MasterPosition(manager_id=manager.id, strategy_id=strategy.id, master_login=11, pos_id=2,
                                  symbol="EURUSD", type=1, volume=1.0, price_open=1.1, sl=0, tp=0, magic=777,
                                  opened_at=now, updated_at=now, closed_at=now),
        ])
        db.commit()
        strategy_id = strategy.id
    finally:
        db.close()

    token = auth.create_access_token({"sub": "state@x.com", "role": "MANAGER"})
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "AUTH", "token": token})
        msg = ws.receive_json()
    assert msg["type"] == "STATE"
    key = f"{strategy_id}_11_1"
    assert key in msg["trades"] and f"{strategy_id}_11_2" not in msg["trades"]
    assert msg["trades"][key]["strategy_name"] == "Scalper"


# --- Database outages (AUDITORIA_PERFORMANCE.md, P0.3 to P0.5) ---

AUTH = {"Authorization": "Bearer whatever"}


def database_down():
    return OperationalError("SELECT 1", {}, Exception("connection to server at db.internal failed"))


def test_liveness_answers_while_a_request_waits_for_the_database(client, monkeypatch):
    """Inside async def, a blocked database call stalled the event loop, /health/live included,
    until Docker restarted the API."""
    def slow_lookup(token, db):
        time.sleep(1.5)
        return None

    monkeypatch.setattr(server, "user_from_token", slow_lookup)
    slow = threading.Thread(target=client.get, args=("/licenses",), kwargs={"headers": AUTH})
    slow.start()
    try:
        time.sleep(0.3)
        started = time.monotonic()
        assert client.get("/health/live").status_code == 200
        assert time.monotonic() - started < 0.5
    finally:
        slow.join()


def test_database_outage_answers_503_with_one_log_line(client, monkeypatch, caplog):
    monkeypatch.setattr(server, "database_outage", server.OutageLog())

    def down(token, db):
        raise database_down()

    monkeypatch.setattr(server, "user_from_token", down)
    with caplog.at_level(logging.ERROR):
        for _ in range(3):
            r = client.get("/licenses", headers=AUTH)
            assert r.status_code == 503 and "db.internal" not in r.text
    reports = [rec.getMessage() for rec in caplog.records if "Database unavailable" in rec.getMessage()]
    assert len(reports) == 1 and "/licenses" in reports[0]
    assert not any(rec.exc_info for rec in caplog.records)


def test_outage_log_folds_repeats_into_the_next_report(caplog):
    now = [0.0]
    log = server.OutageLog(every=60, clock=lambda: now[0])
    with caplog.at_level(logging.ERROR):
        assert log("/x", RuntimeError("first")) is True
        now[0] = 30
        assert log("/x", RuntimeError("second")) is False
        now[0] = 61
        assert log("/x", RuntimeError("third")) is True
    assert "1 more since the last report" in caplog.records[-1].getMessage()


def test_dashboard_is_told_to_try_later_while_the_database_is_down(client, monkeypatch):
    monkeypatch.setattr(server, "database_outage", server.OutageLog())

    def down(token):
        raise database_down()

    monkeypatch.setattr(server, "ws_session", down)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "AUTH", "token": "x"})
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == server.WS_CLOSE_TRY_LATER


def test_data_routes_wait_for_the_startup_migration(client, monkeypatch):
    monkeypatch.setattr(server.schema, "state", "pending")
    assert client.get("/licenses", headers=AUTH).status_code == 503
    assert client.get("/me/master-keys", headers=AUTH).status_code == 503
    assert client.get("/health/live").status_code == 200
    r = client.get("/health")
    assert r.status_code == 503 and r.json()["status"] == "starting" and r.json()["schema"] == "pending"
    with client.websocket_connect("/ws") as ws:
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == server.WS_CLOSE_TRY_LATER


def test_startup_migration_retries_until_the_database_answers(monkeypatch):
    calls = []

    def flaky(retries):
        calls.append(retries)
        if len(calls) < 3:
            raise database_down()

    monkeypatch.setattr(migrate, "main", flaky)
    monkeypatch.setattr(server, "database_outage", server.OutageLog())
    monkeypatch.setattr(server.schema, "state", "pending")
    waits = []
    server.migrate_in_background(sleep=waits.append)
    assert calls == [1, 1, 1] and waits == [2.0, 4.0] and server.schema.state == "ready"


def test_a_broken_migration_keeps_data_routes_unavailable(monkeypatch):
    def broken(retries):
        raise RuntimeError("duplicate magic numbers")

    monkeypatch.setattr(migrate, "main", broken)
    monkeypatch.setattr(server.schema, "state", "pending")
    server.migrate_in_background(sleep=lambda _: None)
    assert server.schema.state == "failed"


def test_container_comes_up_before_the_migration_finishes(monkeypatch):
    done = threading.Event()
    monkeypatch.setattr(migrate, "main", lambda retries: done.wait(5))
    monkeypatch.setenv("MIGRATE_ON_START", "1")
    monkeypatch.setattr(server.schema, "state", "ready")
    with TestClient(server.app) as c:
        assert c.get("/health/live").status_code == 200
        assert c.get("/licenses", headers=AUTH).status_code == 503
        done.set()
        deadline = time.monotonic() + 3
        while not server.schema.ready and time.monotonic() < deadline:
            time.sleep(0.05)
        assert c.get("/licenses", headers=AUTH).status_code == 401
