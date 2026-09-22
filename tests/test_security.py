"""Phase 1 of AUDITORIA.md: SEC-01, SEC-03, SEC-04, SEC-05, SEC-07, SEC-09."""
import asyncio
import datetime
import os
import subprocess
import sys
import uuid

import pytest

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402
from passlib.context import CryptContext  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import server  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASSWORD = "correct horse battery"


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


def make_user(role="MANAGER", status="active", password_hash=None):
    db = database.SessionLocal()
    try:
        user = models.User(email=f"{uuid.uuid4().hex}@x.com", role=role, status=status,
                           password_hash=password_hash or auth.get_password_hash(PASSWORD))
        db.add(user)
        db.commit()
        return user.id, user.email
    finally:
        db.close()


def token_for(email, role="MANAGER", **kwargs):
    return auth.create_access_token({"sub": email, "role": role}, **kwargs)


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def add_open_position(manager_id, pos_id):
    db = database.SessionLocal()
    try:
        strategy = models.Strategy(user_id=manager_id, name=f"S{pos_id}", magic_number=pos_id)
        db.add(strategy)
        db.flush()
        now = datetime.datetime.utcnow()
        db.add(models.MasterPosition(manager_id=manager_id, strategy_id=strategy.id, master_login=1, pos_id=pos_id,
                                     symbol="EURUSD", type=0, volume=1.0, price_open=1.1, sl=0, tp=0, magic=pos_id,
                                     opened_at=now, updated_at=now))
        db.commit()
        return f"{strategy.id}_1_{pos_id}"
    finally:
        db.close()


# --- SEC-03 ---

@pytest.mark.parametrize("value", [None, "dev_secret_key", "change-me", "short"])
def test_api_refuses_to_start_without_a_strong_secret_key(value, tmp_path):
    env = {k: v for k, v in os.environ.items() if k != "SECRET_KEY"}
    if value is not None:
        env["SECRET_KEY"] = value
    # cwd without a .env, so load_dotenv can't supply one
    result = subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {ROOT!r}); import auth"],
                            cwd=tmp_path, env=env, capture_output=True, text=True)
    assert result.returncode != 0 and "SECRET_KEY" in result.stderr


# --- SEC-04 / SEC-05 ---

def test_no_account_is_seeded_on_startup(client):
    db = database.SessionLocal()
    try:
        assert db.query(models.User).filter(models.User.email == "dev@trademetric.com").count() == 0
    finally:
        db.close()


def test_new_hashes_are_bcrypt():
    hashed = auth.get_password_hash(PASSWORD)
    assert hashed.startswith("$2b$")
    assert auth.verify_password(PASSWORD, hashed) == (True, False)
    assert auth.verify_password("wrong password", hashed) == (False, False)
    assert auth.verify_password("x" * 100, hashed) == (False, False)  # bcrypt>=5 would raise


def test_passwords_too_short_or_too_long_are_rejected():
    for bad in ["short", "é" * 40]:  # 80 bytes: bcrypt would silently ignore the tail
        with pytest.raises(ValueError):
            auth.get_password_hash(bad)


def test_login_upgrades_legacy_hash_to_bcrypt(client):
    legacy = CryptContext(schemes=["sha256_crypt"]).hash(PASSWORD)
    user_id, email = make_user(password_hash=legacy)
    r = client.post("/token", data={"username": email, "password": PASSWORD})
    assert r.status_code == 200
    db = database.SessionLocal()
    try:
        assert db.get(models.User, user_id).password_hash.startswith("$2b$")
    finally:
        db.close()
    assert client.post("/token", data={"username": email, "password": PASSWORD}).status_code == 200


def test_disabled_hash_never_logs_in(client):
    _, email = make_user(password_hash="!disabled:leaked-credential")
    assert client.post("/token", data={"username": email, "password": PASSWORD}).status_code == 401


def test_migration_disables_the_leaked_admin_passwords(tmp_path):
    url = "sqlite:///" + str(tmp_path / "leak.db").replace("\\", "/")
    env = dict(os.environ, DATABASE_URL=url)

    def alembic(*args):
        subprocess.run([sys.executable, "-m", "alembic", *args], cwd=ROOT, env=env, check=True, capture_output=True)

    alembic("upgrade", "0002_signals")
    legacy = CryptContext(schemes=["sha256_crypt"])
    seeded = "$5$rounds=535000$Y2Q0D0XknO0vUy0N$CF1gxqanWC0SPF1qd4.VvgHD9bmfGRM6UoKy8c/p4x/"  # The old seed_superuser
    users = [
        ("dev@trademetric.com", "TDM_DEV", seeded),
        ("trademetric@trademetric.com.br", "TDM_DEV", legacy.hash("Trademetric2026!")),
        ("admin@x.com", "TDM_DEV", legacy.hash("a private password")),
        ("manager@x.com", "MANAGER", legacy.hash("tdmdev123")),  # Not an admin account: left alone
    ]
    from sqlalchemy import create_engine, text
    engine = create_engine(url)
    with engine.begin() as c:
        for email, role, h in users:
            c.execute(text("INSERT INTO users (email, role, status, password_hash, master_key) "
                           "VALUES (:e, :r, 'active', :h, :k)"), {"e": email, "r": role, "h": h, "k": email})
    alembic("upgrade", "head")
    with engine.connect() as c:
        hashes = dict(c.execute(text("SELECT email, password_hash FROM users")).all())
    engine.dispose()
    assert hashes["dev@trademetric.com"] == hashes["trademetric@trademetric.com.br"] == "!disabled:leaked-credential"
    assert hashes["admin@x.com"] == users[2][2]
    assert hashes["manager@x.com"] == users[3][2]


# --- SEC-01 ---

def ws_close_code(client, first_message):
    with client.websocket_connect("/ws") as ws:
        if first_message is not None:
            ws.send_json(first_message)
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    return closed.value.code


def test_ws_without_valid_token_is_closed(client):
    assert ws_close_code(client, {"type": "HELLO"}) == server.WS_CLOSE_UNAUTHORIZED
    assert ws_close_code(client, {"type": "AUTH", "token": "garbage"}) == server.WS_CLOSE_UNAUTHORIZED
    forged = auth.jwt.encode({"sub": "x@x.com", "role": "TDM_DEV"}, "dev_secret_key", algorithm="HS256")
    assert ws_close_code(client, {"type": "AUTH", "token": forged}) == server.WS_CLOSE_UNAUTHORIZED


def test_ws_refuses_clients_and_frozen_managers(client):
    _, client_email = make_user(role="CLIENT")
    _, frozen_email = make_user(status="frozen")
    for email, role in [(client_email, "CLIENT"), (frozen_email, "MANAGER")]:
        code = ws_close_code(client, {"type": "AUTH", "token": token_for(email, role)})
        assert code == server.WS_CLOSE_FORBIDDEN


def test_ws_state_only_has_the_managers_own_positions(client):
    mine_id, mine_email = make_user()
    other_id, _ = make_user()
    my_key = add_open_position(mine_id, 9101)
    other_key = add_open_position(other_id, 9102)
    dev_id, dev_email = make_user(role="TDM_DEV")

    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "AUTH", "token": token_for(mine_email)})
        trades = ws.receive_json()["trades"]
    assert my_key in trades and other_key not in trades

    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "AUTH", "token": token_for(dev_email, "TDM_DEV")})
        trades = ws.receive_json()["trades"]
    assert my_key in trades and other_key in trades


def test_ws_closes_when_the_token_expires_and_accepts_a_refresh(client):
    _, email = make_user()
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "AUTH", "token": token_for(email, expires_delta=datetime.timedelta(seconds=2))})
        assert ws.receive_json()["type"] == "STATE"
        ws.send_json({"type": "AUTH", "token": token_for(email, expires_delta=datetime.timedelta(seconds=4))})
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()  # Nothing else arrives: the socket closes when the second token expires
    assert closed.value.code == server.WS_CLOSE_UNAUTHORIZED


def test_ws_refuses_a_token_of_another_user_mid_session(client):
    _, email = make_user()
    _, other = make_user()
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "AUTH", "token": token_for(email)})
        ws.receive_json()
        ws.send_json({"type": "AUTH", "token": token_for(other)})
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == server.WS_CLOSE_UNAUTHORIZED


class FakeSocket:
    def __init__(self):
        self.sent = []

    async def send_json(self, message):
        self.sent.append(message)


def test_hub_updates_only_reach_the_owning_manager():
    tm = server.TradeManager()
    mine, other, dev = FakeSocket(), FakeSocket(), FakeSocket()
    tm.web_clients = {mine: 1, other: 2, dev: None}

    asyncio.run(tm.broadcast_to_web({"type": "UPDATE", "data": {"manager_id": 1, "ticket": 5}}))
    asyncio.run(tm.broadcast_to_web({"type": "UPDATE", "data": {"ticket": 6}}))  # Old hub: no owner

    assert mine.sent == [{"type": "UPDATE", "data": {"ticket": 5}}]
    assert other.sent == []
    assert [m["data"]["ticket"] for m in dev.sent] == [5, 6]


# --- SEC-07 ---

def test_cors_is_closed_by_default(client):
    r = client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in r.headers


# --- SEC-09 ---

def test_refresh_extends_the_token_but_not_the_session(client):
    _, email = make_user()
    r = client.post("/token", data={"username": email, "password": PASSWORD})
    first = auth.decode_token(r.json()["access_token"])

    r = client.post("/token/refresh", headers=bearer(r.json()["access_token"]))
    assert r.status_code == 200
    refreshed = auth.decode_token(r.json()["access_token"])
    assert refreshed["auth_time"] == first["auth_time"]

    # Logged in almost SESSION_MAX_HOURS ago: the refreshed token can't outlive the session
    session_start = int(datetime.datetime.now(datetime.timezone.utc).timestamp()) - auth.SESSION_MAX_HOURS * 3600 + 60
    old = token_for(email, session_start=session_start)
    r = client.post("/token/refresh", headers=bearer(old))
    assert auth.decode_token(r.json()["access_token"])["exp"] <= session_start + auth.SESSION_MAX_HOURS * 3600


def test_expired_token_is_rejected(client):
    _, email = make_user()
    expired = token_for(email, expires_delta=datetime.timedelta(seconds=-1))
    assert client.get("/me/manager", headers=bearer(expired)).status_code == 401
    assert client.post("/token/refresh", headers=bearer(expired)).status_code == 401


def test_frozen_manager_loses_access_with_a_valid_token(client):
    user_id, email = make_user()
    token = token_for(email)
    assert client.get("/me/manager", headers=bearer(token)).status_code == 200
    db = database.SessionLocal()
    try:
        db.get(models.User, user_id).status = "frozen"
        db.commit()
    finally:
        db.close()
    assert client.get("/me/manager", headers=bearer(token)).status_code == 403


# --- SEC-08 (rotation only; the transport is still plaintext ZMQ) ---

def test_manager_can_rotate_master_key(client):
    _, email = make_user()
    headers = bearer(token_for(email))
    before = client.get("/me/manager", headers=headers).json()["master_key"]
    after = client.post("/me/manager/rotate-key", headers=headers).json()["master_key"]
    assert after != before
    assert client.get("/me/manager", headers=headers).json()["master_key"] == after
