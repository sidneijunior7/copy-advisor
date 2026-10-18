"""
WebSocket edge of the hub: wss:// on 443 through the EasyPanel proxy, which terminates TLS.

Masters and Slaves authenticate with their own key in the first message. A Slave is bound to the
portfolio of its license; it never picks one. The lines after the HELLO are those in hub.py.

/v1/master
    Master -> hub   HELLO|master|v1|<master_key>|<login>|<ea_version>
    hub -> Master   WELCOME|<epoch>|<heartbeat_s>, then HB|<epoch>|0 every heartbeat
    Master -> hub   V2|... · V2SYNC|... · V2HELLO|...   (login must be the HELLO's)
/v1/slave
    Slave -> hub    HELLO|slave|v1|<license_key>|<login>|<ea_version>|<last_epoch>|<last_seq>
    hub -> Slave    WELCOME|<epoch>|<heartbeat_s>|<portfolio_id>|<active 0/1>|<max_lots>
                    SNAP right after (unless the hub is warming up), then POS · SNAP · HB as published,
                    LIC|<active 0/1>|<max_lots> when the license changes, SKIP|<epoch>|<seq> (see below)
    Slave -> hub    ACK|<epoch>|<seq> after each HB · EXEC|... (its login and key fields are ignored)
Errors
    hub -> client   ERR|<code>|<reason>, then close with an application code (4400, 4401...)

A license that is revoked or expires keeps its connection in manage-only mode: the Slave receives only
the positions that were already open when the license stopped being valid, so its copies close with
the Master's, and nothing opened after that. Positions left out arrive as SKIP, which keeps the Slave's
seq continuous without telling it anything. Revoking never opens nor closes anything by itself.
"""
import asyncio
import ipaddress
import json
import logging
import os
import time
from collections import deque
from http import HTTPStatus
from typing import Callable, Deque, Dict, Optional, Set, Tuple

from websockets.asyncio.server import ServerConnection
from websockets.exceptions import ConnectionClosed

import keys

logger = logging.getLogger("hub.ws")

HELLO_TIMEOUT = 5.0
QUEUE_SIZE = int(os.getenv("HUB_WS_QUEUE", "1000"))           # Messages waiting per connection before it is dropped
CONNS_PER_IP = int(os.getenv("HUB_WS_CONNS_PER_IP", "300"))   # A hosting pod puts many terminals behind one IP
FAILS_PER_IP = int(os.getenv("HUB_WS_FAILS_PER_IP", "30"))    # Failed HELLOs per IP per FAIL_WINDOW
FAIL_WINDOW = 300.0
KICK_GRACE = 5.0           # A kicked connection that doesn't close by itself is aborted after this
MAX_HELD_WARNINGS = 1000   # Bound on the rate-limited warning keys

# Application close codes (4000-4999), named after the HTTP status they resemble
CLOSE_PROTOCOL = 4400
CLOSE_AUTH = 4401
CLOSE_REVOKED = 4403
CLOSE_SLOW = 4408
CLOSE_REPLACED = 4409
CLOSE_RATE = 4429
CLOSE_BUSY = 4503

PATHS = ("/v1/master", "/v1/slave")
MASTER_MESSAGES = ("V2|", "V2SYNC|", "V2HELLO|", "V2DEAL|", "V2ACC|")


def fmt(x: float) -> str:
    s = f"{x:.8f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


def _private(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback


def client_ip(ws: ServerConnection) -> str:
    """The proxy appends the address it saw to X-Forwarded-For; anything left of it is the client's word.
    Only a peer on the private network (the proxy) may speak for the client."""
    peer = str(ws.remote_address[0]) if ws.remote_address else "?"
    forwarded = ws.request.headers.get("X-Forwarded-For") if ws.request else None
    if not forwarded or not _private(peer):
        return peer
    for host in reversed([h.strip() for h in forwarded.split(",")]):
        if host and not _private(host):
            return host
    return peer


class Outbox:
    """Bounded queue of one connection. finish() jumps the queue: the error goes out, then the close."""

    def __init__(self, limit: int):
        self.items: Deque[str] = deque()
        self.limit = limit
        self.ready = asyncio.Event()
        self.final: Optional[Tuple[str, int, str]] = None

    def put(self, msg: str) -> bool:
        if self.final is not None:
            return True  # Closing: nothing else goes out
        if len(self.items) >= self.limit:
            return False
        self.items.append(msg)
        self.ready.set()
        return True

    def finish(self, err: str, code: int, reason: str):
        if self.final is None:
            self.items.clear()
            self.final = (err, code, reason)
            self.ready.set()


# Slave settings (hosting.SlaveInputs, on the license) as CFG|key=value|...: Slave 4.04 applies them over its own
# inputs, and goes back to its inputs for any key left out. Older Slaves ignore the line.
CFG_KEYS = {
    "sizing_mode": ("sizing", lambda v: str({"factor": 0, "balance": 1, "equity": 2}[v])),
    "reference_capital": ("capital", lambda v: f"{float(v):g}"),
    "sltp_mode": ("sltp", lambda v: str({"distance": 0, "price": 1}[v])),
    "copy_sltp": ("copysltp", lambda v: "1" if v else "0"),
    "late_max_deviation_points": ("late", lambda v: str(int(v))),
    "slippage_points": ("slip", lambda v: str(int(v))),
    "symbol_map": ("symmap", str),
    "suffix_map": ("sufmap", str),
}


def cfg_line(settings: str) -> str:
    """The CFG message for a license's settings. A value that would not parse is left out, so the Slave keeps its
    own input for it."""
    try:
        values = json.loads(settings or "{}")
    except ValueError:
        values = {}
    if not isinstance(values, dict):
        values = {}
    fields = []
    factor = values.get("lots_factor")
    if isinstance(factor, (int, float)) and factor > 0:
        fields.append(f"factor={(1 / factor if values.get('lots_divide') else factor):g}")
    for key, (name, encode) in CFG_KEYS.items():
        if values.get(key) is None:
            continue
        try:
            value = encode(values[key])
        except (KeyError, TypeError, ValueError):
            continue
        fields.append(f"{name}={value.replace('|', '/')}")
    return "|".join(["CFG", *fields])


class Session:
    def __init__(self, ws: ServerConnection, kind: str, ip: str, login: int, version: str, queue_size: int):
        self.ws = ws
        self.kind = kind
        self.ip = ip
        self.login = login
        self.version = version
        self.connected_at = time.time()
        self.last_rx = self.connected_at
        self.outbox = Outbox(queue_size)
        self.closed = False
        # Slave
        self.license_id: Optional[int] = None
        self.portfolio_id: Optional[int] = None
        self.key_hash: Optional[str] = None
        self.max_lots = 0.0
        self.allowed: Optional[Set[str]] = None  # None = full stream; a set = manage-only, these uids
        self.settings = ""  # The license settings its last CFG carried
        self.last_ack_seq: Optional[int] = None
        self.last_ack_at: Optional[float] = None
        # Master
        self.manager_id: Optional[int] = None
        self.key_id: Optional[int] = None

    @property
    def active(self) -> bool:
        return self.allowed is None

    def lic(self) -> str:
        return f"LIC|{int(self.active)}|{fmt(self.max_lots)}"

    def view(self, payload: str) -> str:
        """What this Slave gets of a published line."""
        if self.allowed is None:
            return payload
        if payload.startswith("POS|"):
            f = payload.split("|")
            if f[3] in self.allowed:
                if float(f[6]) <= 0:
                    self.allowed.discard(f[3])
                return payload
            return f"SKIP|{f[1]}|{f[2]}"
        if payload.startswith("SNAP|"):
            _, epoch, seq, entries = payload.split("|", 3)
            kept = [e for e in entries.split(";") if e and e.split(",", 1)[0] in self.allowed]
            self.allowed = {e.split(",", 1)[0] for e in kept}  # Positions absent from a SNAP are closed
            return f"SNAP|{epoch}|{seq}|{';'.join(kept)}"
        return payload


class Edge:
    def __init__(self, core, directory: Callable, request_refresh: Callable[[], None] = lambda: None,
                 heartbeat_seconds: float = 5.0, hello_timeout: float = HELLO_TIMEOUT, queue_size: int = QUEUE_SIZE,
                 conns_per_ip: int = CONNS_PER_IP, fails_per_ip: int = FAILS_PER_IP, clock: Callable[[], float] = time.time):
        self.core = core
        self.directory = directory
        self.request_refresh = request_refresh
        self.heartbeat_seconds = heartbeat_seconds
        self.hello_timeout = hello_timeout
        self.queue_size = queue_size
        self.conns_per_ip = conns_per_ip
        self.fails_per_ip = fails_per_ip
        self.clock = clock

        self.slaves_by_portfolio: Dict[int, Set[Session]] = {}
        self.slave_by_license: Dict[int, Session] = {}
        self.masters: Dict[Tuple[int, int], Session] = {}  # (key_id, login)
        self.conns_by_ip: Dict[str, int] = {}
        self.failures: Dict[str, Deque[float]] = {}
        self.inactive_seen: Dict[int, float] = {}  # license id -> first time seen revoked without revoked_at
        self.stats = {"accepted": 0, "refused": 0, "slow": 0, "replaced": 0, "revoked": 0}
        self.public: dict = {"masters": 0, "slaves": 0, "manage_only": 0, "sessions": []}
        self._dir_seen = None
        self._next_reconcile = 0.0
        self._next_heartbeat = 0.0
        self._last_warn: Dict[str, float] = {}

    # --- HTTP before the upgrade ---

    def process_request(self, connection: ServerConnection, request):
        if request.path == "/health":
            return connection.respond(HTTPStatus.OK, "OK\n")
        if request.path not in PATHS:
            return connection.respond(HTTPStatus.NOT_FOUND, "Not found\n")
        return None

    # --- connection lifecycle ---

    async def handler(self, ws: ServerConnection):
        ip = client_ip(ws)
        if self._limited(ip):
            await self._refuse(ws, "rate", "too many failed attempts, try again later", CLOSE_RATE)
            return
        if self.conns_by_ip.get(ip, 0) >= self.conns_per_ip:
            await self._refuse(ws, "busy", "too many connections from this address", CLOSE_BUSY)
            return
        self.conns_by_ip[ip] = self.conns_by_ip.get(ip, 0) + 1
        session: Optional[Session] = None
        try:
            try:
                hello = await asyncio.wait_for(ws.recv(), self.hello_timeout)
            except (asyncio.TimeoutError, ConnectionClosed):
                return
            hello = hello if isinstance(hello, str) else ""
            outcome = self._hello_master(ws, ip, hello) if ws.request.path == "/v1/master" else self._hello_slave(ws, ip, hello)
            if not isinstance(outcome, Session):
                self._fail(ip)
                self._warn(f"refused:{ip}:{outcome[0]}", f"{ws.request.path} from {ip} refused: {outcome[0]} ({outcome[1]})")
                await self._refuse(ws, *outcome)
                return
            session = outcome
            self.stats["accepted"] += 1
            writer = asyncio.create_task(self._writer(session))
            try:
                async for msg in ws:
                    session.last_rx = self.clock()
                    if isinstance(msg, str):
                        self._inbound(session, msg)
            except ConnectionClosed:
                pass
            finally:
                if not session.outbox.final:
                    writer.cancel()
        finally:
            if session is not None:
                self._unregister(session)
                logger.info(f"{session.kind} {session.login} ({ip}) disconnected after "
                            f"{self.clock() - session.connected_at:.0f}s, close code {ws.close_code}")
            left = self.conns_by_ip.get(ip, 1) - 1
            if left > 0:
                self.conns_by_ip[ip] = left
            else:
                self.conns_by_ip.pop(ip, None)

    async def _writer(self, s: Session):
        ob = s.outbox
        try:
            while True:
                await ob.ready.wait()
                while ob.items:
                    await s.ws.send(ob.items.popleft())
                if ob.final is not None:
                    err, code, reason = ob.final
                    if err:
                        await s.ws.send(err)
                    await s.ws.close(code, reason)
                    return
                ob.ready.clear()
        except ConnectionClosed:
            pass

    async def _refuse(self, ws: ServerConnection, code: str, reason: str, close_code: int):
        self.stats["refused"] += 1
        try:
            await ws.send(f"ERR|{code}|{reason}")
            await ws.close(close_code, code)
        except ConnectionClosed:
            pass

    def kick(self, s: Session, code: str, reason: str, close_code: int):
        """Drops a session from every stream now; the error and the close go out after anything already sent."""
        if s.closed:
            return
        self._unregister(s)
        s.outbox.finish(f"ERR|{code}|{reason}", close_code, code)
        logger.info(f"{s.kind} {s.login} ({s.ip}) dropped: {code} ({reason})")
        # A client that stopped reading never lets the close through: abort the TCP connection then
        asyncio.get_running_loop().call_later(KICK_GRACE, lambda: s.ws.transport.abort() if s.ws.state.name != "CLOSED" else None)

    # --- handshake ---

    def _hello_slave(self, ws: ServerConnection, ip: str, hello: str):
        f = hello.split("|")
        if len(f) < 8 or f[:3] != ["HELLO", "slave", "v1"]:
            return ("protocol", "expected HELLO|slave|v1|<key>|<login>|<version>|<epoch>|<seq>", CLOSE_PROTOCOL)
        try:
            login = int(f[4])
        except ValueError:
            return ("protocol", "login must be a number", CLOSE_PROTOCOL)
        lic = self.directory().licenses_by_hash.get(keys.key_hash(f[3]))
        if lic is None:
            self.request_refresh()  # A license created a moment ago may not be loaded yet
            return ("auth", "unknown or revoked license key", CLOSE_AUTH)
        if lic.login != login:
            return ("login", f"this license is for account {lic.login}", CLOSE_AUTH)

        old = self.slave_by_license.get(lic.id)
        if old is not None:
            self.stats["replaced"] += 1
            self.kick(old, "replaced", "another terminal connected with this license", CLOSE_REPLACED)
        s = Session(ws, "slave", ip, login, f[5][:32], self.queue_size)
        s.license_id, s.portfolio_id, s.key_hash, s.max_lots = lic.id, lic.portfolio_id, lic.key_hash, lic.max_lots
        s.settings = lic.settings
        since = self._inactive_since(lic)
        if since is not None:
            s.allowed = self.core.open_uids(lic.portfolio_id, opened_before=since)
        # Nothing is awaited from here to the registration: no published line can slip between them
        s.outbox.put(f"WELCOME|{self.core.epoch}|{self.heartbeat_seconds:g}|{lic.portfolio_id}|{int(s.active)}|{fmt(s.max_lots)}")
        s.outbox.put(cfg_line(lic.settings))  # Before the SNAP: its late entries are sized with these settings
        if not self.core.warming:  # A SNAP is authoritative: a partial one would close copies
            s.outbox.put(s.view(self.core.snapshot(lic.portfolio_id)))
        self.slaves_by_portfolio.setdefault(lic.portfolio_id, set()).add(s)
        self.slave_by_license[lic.id] = s
        logger.info(f"slave {login} ({ip}) connected: license {lic.id}, portfolio {lic.portfolio_id}, "
                    f"ea {s.version}, {'active' if s.active else 'manage-only'}")
        return s

    def _hello_master(self, ws: ServerConnection, ip: str, hello: str):
        f = hello.split("|")
        if len(f) < 6 or f[:3] != ["HELLO", "master", "v1"]:
            return ("protocol", "expected HELLO|master|v1|<key>|<login>|<version>", CLOSE_PROTOCOL)
        try:
            login = int(f[4])
        except ValueError:
            return ("protocol", "login must be a number", CLOSE_PROTOCOL)
        found = self.directory().master_for_key(f[3])
        if found is None:
            self.request_refresh()
            return ("auth", "unknown or revoked master key", CLOSE_AUTH)
        manager, master_key = found

        old = self.masters.get((master_key.id, login))
        if old is not None:
            self.stats["replaced"] += 1
            self.kick(old, "replaced", "another terminal connected with this key and account", CLOSE_REPLACED)
        s = Session(ws, "master", ip, login, f[5][:32], self.queue_size)
        s.manager_id, s.key_id = manager.id, master_key.id
        s.outbox.put(f"WELCOME|{self.core.epoch}|{self.heartbeat_seconds:g}")
        self.masters[(master_key.id, login)] = s
        self.core.master_key_used(master_key)
        logger.info(f"master {login} ({ip}) connected: manager {manager.id}, key {master_key.id}, ea {s.version}")
        return s

    def _unregister(self, s: Session):
        if s.closed:
            return
        s.closed = True
        if s.kind == "slave":
            peers = self.slaves_by_portfolio.get(s.portfolio_id)
            if peers is not None:
                peers.discard(s)
                if not peers:
                    del self.slaves_by_portfolio[s.portfolio_id]
            if self.slave_by_license.get(s.license_id) is s:
                del self.slave_by_license[s.license_id]
        elif self.masters.get((s.key_id, s.login)) is s:
            del self.masters[(s.key_id, s.login)]

    # --- inbound ---

    def _inbound(self, s: Session, msg: str):
        self.core.stats["msgs"] += 1
        try:
            if s.kind == "slave":
                if msg.startswith("ACK|"):
                    _, epoch, seq = msg.split("|")
                    if int(epoch) == self.core.epoch:
                        s.last_ack_seq, s.last_ack_at = int(seq), self.clock()
                elif msg.startswith("EXEC|"):
                    self.core.handle_exec(msg.split("|"), portfolio_id=s.portfolio_id, login=s.login)
                elif msg.startswith("ACC|"):
                    self.core.handle_account("slave", s.license_id, s.login, msg.split("|")[1:])
                else:
                    self._warn(f"slave-msg:{s.license_id}", f"Unexpected message from slave {s.login}: {msg[:80]}")
                return
            if not msg.startswith(MASTER_MESSAGES):
                self._warn(f"master-msg:{s.key_id}", f"Unexpected message from master {s.login}: {msg[:80]}")
                return
            if msg.split("|", 2)[1] != str(s.login):
                self._warn(f"master-login:{s.key_id}", f"Master {s.login} sent a message for another login: {msg[:80]}")
                return
            manager = self.directory().managers_by_id.get(s.manager_id)  # Current status: a frozen manager opens nothing
            if manager is not None:
                self.core.handle_master(manager, msg)
        except Exception as e:
            self.core.stats["errors"] += 1
            if self._warn(f"error:{s.kind}:{s.login}", f"Error handling {msg[:120]!r} from {s.kind} {s.login}: {e}"):
                logger.exception("Inbound message failed")

    # --- outbound ---

    def fanout(self, portfolio_id: int, payload: str):
        """Called by the hub for every line published to a portfolio: POS, SNAP or HB."""
        for s in list(self.slaves_by_portfolio.get(portfolio_id, ())):
            if not s.outbox.put(s.view(payload)):
                self.stats["slow"] += 1
                self.kick(s, "slow", "connection too slow, reconnect to resynchronise", CLOSE_SLOW)

    # --- periodic: revocation, expiry, master heartbeats, public stats ---

    def tick(self):
        now = self.clock()
        directory = self.directory()
        if directory is not self._dir_seen or now >= self._next_reconcile:
            self._dir_seen = directory
            self._next_reconcile = now + 1.0  # Expiry is a matter of time, not of a directory change
            self.reconcile(now)
        if now >= self._next_heartbeat:
            self._next_heartbeat = now + self.heartbeat_seconds
            for s in list(self.masters.values()):
                if not s.outbox.put(f"HB|{self.core.epoch}|0"):
                    self.kick(s, "slow", "connection too slow", CLOSE_SLOW)
        for ip in [ip for ip, fails in self.failures.items() if not fails or now - fails[-1] > FAIL_WINDOW]:
            del self.failures[ip]
        self.public = self._public(now)

    def reconcile(self, now: float):
        directory = self.directory()
        for s in list(self.slave_by_license.values()):
            lic = directory.licenses_by_id.get(s.license_id)
            if lic is None or (lic.key_hash, lic.portfolio_id, lic.login) != (s.key_hash, s.portfolio_id, s.login):
                self.stats["revoked"] += 1
                self.kick(s, "revoked", "license key revoked or replaced", CLOSE_REVOKED)
                continue
            if lic.settings != s.settings:
                s.settings = lic.settings
                s.outbox.put(cfg_line(lic.settings))
            since = self._inactive_since(lic)
            changed = lic.max_lots != s.max_lots
            s.max_lots = lic.max_lots
            if since is not None and s.active:
                s.allowed = self.core.open_uids(s.portfolio_id, opened_before=since)
                changed = True
                logger.info(f"slave {s.login}: license {s.license_id} no longer valid, manage-only")
            elif since is None and not s.active:
                s.allowed = None
                s.outbox.put(s.lic())
                if not self.core.warming:  # Back to the full stream: positions it missed may be late entries
                    s.outbox.put(self.core.snapshot(s.portfolio_id))
                logger.info(f"slave {s.login}: license {s.license_id} valid again")
                continue
            if changed:
                s.outbox.put(s.lic())
        if self.inactive_seen:
            self.inactive_seen = {lid: t for lid, t in self.inactive_seen.items()
                                  if lid in directory.licenses_by_id and directory.licenses_by_id[lid].revoked_at is None
                                  and not directory.licenses_by_id[lid].is_active}
        valid_keys = {mk.id for mk in directory.master_keys_by_hash.values()}
        for s in list(self.masters.values()):
            if s.key_id not in valid_keys:
                self.stats["revoked"] += 1
                self.kick(s, "revoked", "master key revoked", CLOSE_REVOKED)

    def _inactive_since(self, lic) -> Optional[float]:
        """None while the license is valid, else since when it is not."""
        now = self.clock()
        since = []
        if lic.expires_at is not None and now >= lic.expires_at:
            since.append(lic.expires_at)
        if not lic.is_active:
            if lic.revoked_at is not None:
                since.append(lic.revoked_at)
            else:  # Revoked outside the API: from the first time this hub noticed
                since.append(self.inactive_seen.setdefault(lic.id, now))
        return min(since) if since else None

    def _public(self, now: float) -> dict:
        """Read by the health thread: built here, in the loop, and swapped whole."""
        seq = self.core.seq
        sessions = []
        for s in self.slave_by_license.values():
            sessions.append({
                "kind": "slave", "license_id": s.license_id, "portfolio_id": s.portfolio_id, "login": s.login,
                "ea_version": s.version, "connected_at": round(s.connected_at), "active": s.active,
                "max_lots": s.max_lots, "last_ack_seq": s.last_ack_seq,
                "lag": seq.get(s.portfolio_id, 0) - s.last_ack_seq if s.last_ack_seq is not None else None,
                "last_ack_age_s": round(now - s.last_ack_at, 1) if s.last_ack_at else None,
            })
        for s in self.masters.values():
            sessions.append({
                "kind": "master", "manager_id": s.manager_id, "key_id": s.key_id, "login": s.login,
                "ea_version": s.version, "connected_at": round(s.connected_at),
                "last_msg_age_s": round(now - s.last_rx, 1),
            })
        slaves = [x for x in sessions if x["kind"] == "slave"]
        lags = [x["lag"] for x in slaves if x["lag"] is not None]
        return {
            "masters": len(self.masters), "slaves": len(slaves),
            "manage_only": sum(1 for x in slaves if not x["active"]),
            "max_lag": max(lags) if lags else None, **self.stats, "sessions": sessions,
        }

    # --- abuse limits ---

    def _fail(self, ip: str):
        self.failures.setdefault(ip, deque()).append(self.clock())

    def _limited(self, ip: str) -> bool:
        fails = self.failures.get(ip)
        if not fails:
            return False
        now = self.clock()
        while fails and now - fails[0] > FAIL_WINDOW:
            fails.popleft()
        return len(fails) >= self.fails_per_ip

    def _warn(self, key: str, message: str, every: float = 60.0) -> bool:
        now = self.clock()
        if key in self._last_warn and now - self._last_warn[key] < every:
            return False
        if len(self._last_warn) > MAX_HELD_WARNINGS:
            self._last_warn.clear()
        self._last_warn[key] = now
        logger.warning(message)
        return True
