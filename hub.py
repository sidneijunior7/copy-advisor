"""
TDM Mirror signal hub. Runs as its own process/container, separate from the API.

Masters and Slaves connect over WebSocket (hub_ws.py, :8002 behind the proxy as wss://). Each one
authenticates with its own key, and a Slave only gets the portfolio of its license. Every message carries
the full state of one position (volume 0 = closed), so a slave that missed messages converges by applying
the periodic SNAP of its portfolio.

Master -> hub (after its HELLO)
    V2|login|reason|pos_id|type|symbol|vol|price_open|sl|tp|magic
    V2SYNC|login|pos_id,type,symbol,vol,price_open,sl,tp,magic;...
    V2HELLO|login|trade_mode|server|company                        (trade_mode: demo, contest, real)
Slave -> hub (after its HELLO)
    EXEC|login|-|uid|action|position_id|volume|price|retcode|seq
Hub -> the slaves of one portfolio
    POS|epoch|seq|uid|type|symbol|vol|price_open|sl|tp|magic|reason
    SNAP|epoch|seq|uid,type,symbol,vol,price_open,sl,tp,magic;...
    HB|epoch|seq
Hub -> API (ZMQ PUB :5558, internal network only)
    WEB <json>

The ZMQ ports Masters and Slaves used before the v4 EAs (5557 and 5556, no authentication) are gone.
"""
import asyncio
import datetime
import json
import logging
import os
import queue
import signal
import sys
import threading
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Dict, List, Optional, Tuple

import zmq
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError, DataError
from websockets.asyncio.server import serve

import database
import hub_ws
import keys
import models
import observability

logger = logging.getLogger("hub")

EVENTS_BIND = os.getenv("HUB_EVENTS_BIND", "tcp://*:5558")
HEALTH_PORT = int(os.getenv("HUB_HEALTH_PORT", "8001"))
WS_PORT = int(os.getenv("HUB_WS_PORT", "8002"))
WS_MAX_MESSAGE = 1_048_576  # A V2SYNC of a big Master fits; nothing a client sends needs more
# The events PUB only receives the API's subscription; without a cap libzmq would buffer a message of any size
EVENTS_MAX_MESSAGE = 4096
HEARTBEAT_SECONDS = float(os.getenv("HUB_HEARTBEAT_SECONDS", "5"))
SNAPSHOT_SECONDS = float(os.getenv("HUB_SNAPSHOT_SECONDS", "15"))
WARMUP_SECONDS = float(os.getenv("HUB_WARMUP_SECONDS", "20"))
DIRECTORY_TTL_SECONDS = float(os.getenv("HUB_DIRECTORY_TTL_SECONDS", "30"))
WRITE_QUEUE_SIZE = 10_000
STALE_LOOP_SECONDS = 15
SYNC_MISSES_TO_CLOSE = 2  # A position must be absent from this many V2SYNCs in a row before it is closed
CLOSED_MEMORY = 10_000    # Recently closed positions remembered so a late message can't reopen them
SENT_MEMORY = 10_000      # Published POS remembered to match execution reports (latency)
LATENCY_SAMPLES = 1_000   # Recent latencies behind the /health percentiles
PRICE_EPS = 1e-9
TRADE_MODES = ("demo", "contest", "real")
KEY_USED_EVERY = 3600     # master_keys.last_used_at is refreshed at most this often per key


def fmt(x: float) -> str:
    """Compact decimal without exponent (MQL5 StringToDouble-friendly)."""
    s = f"{x:.8f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


def changed(a: float, b: float) -> bool:
    return abs(a - b) > PRICE_EPS


# --- Directory: who is who (cached copy of users/strategies/portfolios) ---

@dataclass(frozen=True)
class ManagerInfo:
    id: int
    status: str


@dataclass(frozen=True)
class StrategyInfo:
    id: int
    manager_id: int
    name: str
    is_active: bool


@dataclass(frozen=True)
class MasterKeyInfo:
    id: int
    manager_id: int


@dataclass(frozen=True)
class LicenseInfo:
    id: int
    portfolio_id: int
    login: int
    max_lots: float
    is_active: bool
    expires_at: Optional[float]  # Unix time; None = no expiry
    key_hash: str
    revoked_at: Optional[float] = None  # Unix time the license was deactivated


@dataclass(frozen=True)
class Directory:
    managers_by_id: Dict[int, ManagerInfo] = field(default_factory=dict)
    master_keys_by_hash: Dict[str, MasterKeyInfo] = field(default_factory=dict)  # Revoked keys are left out
    strategies_by_magic: Dict[Tuple[int, int], StrategyInfo] = field(default_factory=dict)
    strategies_by_id: Dict[int, StrategyInfo] = field(default_factory=dict)
    portfolios_by_strategy: Dict[int, Tuple[int, ...]] = field(default_factory=dict)
    portfolio_ids: Tuple[int, ...] = ()
    licenses_by_hash: Dict[str, LicenseInfo] = field(default_factory=dict)  # Licenses with a key only
    licenses_by_id: Dict[int, LicenseInfo] = field(default_factory=dict)
    loaded_at: float = 0.0

    def master_for_key(self, key: str) -> Optional[Tuple[ManagerInfo, MasterKeyInfo]]:
        mk = self.master_keys_by_hash.get(keys.key_hash(key))
        manager = self.managers_by_id.get(mk.manager_id) if mk else None
        return (manager, mk) if manager else None


def _unix(dt: Optional[datetime.datetime]) -> Optional[float]:
    return dt.replace(tzinfo=datetime.timezone.utc).timestamp() if dt else None  # Stored as naive UTC


def load_directory(session) -> Directory:
    managers = {u.id: ManagerInfo(u.id, u.status or "active") for u in session.query(models.User).all()}
    master_keys = {k.key_hash: MasterKeyInfo(k.id, k.user_id)
                   for k in session.query(models.MasterKey).filter(models.MasterKey.revoked_at.is_(None))}
    by_magic, by_id = {}, {}
    for s in session.query(models.Strategy).all():
        info = StrategyInfo(s.id, s.user_id, s.name or "", bool(s.is_active))
        by_id[s.id] = info
        if s.magic_number is not None:
            by_magic[(s.user_id, int(s.magic_number))] = info
    by_strategy: Dict[int, List[int]] = {}
    for portfolio_id, strategy_id in session.execute(models.portfolio_items.select()).fetchall():
        by_strategy.setdefault(strategy_id, []).append(portfolio_id)
    portfolio_ids = [pid for (pid,) in session.query(models.Portfolio.id)]
    licenses = [
        LicenseInfo(l.id, l.portfolio_id, int(l.client_mt5_login or 0), float(l.max_lots or 0), bool(l.is_active),
                    _unix(l.expires_at), l.key_hash, _unix(l.revoked_at))
        for l in session.query(models.License).filter(models.License.key_hash.isnot(None),
                                                      models.License.portfolio_id.isnot(None))
    ]
    return Directory(
        managers_by_id=managers,
        master_keys_by_hash=master_keys,
        strategies_by_magic=by_magic,
        strategies_by_id=by_id,
        portfolios_by_strategy={k: tuple(sorted(v)) for k, v in by_strategy.items()},
        portfolio_ids=tuple(sorted(portfolio_ids)),
        licenses_by_hash={l.key_hash: l for l in licenses},
        licenses_by_id={l.id: l for l in licenses},
        loaded_at=time.time(),
    )


# --- Core logic (no sockets, no threads: unit-tested in tests/test_hub.py) ---

@dataclass
class PositionState:
    type: int
    symbol: str
    volume: float
    price_open: float
    sl: float
    tp: float
    magic: int


@dataclass
class Position:
    manager_id: int
    master_login: int
    pos_id: int
    strategy_id: int
    state: PositionState
    missing_syncs: int = 0
    opened_at: float = 0.0  # Unix time; what a revoked license may still follow is decided on it

    @property
    def uid(self) -> str:
        return f"{self.master_login}_{self.pos_id}"

    @property
    def key(self) -> Tuple[int, int, int]:
        return (self.manager_id, self.master_login, self.pos_id)


def parse_state(type_, symbol, vol, price_open, sl, tp, magic) -> PositionState:
    return PositionState(int(type_), symbol, float(vol), float(price_open), float(sl), float(tp), int(magic))


class HubCore:
    def __init__(
        self,
        directory: Callable[[], Directory],
        publish: Callable[[int, str], None],  # (portfolio_id, line): to the slaves of that portfolio
        web: Callable[[dict], None],
        persist: Callable[[dict], None],
        request_refresh: Callable[[], None] = lambda: None,
        epoch: Optional[int] = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.directory = directory
        self.publish = publish
        self.web = web
        self.persist = persist
        self.request_refresh = request_refresh
        # Milliseconds: a crash-restart can take under a second
        self.epoch = epoch if epoch is not None else int(time.time() * 1000)
        self.clock = clock

        self.positions: Dict[Tuple[int, int, int], Position] = {}
        self.closed: "OrderedDict[Tuple[int, int, int], None]" = OrderedDict()
        self.seq: Dict[int, int] = {}
        # (portfolio_id, seq) -> (uid, clock) of each POS, so an EXEC carrying that seq yields a latency
        self.sent: "OrderedDict[Tuple[int, int], Tuple[str, float]]" = OrderedDict()
        self.latencies: "deque[int]" = deque(maxlen=LATENCY_SAMPLES)
        # (manager_id, login) -> (trade_mode, server, company) from the last V2HELLO
        self.masters: Dict[Tuple[int, int], Tuple[str, str, str]] = {}
        self.key_used_at: Dict[int, float] = {}  # master key id -> clock of the last last_used_at write

        # Warm-up: no SNAP until open positions were loaded from the database and every
        # master login that had one sent a V2SYNC (or WARMUP_SECONDS passed since the load).
        self.warming = True
        self.loaded_at: Optional[float] = None
        self.pending_logins: set = set()

        self.next_heartbeat = 0.0
        self.next_snapshot = 0.0
        self.stats = {"msgs": 0, "errors": 0, "rejected": 0, "last_master_msg": None}
        self._last_warn: Dict[str, float] = {}

    # --- inbound ---

    def handle_master(self, manager: ManagerInfo, rest: str):
        """A message from an authenticated Master: V2, V2SYNC or V2HELLO. It is also what signals.raw and the
        logs get; the key travels only in the HELLO, so it never reaches either."""
        raw = rest
        self.stats["last_master_msg"] = time.time()
        if rest.startswith("V2SYNC|"):
            _, login, entries = rest.split("|", 2)
            self._handle_sync(manager, int(login), entries, raw=raw)
        elif rest.startswith("V2HELLO|"):
            self._handle_hello(manager, rest, raw=raw)
        elif rest.startswith("V2|"):
            f = rest.split("|")
            if len(f) != 11:
                self._warn("v2-size", f"Malformed V2 message: {raw[:120]}")
                return
            _, login, reason, pos_id, type_, symbol, vol, price_open, sl, tp, magic = f
            self.apply_state(manager, int(login), int(pos_id),
                             parse_state(type_, symbol, vol, price_open, sl, tp, magic),
                             reason=reason, raw=raw)
        else:
            self._warn(f"master-format:{manager.id}", f"Unknown Master message: {raw[:120]}")

    def _handle_sync(self, manager: ManagerInfo, login: int, entries: str, raw: str):
        seen = set()
        for entry in filter(None, entries.split(";")):
            f = entry.split(",")
            if len(f) != 8:
                self._warn("sync-entry", f"Malformed V2SYNC entry: {entry[:80]}")
                continue
            pos_id = int(f[0])
            seen.add(pos_id)
            self.apply_state(manager, login, pos_id, parse_state(*f[1:]), reason="SYNC", raw=None)

        for pos in [p for p in self.positions.values() if p.manager_id == manager.id and p.master_login == login]:
            if pos.pos_id in seen:
                continue
            pos.missing_syncs += 1
            if pos.missing_syncs >= SYNC_MISSES_TO_CLOSE:
                closed = PositionState(pos.state.type, pos.state.symbol, 0.0, pos.state.price_open,
                                       pos.state.sl, pos.state.tp, pos.state.magic)
                self.apply_state(manager, login, pos.pos_id, closed, reason="SYNC", raw=None)

        self.pending_logins.discard((manager.id, login))

    def _handle_hello(self, manager: ManagerInfo, rest: str, raw: str):
        """Recorded only: nothing is gated on the trade mode yet."""
        f = rest.split("|", 4)  # The broker's company name is free text, so it takes the remainder
        if len(f) != 5:
            self._warn("hello-size", f"Malformed V2HELLO message: {raw[:120]}")
            return
        _, login, trade_mode, server, company = f
        login = int(login)
        account = (trade_mode if trade_mode in TRADE_MODES else "unknown", server[:64], company[:128])
        previous = self.masters.get((manager.id, login))
        self.masters[(manager.id, login)] = account
        if previous is None:
            logger.info(f"Master {login} (manager {manager.id}): {account[0]} account on {account[1]} ({account[2]})")
        elif previous != account:
            logger.warning(f"Master {login} (manager {manager.id}) changed from {previous} to {account}")
        self.persist({
            "kind": "master_account",
            "manager_id": manager.id,
            "master_login": login,
            "trade_mode": account[0],
            "server": account[1],
            "company": account[2],
            "at": datetime.datetime.utcnow(),
        })

    def master_key_used(self, master_key: MasterKeyInfo):
        now = self.clock()
        last = self.key_used_at.get(master_key.id)
        if last is not None and now - last < KEY_USED_EVERY:
            return
        self.key_used_at[master_key.id] = now
        self.persist({"kind": "master_key_used", "id": master_key.id, "at": datetime.datetime.utcnow()})

    def handle_exec(self, f: List[str], portfolio_id: int, login: int):
        """EXEC|login|-|uid|action|position_id|volume|price|retcode|seq from a Slave session: the portfolio and
        the login are those of its license, not what the message says."""
        if len(f) != 10:
            self._warn("exec-size", f"Malformed EXEC: {'|'.join(f)[:120]}")
            return
        _, _, _, uid, action, position_id, volume, price, retcode, seq = f
        # The slave reports the last seq it applied. It only measures this execution when that POS was
        # about the same position; a late entry through SNAP still counts, from the POS it missed.
        latency_ms = None
        sent = self.sent.get((portfolio_id, int(seq)))
        if sent is not None and sent[0] == uid:
            latency_ms = max(0, round((self.clock() - sent[1]) * 1000))
            self.latencies.append(latency_ms)
        self.persist({
            "kind": "execution",
            "uid": uid,
            "portfolio_id": portfolio_id,
            "mt5_login": login,
            "action": action,
            "position_id": int(position_id),
            "volume": float(volume),
            "price": float(price),
            "retcode": int(retcode),
            "seq": int(seq),
            "latency_ms": latency_ms,
            "at": datetime.datetime.utcnow(),
        })

    def latency_stats(self) -> dict:
        samples = sorted(self.latencies)
        if not samples:
            return {"count": 0}
        pick = lambda q: samples[min(len(samples) - 1, int(q * len(samples)))]
        return {"count": len(samples), "p50": pick(0.5), "p95": pick(0.95), "max": samples[-1]}

    # --- state machine ---

    def apply_state(self, manager: ManagerInfo, login: int, pos_id: int, new: PositionState,
                    reason: str, raw: Optional[str]):
        key = (manager.id, login, pos_id)
        pos = self.positions.get(key)

        if pos is None:
            if new.volume <= 0:
                return
            if key in self.closed:
                self._warn(f"closed:{key}", f"Ignoring update for closed position {login}_{pos_id}")
                return
            # Gates apply only when a position is born. Updates and closes always flow,
            # so freezing a manager or deactivating a strategy never strands open copies.
            if manager.status != "active":
                self._reject(f"manager:{manager.id}", f"Manager {manager.id} is {manager.status}; not opening {login}_{pos_id}")
                return
            strategy = self.directory().strategies_by_magic.get((manager.id, new.magic))
            if strategy is None:
                # Manual trades (magic 0) show up in every V2SYNC: refresh at most once per warning window
                if self._reject(f"magic:{manager.id}:{new.magic}", f"No strategy for magic {new.magic} (manager {manager.id})"):
                    self.request_refresh()
                return
            if not strategy.is_active:
                self._reject(f"inactive:{strategy.id}", f"Strategy {strategy.id} inactive; not opening {login}_{pos_id}")
                return
            pos = Position(manager.id, login, pos_id, strategy.id, new, opened_at=time.time())
            self.positions[key] = pos
            self._emit(pos, reason=reason, raw=raw)
            return

        pos.missing_syncs = 0
        old = pos.state
        if new.volume <= 0:
            pos.state = PositionState(old.type, old.symbol, 0.0, old.price_open, old.sl, old.tp, old.magic)
            del self.positions[key]
            self.closed[key] = None
            while len(self.closed) > CLOSED_MEMORY:
                self.closed.popitem(last=False)
            self._emit(pos, reason=reason, raw=raw)
            return

        if not (new.type != old.type or changed(new.volume, old.volume) or changed(new.sl, old.sl)
                or changed(new.tp, old.tp) or changed(new.price_open, old.price_open)):
            return
        # Magic and strategy stay frozen: on a netting Master two magics can share one position
        pos.state = PositionState(new.type, new.symbol, new.volume, new.price_open, new.sl, new.tp, old.magic)
        self._emit(pos, reason=reason, raw=raw)

    # --- outbound ---

    def _next_seq(self, portfolio_id: int) -> int:
        self.seq[portfolio_id] = self.seq.get(portfolio_id, 0) + 1
        return self.seq[portfolio_id]

    @staticmethod
    def _entry(pos: Position) -> str:
        s = pos.state
        return ",".join([pos.uid, str(s.type), s.symbol, fmt(s.volume), fmt(s.price_open), fmt(s.sl), fmt(s.tp), str(s.magic)])

    def _emit(self, pos: Position, reason: str, raw: Optional[str]):
        s = pos.state
        directory = self.directory()
        for portfolio_id in directory.portfolios_by_strategy.get(pos.strategy_id, ()):
            seq = self._next_seq(portfolio_id)
            self.sent[(portfolio_id, seq)] = (pos.uid, self.clock())
            while len(self.sent) > SENT_MEMORY:
                self.sent.popitem(last=False)
            self.publish(portfolio_id, "|".join([
                "POS", str(self.epoch), str(seq), pos.uid, str(s.type), s.symbol, fmt(s.volume),
                fmt(s.price_open), fmt(s.sl), fmt(s.tp), str(s.magic), reason,
            ]))

        strategy =directory.strategies_by_id.get(pos.strategy_id)
        self.web({"type": "UPDATE", "data": {
            "key": f"{pos.strategy_id}_{pos.uid}",
            "action": reason,
            "manager_id": pos.manager_id,  # The API routes on it: each dashboard only sees its own manager
            "strategy_id": pos.strategy_id,
            "strategy_name": strategy.name if strategy else "",
            "ticket": pos.pos_id,
            "master_login": pos.master_login,
            "symbol": s.symbol,
            "type": s.type,
            "volume": s.volume,
            "price": s.price_open,
            "sl": s.sl,
            "tp": s.tp,
            "magic": s.magic,
            "timestamp": time.time(),
        }})

        self.persist({
            "kind": "position",
            "manager_id": pos.manager_id,
            "strategy_id": pos.strategy_id,
            "master_login": pos.master_login,
            "pos_id": pos.pos_id,
            "type": s.type,
            "symbol": s.symbol,
            "volume": s.volume,
            "price_open": s.price_open,
            "sl": s.sl,
            "tp": s.tp,
            "magic": s.magic,
            "reason": reason,
            "raw": raw,
            "closed": s.volume <= 0,
            "at": datetime.datetime.utcnow(),
        })

    def snapshot(self, portfolio_id: int) -> str:
        """Full state of one portfolio, as published every SNAPSHOT_SECONDS (a WSS Slave gets one on connect)."""
        directory = self.directory()
        entries = [self._entry(p) for p in self.positions.values()
                   if portfolio_id in directory.portfolios_by_strategy.get(p.strategy_id, ())]
        return f"SNAP|{self.epoch}|{self.seq.get(portfolio_id, 0)}|{';'.join(entries)}"

    def open_uids(self, portfolio_id: int, opened_before: float = float("inf")) -> set:
        directory = self.directory()
        return {p.uid for p in self.positions.values()
                if p.opened_at < opened_before and portfolio_id in directory.portfolios_by_strategy.get(p.strategy_id, ())}

    def publish_snapshots(self):
        directory = self.directory()
        by_portfolio: Dict[int, List[str]] = {pid: [] for pid in directory.portfolio_ids}
        for pos in self.positions.values():
            for portfolio_id in directory.portfolios_by_strategy.get(pos.strategy_id, ()):
                by_portfolio.setdefault(portfolio_id, []).append(self._entry(pos))
        for portfolio_id, entries in by_portfolio.items():
            seq = self.seq.get(portfolio_id, 0)
            self.publish(portfolio_id, f"SNAP|{self.epoch}|{seq}|{';'.join(entries)}")

    def publish_heartbeats(self):
        for portfolio_id in self.directory().portfolio_ids:
            self.publish(portfolio_id, f"HB|{self.epoch}|{self.seq.get(portfolio_id, 0)}")

    # --- startup / timers ---

    def load_positions(self, rows: List[dict]):
        """Merge open positions read from the database. Live state received meanwhile wins."""
        orphans = 0
        for r in rows:
            key = (r["manager_id"], r["master_login"], r["pos_id"])
            if key in self.positions or key in self.closed:
                continue
            if r["master_login"] == 0:
                # Opened by a Master EA older than v3, which didn't send its login: no Master can update or close
                # it any more, so it stays out of the snapshots and the slaves close their copies
                orphans += 1
                continue
            state = PositionState(r["type"], r["symbol"], r["volume"], r["price_open"] or 0.0,
                                  r["sl"] or 0.0, r["tp"] or 0.0, r["magic"] or 0)
            self.positions[key] = Position(r["manager_id"], r["master_login"], r["pos_id"], r["strategy_id"], state,
                                           opened_at=r.get("opened_at") or 0.0)
            self.pending_logins.add((r["manager_id"], r["master_login"]))
        if orphans:
            logger.warning(f"Left out {orphans} open positions of pre-v3 Masters (login 0): nothing can close them")
        self.loaded_at = self.clock()
        logger.info(f"Loaded {len(rows)} open positions; waiting V2SYNC from {len(self.pending_logins)} master logins")

    def tick(self):
        now = self.clock()
        if self.warming and self.loaded_at is not None:
            if not self.pending_logins or now - self.loaded_at >= WARMUP_SECONDS:
                self.warming = False
                if self.pending_logins:
                    logger.warning(f"Warm-up ended without V2SYNC from {sorted(self.pending_logins)}")
                logger.info("Warm-up done; publishing snapshots")
                self.publish_snapshots()
                self.next_snapshot = now + SNAPSHOT_SECONDS
        if now >= self.next_heartbeat:
            self.publish_heartbeats()
            self.next_heartbeat = now + HEARTBEAT_SECONDS
        if not self.warming and now >= self.next_snapshot:
            self.publish_snapshots()
            self.next_snapshot = now + SNAPSHOT_SECONDS

    # --- logging helpers ---

    def _warn(self, key: str, message: str, every: float = 60.0) -> bool:
        """Rate-limited warning. Returns True when it was actually logged."""
        now = self.clock()
        if key in self._last_warn and now - self._last_warn[key] < every:
            return False
        self._last_warn[key] = now
        logger.warning(message)
        return True

    def _reject(self, key: str, message: str) -> bool:
        self.stats["rejected"] += 1
        return self._warn(key, message)


# --- Database side (threads, so a slow database never delays a signal) ---

def _statement_timeout(session):
    # SET LOCAL is transaction-scoped, so it is safe behind a transaction-mode pooler
    if database.IS_POSTGRES:
        session.execute(text("SET LOCAL statement_timeout = 3000"))


def _is_connection_error(e: Exception) -> bool:
    return isinstance(e, DBAPIError) and not isinstance(e, (IntegrityError, DataError))


class DirectoryLoader(threading.Thread):
    def __init__(self):
        super().__init__(name="directory", daemon=True)
        self.current = Directory()
        self._wake = threading.Event()
        self._last_load = 0.0

    def request_refresh(self):
        self._wake.set()

    def run(self):
        while True:
            self._wake.wait(DIRECTORY_TTL_SECONDS)
            self._wake.clear()
            # On-demand refreshes (unknown key/magic) are rate-limited
            wait = 5.0 - (time.monotonic() - self._last_load)
            if wait > 0:
                time.sleep(wait)
            self.refresh()

    def refresh(self):
        self._last_load = time.monotonic()
        session = database.SessionLocal()
        try:
            _statement_timeout(session)
            self.current = load_directory(session)
        except Exception as e:
            logger.error(f"Directory refresh failed (keeping previous copy): {e}")
        finally:
            session.close()


class PositionLoader(threading.Thread):
    """Reads open positions at startup, retrying until the database answers."""

    def __init__(self, out: "queue.Queue[List[dict]]"):
        super().__init__(name="position-loader", daemon=True)
        self.out = out

    def run(self):
        while True:
            session = database.SessionLocal()
            try:
                _statement_timeout(session)
                rows = session.query(models.MasterPosition).filter(models.MasterPosition.closed_at.is_(None)).all()
                self.out.put([{
                    "manager_id": r.manager_id, "master_login": int(r.master_login), "pos_id": int(r.pos_id),
                    "strategy_id": r.strategy_id, "type": r.type, "symbol": r.symbol, "volume": r.volume,
                    "price_open": r.price_open, "sl": r.sl, "tp": r.tp, "magic": int(r.magic or 0),
                    "opened_at": _unix(r.opened_at) or 0.0,
                } for r in rows])
                return
            except Exception as e:
                logger.error(f"Could not load open positions (retrying in 5s): {e}")
                time.sleep(5)
            finally:
                session.close()


class Writer(threading.Thread):
    """Write-behind persistence. Keeps order; retries while the database is unreachable."""

    def __init__(self):
        super().__init__(name="writer", daemon=True)
        self.q: "queue.Queue[dict]" = queue.Queue(maxsize=WRITE_QUEUE_SIZE)
        self.dropped = 0
        self.failed = 0
        self.db_ok = True
        self.stopping = False

    def submit(self, job: dict):
        try:
            self.q.put_nowait(job)
        except queue.Full:
            self.dropped += 1
            if self.dropped % 1000 == 1:
                logger.error(f"Write queue full; dropped {self.dropped} jobs so far")

    def run(self):
        while True:
            job = self.q.get()
            if job is None:
                return
            attempts = 0
            while True:
                try:
                    self._write(job)
                    self.db_ok = True
                    break
                except Exception as e:
                    attempts += 1
                    if _is_connection_error(e) and not self.stopping:
                        self.db_ok = False
                        if attempts == 1:
                            logger.error(f"Database write failed, retrying: {e}")
                        time.sleep(min(5.0, 0.5 * attempts))
                        continue
                    if attempts < 3 and not self.stopping:
                        time.sleep(0.5)
                        continue
                    self.failed += 1
                    logger.error(f"Dropping {job.get('kind')} job after {attempts} attempts: {e}")
                    break

    def _write(self, job: dict):
        session = database.SessionLocal()
        try:
            _statement_timeout(session)
            if job["kind"] == "execution":
                session.add(models.Execution(**{k: v for k, v in job.items() if k not in ("kind", "at")}, created_at=job["at"]))
            elif job["kind"] == "master_account":
                self._write_master_account(session, job)
            elif job["kind"] == "master_key_used":
                session.query(models.MasterKey).filter_by(id=job["id"]).update({"last_used_at": job["at"]})
            else:
                self._write_position(session, job)
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    @staticmethod
    def _write_position(session, job: dict):
        at = job["at"]
        row = session.query(models.MasterPosition).filter_by(
            manager_id=job["manager_id"], master_login=job["master_login"], pos_id=job["pos_id"]).one_or_none()
        if row is None:
            row = models.MasterPosition(
                manager_id=job["manager_id"], strategy_id=job["strategy_id"], master_login=job["master_login"],
                pos_id=job["pos_id"], symbol=job["symbol"], type=job["type"], volume=job["volume"],
                price_open=job["price_open"], sl=job["sl"], tp=job["tp"], magic=job["magic"],
                opened_at=at, updated_at=at)
            session.add(row)
            session.flush()
        elif row.closed_at is not None:
            logger.warning(f"Skipping write for closed position {job['master_login']}_{job['pos_id']}")
            return
        if job["closed"]:
            row.closed_at = at  # Keep the last open volume on the row for history
        else:
            row.type, row.symbol, row.volume = job["type"], job["symbol"], job["volume"]
            row.price_open, row.sl, row.tp = job["price_open"], job["sl"], job["tp"]
        row.updated_at = at
        session.add(models.Signal(
            master_position_id=row.id, reason=job["reason"], type=job["type"], volume=job["volume"],
            price_open=job["price_open"], sl=job["sl"], tp=job["tp"], raw=job["raw"], received_at=at))

    @staticmethod
    def _write_master_account(session, job: dict):
        at = job["at"]
        row = session.query(models.MasterAccount).filter_by(
            manager_id=job["manager_id"], master_login=job["master_login"]).one_or_none()
        if row is None:
            row = models.MasterAccount(manager_id=job["manager_id"], master_login=job["master_login"], first_seen_at=at)
            session.add(row)
        row.trade_mode, row.server, row.company = job["trade_mode"], job["server"], job["company"]
        row.last_seen_at = at

    def stop(self, timeout: float):
        self.stopping = True
        try:
            self.q.put(None, timeout=timeout / 2)
        except queue.Full:
            pass
        self.join(timeout / 2)
        if self.is_alive():
            logger.error(f"Shutdown with {self.q.qsize()} database writes still queued")


# --- Runtime ---

class Hub:
    """One asyncio loop runs everything that touches HubCore: the WebSocket edge and the timers.
    Database work stays in threads (DirectoryLoader, Writer, PositionLoader)."""

    def __init__(self):
        self.ctx = zmq.Context()
        self.events = self._events_socket(self.ctx)  # PUB: send never blocks

        self.directory = DirectoryLoader()
        self.writer = Writer()
        self.loaded: "queue.Queue[List[dict]]" = queue.Queue()
        self.core = HubCore(
            directory=lambda: self.directory.current,
            publish=self._publish,
            web=self._web,
            persist=self.writer.submit,
            request_refresh=self.directory.request_refresh,
        )
        self.edge = hub_ws.Edge(self.core, directory=lambda: self.directory.current,
                                request_refresh=self.directory.request_refresh, heartbeat_seconds=HEARTBEAT_SECONDS)
        self.stop_event: Optional[asyncio.Event] = None
        self.started_at = time.time()
        self.last_loop = time.time()

    @staticmethod
    def _events_socket(ctx):
        s = ctx.socket(zmq.PUB)
        s.setsockopt(zmq.LINGER, 0)
        s.setsockopt(zmq.MAXMSGSIZE, EVENTS_MAX_MESSAGE)
        # Swarm's ingress drops idle TCP after ~15 min; keepalive keeps the API's subscription attached
        s.setsockopt(zmq.TCP_KEEPALIVE, 1)
        s.setsockopt(zmq.TCP_KEEPALIVE_IDLE, 60)
        s.setsockopt(zmq.TCP_KEEPALIVE_INTVL, 15)
        s.bind(EVENTS_BIND)
        return s

    def _publish(self, portfolio_id: int, payload: str):
        self.edge.fanout(portfolio_id, payload)

    def _web(self, event: dict):
        self.events.send_string("WEB " + json.dumps(event))

    def health(self) -> Tuple[int, dict]:
        now = time.time()
        last_msg = self.core.stats["last_master_msg"]
        loop_age = now - self.last_loop
        body = {
            "status": "healthy" if loop_age < STALE_LOOP_SECONDS else "stalled",
            "epoch": self.core.epoch,
            "warming": self.core.warming,
            "uptime_seconds": round(now - self.started_at),
            "last_loop_age_seconds": round(loop_age, 1),
            "last_master_msg_age_seconds": round(now - last_msg, 1) if last_msg else None,
            "open_positions": len(self.core.positions),
            "msgs": self.core.stats["msgs"],
            "errors": self.core.stats["errors"],
            "rejected": self.core.stats["rejected"],
            "exec_latency_ms": self.core.latency_stats(),
            "db_ok": self.writer.db_ok,
            "db_queue": self.writer.q.qsize(),
            "db_dropped": self.writer.dropped,
            "db_failed": self.writer.failed,
            "directory_age_seconds": round(now - self.directory.current.loaded_at) if self.directory.current.loaded_at else None,
            "ws": {k: v for k, v in self.edge.public.items() if k != "sessions"},
        }
        return (200 if loop_age < STALE_LOOP_SECONDS else 503), body

    def serve_health(self):
        hub = self

        class Handler(BaseHTTPRequestHandler):
            # Internal network only (8001 is not published): the API reads /health and /sessions and
            # calls /refresh after changing keys or licenses, so revocations apply at once
            def do_GET(self):
                if self.path == "/sessions":
                    code, body = 200, {"epoch": hub.core.epoch, "sessions": hub.edge.public.get("sessions", [])}
                elif self.path == "/refresh":
                    hub.directory.request_refresh()
                    code, body = 202, {"status": "refreshing"}
                else:
                    code, body = hub.health()
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("0.0.0.0", HEALTH_PORT), Handler)
        threading.Thread(target=server.serve_forever, name="health", daemon=True).start()

    def stop(self):
        if self.stop_event is not None:
            self.stop_event.set()

    async def run(self):
        self.stop_event = asyncio.Event()
        self.directory.refresh()
        self.directory.start()
        self.writer.start()
        PositionLoader(self.loaded).start()
        self.serve_health()
        server = await serve(self.edge.handler, "0.0.0.0", WS_PORT, process_request=self.edge.process_request,
                             compression=None, max_size=WS_MAX_MESSAGE, server_header=None,
                             ping_interval=20, ping_timeout=20)  # The MQL5 client answers pings
        logger.info(f"Hub up: ws :{WS_PORT}, events {EVENTS_BIND}, health :{HEALTH_PORT}, epoch {self.core.epoch}")
        tasks = [asyncio.create_task(self._ticker())]
        try:
            stopped = asyncio.create_task(self.stop_event.wait())
            done, _ = await asyncio.wait([stopped, *tasks], return_when=asyncio.FIRST_COMPLETED)
            for t in done:
                if t is not stopped and t.exception():
                    raise t.exception()  # A dead ticker is fatal: the orchestrator restarts us
        finally:
            for t in tasks:
                t.cancel()
            server.close()  # Clients get 1001 (going away) and reconnect with backoff
            try:
                await asyncio.wait_for(server.wait_closed(), 3)
            except asyncio.TimeoutError:
                pass

    async def _ticker(self):
        while True:
            try:
                self.core.load_positions(self.loaded.get_nowait())
            except queue.Empty:
                pass
            self.core.tick()
            self.edge.tick()
            self.last_loop = time.time()
            await asyncio.sleep(0.1)

    def shutdown(self):
        logger.info("Shutting down: flushing database writes")
        self.writer.stop(timeout=8)  # Swarm sends SIGKILL ~10s after SIGTERM
        self.ctx.destroy(linger=0)


async def amain(hub: Hub):
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, hub.stop)
        except NotImplementedError:  # Windows
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(hub.stop))
    await hub.run()


def main():
    observability.setup("hub")
    logging.getLogger("websockets").setLevel(logging.WARNING)  # One INFO line per connection otherwise; ours say more
    hub = Hub()
    try:
        asyncio.run(amain(hub))
    except Exception as e:
        # Anything outside per-message handling is fatal: exit so the orchestrator restarts us
        logger.exception(f"Hub crashed: {e}")
        hub.shutdown()
        sys.exit(1)
    hub.shutdown()


if __name__ == "__main__":
    main()
