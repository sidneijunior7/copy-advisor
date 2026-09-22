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

import database
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
        db.add_all([strategy, portfolio])
        db.commit()
        info = {"key": manager.master_key, "portfolio": portfolio.id, "manager": manager.id}
    finally:
        db.close()
    ports = {name: free_port() for name in ("pull", "pub", "events", "health")}
    return info, ports


def start_hub(ports):
    env = dict(os.environ,
               HUB_PULL_BIND=f"tcp://127.0.0.1:{ports['pull']}",
               HUB_PUB_BIND=f"tcp://127.0.0.1:{ports['pub']}",
               HUB_EVENTS_BIND=f"tcp://127.0.0.1:{ports['events']}",
               HUB_HEALTH_PORT=str(ports["health"]),
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
            assert json.loads(ws.recv(timeout=5))["type"] == "STATE"
            time.sleep(1)  # Let the API's SUB finish connecting to the hub
            peer.push.send_string(f"{info['key']}|V2|900|OPEN|66|1|GBPUSD|2|1.30000|0|0|4242")
            update = json.loads(ws.recv(timeout=5))
            assert update["type"] == "UPDATE"
            assert update["data"]["ticket"] == 66 and update["data"]["volume"] == 2.0 and update["data"]["type"] == 1
    finally:
        peer.close()
        api.terminate()
        api.wait(10)
        stop_hub(proc)
        print(api.stdout.read().decode(errors="replace"))  # Shown by pytest when the test fails
