"""The hub's WebSocket edge (hub_ws.py) with a real server and real clients, around an in-process HubCore."""
import asyncio
import functools
import time
import urllib.error
import urllib.request
from types import SimpleNamespace

import pytest
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

import hub_ws
import keys
from hub import Directory, HubCore, LicenseInfo, ManagerInfo, MasterKeyInfo, StrategyInfo

MASTER_KEY = keys.new_key(keys.MASTER)
LICENSE_KEY = keys.new_key(keys.LICENSE)
TREND = StrategyInfo(id=10, manager_id=1, name="Trend", is_active=True)    # Portfolios 7 and 8
SCALP = StrategyInfo(id=11, manager_id=1, name="Scalp", is_active=True)    # Portfolio 8 only
LICENSE = LicenseInfo(id=70, portfolio_id=7, login=31337, max_lots=2.5, is_active=True, expires_at=None,
                      key_hash=keys.key_hash(LICENSE_KEY))


def make_directory(license=LICENSE, master_key=True):
    return Directory(
        managers_by_id={1: ManagerInfo(1, "active")},
        master_keys_by_hash={keys.key_hash(MASTER_KEY): MasterKeyInfo(50, 1)} if master_key else {},
        strategies_by_magic={(1, 555): TREND, (1, 556): SCALP},
        strategies_by_id={10: TREND, 11: SCALP},
        portfolios_by_strategy={10: (7, 8), 11: (8,)},
        portfolio_ids=(7, 8),
        licenses_by_hash={license.key_hash: license} if license else {},
        licenses_by_id={license.id: license} if license else {},
    )


def run_async(fn):
    @functools.wraps(fn)
    def wrapper():
        asyncio.run(asyncio.wait_for(fn(), 20))
    return wrapper


class Env:
    def __init__(self, **edge_options):
        self.edge_options = edge_options

    async def __aenter__(self):
        self.dir = make_directory()
        self.published, self.jobs = [], []
        self.core = HubCore(directory=lambda: self.dir, publish=self._publish, web=lambda event: None,
                            persist=self.jobs.append, epoch=42)
        self.core.warming = False
        options = dict(heartbeat_seconds=5, hello_timeout=0.5)
        options.update(self.edge_options)
        self.edge = hub_ws.Edge(self.core, directory=lambda: self.dir, **options)
        self.server = await serve(self.edge.handler, "127.0.0.1", 0, process_request=self.edge.process_request,
                                  compression=None)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc):
        self.server.close()
        await self.server.wait_closed()

    def _publish(self, portfolio_id, payload):
        self.published.append((portfolio_id, payload))
        self.edge.fanout(portfolio_id, payload)

    async def connect(self, path, hello=None):
        ws = await connect(f"ws://127.0.0.1:{self.port}{path}")
        if hello is not None:
            await ws.send(hello)
        return ws

    async def slave(self, key=LICENSE_KEY, login=31337):
        return await self.connect("/v1/slave", f"HELLO|slave|v1|{key}|{login}|4.00|0|0")

    async def master(self, key=MASTER_KEY, login=900):
        return await self.connect("/v1/master", f"HELLO|master|v1|{key}|{login}|4.00")

    def v2(self, reason, pos_id, vol=1.0, magic=555, sl=0.0):
        self.core.handle_master(self.dir.managers_by_id[1], f"V2|900|{reason}|{pos_id}|0|EURUSD|{vol}|1.10000|{sl}|0|{magic}")


async def recv(ws, timeout=2.0) -> str:
    return await asyncio.wait_for(ws.recv(), timeout)


async def nothing(ws, timeout=0.3):
    with pytest.raises(asyncio.TimeoutError):
        msg = await asyncio.wait_for(ws.recv(), timeout)
        pytest.fail(f"unexpected {msg!r}")


async def until_closed(ws, timeout=3.0):
    """Messages received until the server closes, and its close code."""
    msgs = []
    try:
        while True:
            msgs.append(await asyncio.wait_for(ws.recv(), timeout))
    except ConnectionClosed:
        pass
    return msgs, ws.close_code


# --- Slave: authentication and the stream of its own portfolio ---

@run_async
async def test_slave_gets_welcome_snapshot_and_only_its_portfolio():
    async with Env() as env:
        env.v2("OPEN", 1)
        ws = await env.slave()
        assert await recv(ws) == "WELCOME|42|5|7|1|2.5"
        snap = await recv(ws)
        assert snap.startswith("SNAP|42|1|900_1,0,EURUSD,1,")

        env.v2("OPEN", 2, magic=556)  # Portfolio 8 only
        env.v2("OPEN", 3)
        assert (await recv(ws)).startswith("POS|42|2|900_3|")  # Nothing from portfolio 8
        env.core.publish_heartbeats()
        assert await recv(ws) == "HB|42|2"
        await ws.close()


@run_async
async def test_bad_hellos_are_refused_then_the_address_is_rate_limited():
    async with Env(fails_per_ip=3) as env:
        cases = [
            (await env.slave(key="lic_unknown"), "ERR|auth|", 4401),
            (await env.slave(login=1), "ERR|login|this license is for account 31337", 4401),
            (await env.connect("/v1/slave", "GET / HTTP/1.1"), "ERR|protocol|", 4400),
        ]
        for ws, err, code in cases:
            msgs, close_code = await until_closed(ws)
            assert msgs[0].startswith(err) and close_code == code
        # Refused now before any HELLO is read, whatever the key
        msgs, code = await until_closed(await env.connect("/v1/slave"))
        assert msgs[0].startswith("ERR|rate|") and code == 4429
        assert env.edge.slave_by_license == {}


@run_async
async def test_connection_without_hello_is_closed():
    async with Env() as env:
        ws = await env.connect("/v1/slave")
        msgs, _ = await until_closed(ws)
        assert msgs == []


def test_health_and_unknown_paths_over_http():
    async def scenario():
        async with Env() as env:
            def get(path):
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{env.port}{path}", timeout=2) as r:
                        return r.status, r.read()
                except urllib.error.HTTPError as e:
                    return e.code, b""
            assert await asyncio.to_thread(get, "/health") == (200, b"OK\n")
            assert (await asyncio.to_thread(get, "/v2/other"))[0] == 404
    asyncio.run(scenario())


@run_async
async def test_second_terminal_with_the_same_license_replaces_the_first():
    async with Env() as env:
        first = await env.slave()
        await recv(first), await recv(first)
        second = await env.slave()
        await recv(second), await recv(second)
        msgs, code = await until_closed(first)
        assert msgs == ["ERR|replaced|another terminal connected with this license"] and code == 4409
        env.v2("OPEN", 1)
        assert (await recv(second)).startswith("POS|42|1|900_1|")
        await second.close()


# --- Revocation, expiry and key rotation ---

@run_async
async def test_revoked_license_follows_its_open_positions_and_nothing_new():
    async with Env() as env:
        env.v2("OPEN", 1)
        ws = await env.slave()
        await recv(ws), await recv(ws)

        time.sleep(0.02)
        env.dir = make_directory(LicenseInfo(**{**LICENSE.__dict__, "is_active": False, "revoked_at": time.time()}))
        time.sleep(0.02)
        env.edge.tick()
        assert await recv(ws) == "LIC|0|2.5"

        env.v2("OPEN", 2)                       # Opened after the revocation: the slave only learns the seq moved
        assert await recv(ws) == "SKIP|42|2"
        env.v2("MODIFY", 1, sl=1.05)            # Its own position keeps flowing
        assert (await recv(ws)).startswith("POS|42|3|900_1|0|EURUSD|1|1.1|1.05|")
        env.core.publish_snapshots()
        assert await recv(ws) == f"SNAP|42|3|{env.core._entry(env.core.positions[(1, 900, 1)])}"
        env.v2("CLOSE", 1, vol=0)
        assert (await recv(ws)).startswith("POS|42|4|900_1|0|EURUSD|0|")
        env.core.publish_snapshots()
        assert await recv(ws) == "SNAP|42|4|"   # Position 2 never shows up

        env.dir = make_directory()              # Reactivated: full stream again, starting with a SNAP
        env.edge.tick()
        assert await recv(ws) == "LIC|1|2.5"
        assert (await recv(ws)).startswith("SNAP|42|4|900_2,")
        await ws.close()


@run_async
async def test_expired_license_connects_manage_only_and_a_new_key_drops_it():
    async with Env() as env:
        env.v2("OPEN", 1)
        env.v2("OPEN", 2)
        env.core.positions[(1, 900, 1)].opened_at = 1000.0   # Before the expiry
        env.core.positions[(1, 900, 2)].opened_at = 3000.0   # After
        env.dir = make_directory(LicenseInfo(**{**LICENSE.__dict__, "expires_at": 2000.0}))
        ws = await env.slave()
        assert await recv(ws) == "WELCOME|42|5|7|0|2.5"
        snap = await recv(ws)
        assert "900_1," in snap and "900_2," not in snap

        env.dir = make_directory(LicenseInfo(**{**LICENSE.__dict__, "key_hash": keys.key_hash("lic_new")}))
        env.edge.tick()
        msgs, code = await until_closed(ws)
        assert msgs == ["ERR|revoked|license key revoked or replaced"] and code == 4403


@run_async
async def test_lot_limit_change_reaches_the_connected_slave():
    async with Env() as env:
        ws = await env.slave()
        await recv(ws), await recv(ws)
        env.dir = make_directory(LicenseInfo(**{**LICENSE.__dict__, "max_lots": 1.0}))
        env.edge.tick()
        assert await recv(ws) == "LIC|1|1"
        await ws.close()


# --- Flow control, warm-up ---

@run_async
async def test_slow_slave_is_dropped_without_holding_the_others():
    async with Env(queue_size=5) as env:
        ws = await env.slave()
        await recv(ws), await recv(ws)
        for pos_id in range(1, 20):  # Published back to back: the writer can't drain in between
            env.v2("OPEN", pos_id)
        msgs, code = await until_closed(ws)
        assert msgs == ["ERR|slow|connection too slow, reconnect to resynchronise"] and code == 4408
        assert env.edge.stats["slow"] == 1 and env.edge.slaves_by_portfolio == {}


@run_async
async def test_warming_hub_sends_no_snapshot_until_warm_up_ends():
    async with Env() as env:
        env.core.warming = True
        ws = await env.slave()
        assert (await recv(ws)).startswith("WELCOME|")
        await nothing(ws)
        env.core.warming = False
        env.core.publish_snapshots()
        assert await recv(ws) == "SNAP|42|0|"
        await ws.close()


# --- Execution reports and ACKs ---

@run_async
async def test_exec_and_ack_are_bound_to_the_session_license():
    async with Env() as env:
        ws = await env.slave()
        await recv(ws), await recv(ws)
        env.v2("OPEN", 1)
        await recv(ws)
        await ws.send("EXEC|999|forged-key|900_1|OPEN|777|2.5|1.1|10009|1")
        await ws.send("ACK|42|1")
        await asyncio.sleep(0.2)
        job = [j for j in env.jobs if j["kind"] == "execution"][-1]
        assert (job["portfolio_id"], job["mt5_login"], job["seq"]) == (7, 31337, 1)
        assert job["latency_ms"] is not None
        env.edge.tick()
        session = env.edge.public["sessions"][0]
        assert (session["last_ack_seq"], session["lag"], session["license_id"]) == (1, 0, 70)
        assert env.edge.public["slaves"] == 1
        await ws.close()


# --- Master ---

@run_async
async def test_master_publishes_over_ws_bound_to_its_login():
    async with Env() as env:
        slave = await env.slave()
        await recv(slave), await recv(slave)
        master = await env.master()
        assert await recv(master) == "WELCOME|42|5"

        await master.send("V2|901|OPEN|6|0|EURUSD|1|1.1|0|0|555")      # Another login: dropped
        await master.send("OPEN|7|0|EURUSD|1|1.1|0|0|555")             # Pre-v3 format: ignored
        await master.send("V2|900|OPEN|5|0|EURUSD|1|1.10000|0|0|555")
        assert (await recv(slave)).startswith("POS|42|1|900_5|")
        position_jobs = [j for j in env.jobs if j["kind"] == "position"]
        assert [j["raw"] for j in position_jobs] == ["V2|900|OPEN|5|0|EURUSD|1|1.10000|0|0|555"]

        env.edge._next_heartbeat = 0
        env.edge.tick()
        assert await recv(master) == "HB|42|0"

        env.dir = make_directory(master_key=False)
        env.edge.tick()
        msgs, code = await until_closed(master)
        assert msgs == ["ERR|revoked|master key revoked"] and code == 4403
        await slave.close()


@run_async
async def test_unknown_master_key_is_refused():
    async with Env() as env:
        msgs, code = await until_closed(await env.master(key="mst_nope"))
        assert msgs[0].startswith("ERR|auth|") and code == 4401


# --- Client address behind the proxy ---

def test_client_ip_is_the_address_the_proxy_saw():
    def ws(peer, forwarded=None):
        headers = {"X-Forwarded-For": forwarded} if forwarded else {}
        return SimpleNamespace(remote_address=(peer, 1), request=SimpleNamespace(headers=headers))

    assert hub_ws.client_ip(ws("10.11.0.18", "6.6.6.6, 200.1.2.3")) == "200.1.2.3"   # Leftmost is forgeable
    assert hub_ws.client_ip(ws("10.11.0.18", "200.1.2.3, 10.0.0.5")) == "200.1.2.3"
    assert hub_ws.client_ip(ws("200.9.9.9", "6.6.6.6")) == "200.9.9.9"               # Not from the proxy
    assert hub_ws.client_ip(ws("10.11.0.18")) == "10.11.0.18"
