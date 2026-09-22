import datetime
import os

import pytest

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
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
