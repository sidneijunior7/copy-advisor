"""Runs hub.py as a real process with real ZMQ sockets against the test SQLite database."""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

import pytest
import zmq

import auth
import database
import keys
import models

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def setup():
    db = database.SessionLocal()
    try:
        manager = models.User(email=f"e2e{time.time()}@x.com", password_hash="x", role="MANAGER")
        db.add(manager)
        db.flush()
        strategy = models.Strategy(user_id=manager.id, name="E2E", magic_number=4242)
        portfolio = models.Portfolio(user_id=manager.id, name="P")
        portfolio.strategies.append(strategy)
        master_key, license_key = keys.new_key(keys.MASTER), keys.new_key(keys.LICENSE)
        db.add_all([strategy, portfolio, models.MasterKey(user_id=manager.id, label="e2e", key_hash=keys.key_hash(master_key),
                                                          key_prefix=keys.key_prefix(master_key))])
        db.flush()
        db.add(models.License(portfolio_id=portfolio.id, client_mt5_login=31337, max_lots=2.5,
                              key_hash=keys.key_hash(license_key), key_prefix=keys.key_prefix(license_key)))
        db.commit()
        info = {"key": master_key, "license_key": license_key, "portfolio": portfolio.id, "manager": manager.id,
                "token": auth.create_access_token({"sub": manager.email, "role": "MANAGER"})}
    finally:
        db.close()
    ports = {name: free_port() for name in ("pull", "pub", "events", "health", "ws")}
    return info, ports


def start_hub(ports):
    env = dict(os.environ,
               HUB_PULL_BIND=f"tcp://127.0.0.1:{ports['pull']}",
               HUB_PUB_BIND=f"tcp://127.0.0.1:{ports['pub']}",
               HUB_EVENTS_BIND=f"tcp://127.0.0.1:{ports['events']}",
               HUB_HEALTH_PORT=str(ports["health"]),
               HUB_WS_PORT=str(ports["ws"]),
               HUB_HEARTBEAT_SECONDS="0.5", HUB_SNAPSHOT_SECONDS="1", HUB_WARMUP_SECONDS="3")
    proc = subprocess.Popen([sys.executable, "hub.py"], cwd=ROOT, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            return proc, health(ports)
        except Exception:
            time.sleep(0.2)
    proc.kill()
    raise RuntimeError("hub did not start:\n" + proc.stdout.read().decode(errors="replace"))


def health(ports):
    with urllib.request.urlopen(f"http://127.0.0.1:{ports['health']}/health", timeout=1) as r:
        return json.loads(r.read())


def stop_hub(proc):
    proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()


class Peer:
    def __init__(self, ports, topic):
        self.ctx = zmq.Context()
        self.sub = self.ctx.socket(zmq.SUB)
        self.sub.connect(f"tcp://127.0.0.1:{ports['pub']}")
        self.sub.subscribe(topic + " ")
        self.push = self.ctx.socket(zmq.PUSH)
        self.push.setsockopt(zmq.LINGER, 0)
        self.push.connect(f"tcp://127.0.0.1:{ports['pull']}")

    def wait_for(self, prefix, timeout=8, where=lambda payload: True):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.sub.poll(200):
                payload = self.sub.recv_string().split(" ", 1)[1]
                if payload.startswith(prefix) and where(payload):
                    return payload
        raise AssertionError(f"no {prefix!r} within {timeout}s")

    def close(self):
        self.ctx.destroy(linger=0)


def test_hub_process_end_to_end(setup):
    info, ports = setup
    topic = f"P_{info['portfolio']}"
    key = info["key"]
    proc, h = start_hub(ports)
    peer = Peer(ports, topic)
    try:
        hb = peer.wait_for("HB|")
        epoch = hb.split("|")[1]

        peer.push.send_string(f"{key}|V2|900|OPEN|55|0|EURUSD|1|1.10000|1.09000|1.12000|4242")
        pos = peer.wait_for("POS|").split("|")
        assert pos[1] == epoch and pos[2] == "1" and pos[3] == "900_55" and pos[11] == "OPEN"
        assert peer.wait_for("OPEN|").startswith("OPEN|55|0|EURUSD|1|")

        peer.push.send_string(f"{key}|V2|900|PARTIAL|55|0|EURUSD|0.4|1.10000|1.09000|1.12000|4242")
        assert peer.wait_for("POS|").split("|")[6] == "0.4"

        # SNAP shows up once warm-up ends (no positions in the database at start → immediately)
        snap = peer.wait_for("SNAP|")
        assert "900_55,0,EURUSD,0.4," in snap

        # Restart: epoch changes and the open position is reloaded from the database
        time.sleep(1.5)  # let the write-behind thread persist
        stop_hub(proc)
        proc, h = start_hub(ports)
        assert h["warming"] is True
        new_epoch = lambda p: p.split("|")[1] != epoch  # Skip messages the old hub left in our queue
        epoch = peer.wait_for("HB|", where=new_epoch).split("|")[1]
        peer.push.send_string(f"{key}|V2SYNC|900|55,0,EURUSD,0.4,1.10000,1.09000,1.12000,4242")
        snap = peer.wait_for("SNAP|", where=lambda p: p.split("|")[1] == epoch)
        assert "900_55,0,EURUSD,0.4," in snap
        assert health(ports)["warming"] is False

        peer.push.send_string(f"{key}|V2|900|CLOSE|55|0|EURUSD|0|1.10000|1.09000|1.12000|4242")
        assert peer.wait_for("POS|").split("|")[6] == "0"
        peer.push.send_string(f"EXEC|12345|nokey|900_55|CLOSE|777|0.4|1.1|10009|3")
        time.sleep(1.5)
    finally:
        peer.close()
        stop_hub(proc)

    db = database.SessionLocal()
    try:
        row = db.query(models.MasterPosition).filter_by(manager_id=info["manager"], pos_id=55).one()
        assert row.closed_at is not None
        reasons = [s.reason for s in db.query(models.Signal).filter_by(master_position_id=row.id).order_by(models.Signal.id)]
        assert reasons == ["OPEN", "PARTIAL", "CLOSE"]
        assert db.query(models.Execution).filter_by(uid="900_55").count() == 1
    finally:
        db.close()


def test_api_relays_hub_events_to_dashboard(setup):
    from websockets.sync.client import connect

    info, ports = setup
    api_port = free_port()
    proc, _ = start_hub(ports)
    env = dict(os.environ, HUB_EVENTS_URL=f"tcp://127.0.0.1:{ports['events']}",
               HUB_HEALTH_URL=f"http://127.0.0.1:{ports['health']}/health")
    api = subprocess.Popen([sys.executable, "-m", "uvicorn", "server:app", "--port", str(api_port)], cwd=ROOT, env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    peer = Peer(ports, f"P_{info['portfolio']}")
    try:
        deadline = time.time() + 20
        while True:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{api_port}/health", timeout=1) as r:
                    body = json.loads(r.read())
                break
            except Exception:
                if time.time() > deadline:
                    raise
                time.sleep(0.3)
        assert body["hub"]["status"] == "healthy"

        with connect(f"ws://127.0.0.1:{api_port}/ws") as ws:
            ws.send(json.dumps({"type": "AUTH", "token": info["token"]}))
            assert json.loads(ws.recv(timeout=5))["type"] == "STATE"
            time.sleep(1)  # Let the API's SUB finish connecting to the hub
            peer.push.send_string(f"{info['key']}|V2|900|OPEN|66|1|GBPUSD|2|1.30000|0|0|4242")
            update = json.loads(ws.recv(timeout=5))
            assert update["type"] == "UPDATE"
            assert "manager_id" not in update["data"]
            assert update["data"]["ticket"] == 66 and update["data"]["volume"] == 2.0 and update["data"]["type"] == 1
    finally:
        peer.close()
        api.terminate()
        api.wait(10)
        stop_hub(proc)
        print(api.stdout.read().decode(errors="replace"))  # Shown by pytest when the test fails


def ws_wait_for(ws, prefix, timeout=8):
    deadline = time.time() + timeout
    while time.time() < deadline:
        msg = ws.recv(timeout=max(0.1, deadline - time.time()))
        if msg.startswith(prefix):
            return msg
    raise AssertionError(f"no {prefix!r} within {timeout}s")


def get_json(ports, path):
    with urllib.request.urlopen(f"http://127.0.0.1:{ports['health']}{path}", timeout=2) as r:
        return json.loads(r.read())


def test_hub_process_over_websocket(setup):
    from websockets.sync.client import connect

    info, ports = setup
    url = f"ws://127.0.0.1:{ports['ws']}"
    proc, _ = start_hub(ports)
    try:
        with connect(url + "/v1/slave") as slave, connect(url + "/v1/master") as master:
            slave.send(f"HELLO|slave|v1|{info['license_key']}|31337|4.00|0|0")
            welcome = slave.recv(timeout=5).split("|")
            assert welcome[0] == "WELCOME" and welcome[3:] == [str(info["portfolio"]), "1", "2.5"]
            master.send(f"HELLO|master|v1|{info['key']}|900|4.00")
            assert master.recv(timeout=5).startswith("WELCOME|")

            master.send("V2|900|OPEN|77|0|EURUSD|1|1.10000|0|0|4242")
            pos = ws_wait_for(slave, "POS|").split("|")
            assert pos[3] == "900_77"
            slave.send(f"EXEC|0|forged|900_77|OPEN|1|2.5|1.1|10009|{pos[2]}")
            slave.send(f"ACK|{pos[1]}|{pos[2]}")
            time.sleep(1.5)  # Write-behind and the next stats refresh
            assert {k: health(ports)["ws"][k] for k in ("masters", "slaves")} == {"masters": 1, "slaves": 1}
            sessions = get_json(ports, "/sessions")["sessions"]
            assert {s["kind"] for s in sessions} == {"master", "slave"}

        # A license created while the hub runs is usable once the API asks the hub to refresh
        late_key = keys.new_key(keys.LICENSE)
        db = database.SessionLocal()
        try:
            db.add(models.License(portfolio_id=info["portfolio"], client_mt5_login=4242, max_lots=1,
                                  key_hash=keys.key_hash(late_key), key_prefix=keys.key_prefix(late_key)))
            db.commit()
        finally:
            db.close()
        assert get_json(ports, "/refresh")["status"] == "refreshing"
        deadline = time.time() + 10
        while True:
            with connect(url + "/v1/slave") as late:
                late.send(f"HELLO|slave|v1|{late_key}|4242|4.00|0|0")
                if late.recv(timeout=5).startswith("WELCOME|"):
                    break
            assert time.time() < deadline, "the new license never got through"
            time.sleep(1.1)  # Each refused HELLO counts against this address
    finally:
        stop_hub(proc)

    db = database.SessionLocal()
    try:
        execution = db.query(models.Execution).filter_by(uid="900_77").one()
        assert (execution.portfolio_id, execution.mt5_login) == (info["portfolio"], 31337)
        assert execution.latency_ms is not None
        key = db.query(models.MasterKey).filter_by(user_id=info["manager"]).one()
        assert key.last_used_at is not None
        assert db.query(models.Signal).join(models.MasterPosition).filter(
            models.MasterPosition.manager_id == info["manager"]).one().raw.startswith("V2|900|OPEN|77|")
    finally:
        db.close()
