
import asyncio
import datetime
import json
import logging
import re
import time
import urllib.error
import urllib.request
from collections import deque
from contextlib import asynccontextmanager
from typing import Dict, Optional, Tuple
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, Depends, HTTPException, status
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from sqlalchemy import func
from sqlalchemy.exc import InterfaceError, OperationalError, TimeoutError as PoolTimeoutError
from sqlalchemy.orm import Session
import uvicorn
import os
import threading
import zmq
from pydantic import BaseModel, Field

# Internal Imports
import clients
import dash_bridge
import database
import followers
import hosting
import keys
import mailer
import marketplace
import models
import auth
import backtest
import observability
import payments
import performance

observability.setup("api")
logger = logging.getLogger(__name__)

# The signal hub (hub.py) runs as a separate service; the API only relays its events to the dashboard.
# Schema is managed by Alembic: the container migrates in the background at startup (MIGRATE_ON_START=1,
# see SchemaState); elsewhere run `python migrate.py` before starting.
HUB_EVENTS_URL = os.getenv("HUB_EVENTS_URL", "tcp://127.0.0.1:5558")
HUB_HEALTH_URL = os.getenv("HUB_HEALTH_URL", "http://127.0.0.1:8001/health")
HUB_BASE_URL = HUB_HEALTH_URL.rsplit("/health", 1)[0]  # Same internal port: /sessions and /refresh
MAX_MASTER_KEYS = 20  # Active keys per manager
# The compiled EAs the dashboard offers: tools/compile_eas.ps1 -Publish writes them with manifest.json
EA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "downloads")
EA_KINDS = ("master", "slave")

# Browser origins allowed to call the API from another host (e.g. the Vite dev server).
# Empty in production: the dashboard is served by this same app.
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]

WS_AUTH_TIMEOUT = 5  # Seconds a dashboard has to send its token after connecting
WS_CLOSE_UNAUTHORIZED = 4401  # The client should log out instead of reconnecting
WS_CLOSE_FORBIDDEN = 4403
WS_CLOSE_TRY_LATER = 1013  # Database unavailable or still migrating

# Failed logins allowed per client IP inside the window, then 429 until it slides
AUTH_MAX_FAILURES = int(os.getenv("AUTH_MAX_FAILURES", "10"))
AUTH_FAILURE_WINDOW_SECONDS = float(os.getenv("AUTH_FAILURE_WINDOW_SECONDS", "600"))


class FailureLimiter:
    """Per-key sliding window of failures. In memory: the API runs as a single replica."""

    def __init__(self, max_failures: int, window: float, clock=time.monotonic):
        self.max_failures = max_failures
        self.window = window
        self.clock = clock
        self.failures: Dict[str, deque] = {}
        self.lock = threading.Lock()

    def _recent(self, key: str, now: float) -> deque:
        q = self.failures.get(key)
        if q is None:
            return deque()
        while q and now - q[0] >= self.window:
            q.popleft()
        if not q:
            del self.failures[key]
        return q

    def blocked(self, key: str) -> bool:
        with self.lock:
            return len(self._recent(key, self.clock())) >= self.max_failures

    def fail(self, key: str):
        with self.lock:
            now = self.clock()
            self._recent(key, now)
            self.failures.setdefault(key, deque()).append(now)
            if len(self.failures) > 100_000:  # Bound memory under a distributed attack
                self.failures.clear()

    def reset(self):
        with self.lock:
            self.failures.clear()


failure_limiter = FailureLimiter(AUTH_MAX_FAILURES, AUTH_FAILURE_WINDOW_SECONDS)

# The database is unreachable or saturated (not a bug): 503 and a log line, instead of a 500 and a traceback
DATABASE_DOWN = (OperationalError, InterfaceError, PoolTimeoutError)


class OutageLog:
    """Logs a failure that repeats for as long as an outage lasts at most once per `every` seconds, with how
    many happened in between. A dashboard reconnecting every few seconds otherwise wrote ~170 MB of
    tracebacks a day while the database was down."""

    def __init__(self, every: float = 60.0, clock=time.monotonic):
        self.every = every
        self.clock = clock
        self.last: Optional[float] = None
        self.folded = 0
        self.lock = threading.Lock()

    def __call__(self, where: str, e: Exception) -> bool:
        with self.lock:
            now = self.clock()
            if self.last is not None and now - self.last < self.every:
                self.folded += 1
                return False
            folded, self.folded, self.last = self.folded, 0, now
        detail = (str(e).strip().splitlines() or [""])[0][:200]
        more = f" ({folded} more since the last report)" if folded else ""
        logger.error(f"Database unavailable in {where}: {type(e).__name__}: {detail}{more}")
        return True


database_outage = OutageLog()


class SchemaState:
    """Whether the database is at the code's migration head. The container migrates in a thread
    (MIGRATE_ON_START=1), so the API comes up and answers /health/live with the database away: running
    migrate.py before uvicorn made a database outage at boot restart the container in a loop. Data routes
    answer 503 until it is done. Without MIGRATE_ON_START (tests, `python server.py`) the schema was
    migrated beforehand."""

    def __init__(self):
        self.state = "ready"  # pending, ready or failed

    @property
    def ready(self) -> bool:
        return self.state == "ready"


schema = SchemaState()
MIGRATE_RETRY_MAX_SECONDS = 30.0


def migrate_in_background(sleep=time.sleep):
    import migrate  # Alembic only loads when this process migrates

    delay = 2.0
    while True:
        try:
            migrate.main(retries=1)
            schema.state = "ready"
            logger.info("Database schema is current: data routes enabled")
            return
        except DATABASE_DOWN as e:  # Unreachable, or lost mid-migration (Postgres rolled it back): try again
            database_outage("migration", e)
            sleep(delay)
            delay = min(delay * 2, MIGRATE_RETRY_MAX_SECONDS)
        except Exception as e:  # A broken migration doesn't fix itself: data routes stay at 503 until a new deploy
            schema.state = "failed"
            logger.exception(f"Migration failed: {e}")
            return


def client_ip(request: Request) -> str:
    # Behind EasyPanel's proxy uvicorn rewrites request.client from X-Forwarded-For (FORWARDED_ALLOW_IPS)
    return request.client.host if request.client else "unknown"


def check_not_limited(scope: str, request: Request):
    if failure_limiter.blocked(f"{scope}:{client_ip(request)}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many failed attempts, try again later")

# Accounts with no dashboard access (a TDM_DEV is never locked out by status)
def is_blocked(user: models.User) -> bool:
    return user.status != "active" and user.role != "TDM_DEV"


def open_positions_state(manager_id: Optional[int]) -> Dict[str, dict]:
    """Open Master positions, keyed like the hub's WEB events ("strategyId_login_posId").
    manager_id None = every manager (TDM_DEV)."""
    db = database.SessionLocal()
    try:
        query = (
            db.query(models.MasterPosition, models.Strategy.name)
            .join(models.Strategy, models.Strategy.id == models.MasterPosition.strategy_id)
            .filter(models.MasterPosition.closed_at.is_(None))
        )
        if manager_id is not None:
            query = query.filter(models.MasterPosition.manager_id == manager_id)
        rows = query.all()
        state = {}
        for p, strategy_name in rows:
            key = f"{p.strategy_id}_{p.master_login}_{p.pos_id}"
            state[key] = {
                "key": key,
                "strategy_id": p.strategy_id,
                "strategy_name": strategy_name,
                "ticket": p.pos_id,
                "master_login": p.master_login,
                "symbol": p.symbol,
                "type": p.type,
                "volume": p.volume,
                "price": p.price_open,
                "sl": p.sl,
                "tp": p.tp,
                "magic": p.magic,
                "timestamp": (p.updated_at or p.opened_at).replace(tzinfo=datetime.timezone.utc).timestamp(),
            }
        return state
    finally:
        db.close()


# --- Web dashboard relay ---
class TradeManager:
    def __init__(self):
        # Authenticated dashboards and the manager each one may see (None = all, for TDM_DEV)
        self.web_clients: Dict[WebSocket, Optional[int]] = {}

    async def connect_web(self, websocket: WebSocket, manager_id: Optional[int]):
        self.web_clients[websocket] = manager_id
        logger.info(f"New Web Client connected. Total: {len(self.web_clients)}")
        # Send current state
        trades = await asyncio.to_thread(open_positions_state, manager_id)
        await websocket.send_json({"type": "STATE", "trades": trades})

    def disconnect_web(self, websocket: WebSocket):
        self.web_clients.pop(websocket, None)
        logger.info(f"Web Client disconnected. Total: {len(self.web_clients)}")

    async def broadcast_to_web(self, message: dict):
        if not self.web_clients:
            return

        # Events without an owner (a hub older than this API) only go to TDM_DEV: fail closed
        data = message.get("data") or {}
        owner = data.get("manager_id")
        public = {**message, "data": {k: v for k, v in data.items() if k != "manager_id"}} if data else message

        disconnected = []
        for client, scope in list(self.web_clients.items()):  # Clients may connect while we await a send
            if scope is not None and scope != owner:
                continue
            try:
                await client.send_json(public)
            except Exception as e:
                logger.error(f"Error sending to web client: {e}")
                disconnected.append(client)

        for client in disconnected:
            self.web_clients.pop(client, None)

    def relay_hub_events(self, loop: asyncio.AbstractEventLoop, stop: threading.Event):
        """
        Forward the hub's WEB events to dashboard clients. Runs in a thread with a plain ZMQ socket,
        so it works on any event loop (zmq.asyncio fails on Windows' Proactor loop).
        ZMQ reconnects by itself if the hub restarts.
        """
        sub = zmq.Context.instance().socket(zmq.SUB)
        sub.setsockopt(zmq.LINGER, 0)
        # Swarm's ingress drops idle TCP after ~15 min; keepalive keeps the subscription alive overnight
        sub.setsockopt(zmq.TCP_KEEPALIVE, 1)
        sub.setsockopt(zmq.TCP_KEEPALIVE_IDLE, 60)
        sub.setsockopt(zmq.TCP_KEEPALIVE_INTVL, 15)
        sub.connect(HUB_EVENTS_URL)
        sub.subscribe("WEB ")
        logger.info(f"Relaying hub events from {HUB_EVENTS_URL}")
        try:
            while not stop.is_set():
                if not sub.poll(500):
                    continue
                msg = sub.recv_string()
                try:
                    event = json.loads(msg[4:])
                except ValueError as e:
                    logger.error(f"Invalid hub event: {e}")
                    continue
                asyncio.run_coroutine_threadsafe(self.broadcast_to_web(event), loop)
        finally:
            sub.close()

trade_manager = TradeManager()

# --- FastAPI App ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.getenv("MIGRATE_ON_START") == "1":
        schema.state = "pending"
        threading.Thread(target=migrate_in_background, name="migrate", daemon=True).start()
    stop = threading.Event()
    relay = threading.Thread(target=trade_manager.relay_hub_events, args=(asyncio.get_running_loop(), stop),
                             name="hub-relay", daemon=True)
    relay.start()
    if dash_bridge.INTERVAL > 0:
        threading.Thread(target=dash_bridge.run_forever, args=(stop,), name="dash-bridge", daemon=True).start()
    yield
    stop.set()
    relay.join(2)

app = FastAPI(lifespan=lifespan)


async def database_unavailable(request: Request, exc: Exception):
    database_outage(request.url.path, exc)
    return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        content={"detail": "Database unavailable, try again shortly"})

for _error in DATABASE_DOWN:
    app.add_exception_handler(_error, database_unavailable)
if CORS_ORIGINS:
    from fastapi.middleware.cors import CORSMiddleware
    # The token travels in the Authorization header, not in cookies: no credentials needed
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")

# --- Dependencies ---
# Routes that touch the database are plain `def`: FastAPI runs them in its thread pool. The SQLAlchemy calls
# block, and inside `async def` a slow or unreachable database stalled every request, /health/live included,
# until Docker restarted the API.
def get_session():
    db = database.SessionLocal()
    try:
        yield db
    finally:
        db.close()

def get_db(db: Session = Depends(get_session)):
    """The session of a data route: 503 until the schema is current (see SchemaState)."""
    if not schema.ready:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Starting up, try again shortly")
    return db

def user_from_token(token: str, db: Session) -> Optional[models.User]:
    """The account behind a valid, unexpired token, or None."""
    payload = auth.decode_token(token)
    email = payload.get("sub") if payload else None
    if not email:
        return None
    user = db.query(models.User).filter(models.User.email == email).first()
    # A password change ends every session that began before it
    if user is not None and user.password_changed_at is not None and \
            payload.get("auth_time", 0) < int(user.password_changed_at.replace(tzinfo=datetime.timezone.utc).timestamp()):
        return None
    return user

def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    user = user_from_token(token, db)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    # A manager frozen after logging in loses access at once, not when the token expires
    if is_blocked(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Account is {user.status}")
    return user

# --- Pydantic Schemas ---
class UserCreate(BaseModel):
    email: str
    password: str
    role: str = "CLIENT" # MANAGER or CLIENT

class Token(BaseModel):
    access_token: str
    token_type: str

class StrategyCreate(BaseModel):
    name: str
    magic_number: int

class PortfolioCreate(BaseModel):
    name: str

# The hub only publishes portfolio topics (P_<id>): to sell one strategy, put it in its own portfolio
class LicenseCreate(BaseModel):
    client_mt5_login: int
    max_lots: float = Field(gt=0)
    portfolio_id: int
    expires_at: Optional[datetime.datetime] = None

# The Slave gets changes within seconds: the API asks the hub to refresh
class LicenseUpdate(BaseModel):
    max_lots: Optional[float] = Field(default=None, gt=0)
    is_active: Optional[bool] = None
    expires_at: Optional[datetime.datetime] = None  # Sent as null: no expiry. Left out: unchanged

class MasterKeyCreate(BaseModel):
    label: str = Field(min_length=1, max_length=64)


def utc_naive(dt: Optional[datetime.datetime]) -> Optional[datetime.datetime]:
    """The database keeps naive UTC."""
    if dt is not None and dt.tzinfo is not None:
        dt = dt.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    return dt


def license_out(lic: models.License, key: Optional[str] = None) -> dict:
    """Never the key hash. The plain key only right after it is created, never again."""
    out = {
        "id": lic.id, "portfolio_id": lic.portfolio_id, "strategy_id": lic.strategy_id,
        "client_mt5_login": lic.client_mt5_login, "max_lots": lic.max_lots, "is_active": lic.is_active,
        "created_at": lic.created_at, "expires_at": lic.expires_at, "revoked_at": lic.revoked_at,
        "key_prefix": lic.key_prefix, "has_key": lic.key_hash is not None,
        "client": {"email": lic.client.email, "name": lic.client.name} if lic.client else None,
        "claim_expires_at": lic.claim_expires_at if lic.claim_hash else None,
        "settings": clients.settings_of(lic),
    }
    if key is not None:
        out["license_key"] = key
    return out


def master_key_out(mk: models.MasterKey, key: Optional[str] = None) -> dict:
    out = {"id": mk.id, "label": mk.label, "key_prefix": mk.key_prefix, "created_at": mk.created_at,
           "last_used_at": mk.last_used_at, "revoked_at": mk.revoked_at}
    if key is not None:
        out["key"] = key
    return out


def set_license_key(lic: models.License) -> str:
    key = keys.new_key(keys.LICENSE)
    lic.key_hash, lic.key_prefix = keys.key_hash(key), keys.key_prefix(key)
    return key


def notify_hub():
    """Keys and licenses changed: the hub reloads its directory now instead of within 30 s, so a revoked
    key or license is cut off at once. Best effort; never delays the response."""
    def call():
        try:
            urllib.request.urlopen(f"{HUB_BASE_URL}/refresh", timeout=1).close()
        except Exception as e:
            logger.warning(f"Could not ask the hub to refresh: {e}")
    threading.Thread(target=call, name="hub-refresh", daemon=True).start()


def ea_releases() -> Dict[str, dict]:
    """downloads/manifest.json: version, file, size, SHA-256 and build time of each EA. An entry whose file is
    missing, or that names anything but a file in that folder, is left out."""
    try:
        with open(os.path.join(EA_DIR, "manifest.json"), encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError) as e:
        logger.warning(f"No EA manifest in {EA_DIR}: {e}")
        return {}
    releases = {}
    for kind in EA_KINDS:
        info = manifest.get(kind) if isinstance(manifest, dict) else None
        name = info.get("file") if isinstance(info, dict) else None
        if isinstance(name, str) and os.path.basename(name) == name and os.path.isfile(os.path.join(EA_DIR, name)):
            releases[kind] = {k: info.get(k) for k in ("version", "file", "size", "sha256", "built_at")}
    return releases


def fetch_hub_sessions() -> Optional[list]:
    try:
        with urllib.request.urlopen(f"{HUB_BASE_URL}/sessions", timeout=1) as resp:
            return json.loads(resp.read())["sessions"]
    except Exception as e:
        logger.warning(f"Could not read hub sessions: {e}")
        return None

# --- API Routes ---

def ws_session(token) -> Tuple[Optional[Tuple[int, Optional[int], float]], int]:
    """((user_id, manager scope, token expiry), 0) for a dashboard token, or (None, close code)."""
    if not isinstance(token, str):
        return None, WS_CLOSE_UNAUTHORIZED
    db = database.SessionLocal()
    try:
        user = user_from_token(token, db)
        if user is None:
            return None, WS_CLOSE_UNAUTHORIZED
        # Clients have no link to a manager yet, so there is nothing they may watch
        if is_blocked(user) or user.role not in ("MANAGER", "TDM_DEV"):
            return None, WS_CLOSE_FORBIDDEN
        scope = None if user.role == "TDM_DEV" else user.id
        return (user.id, scope, float(auth.decode_token(token)["exp"])), 0
    finally:
        db.close()

async def receive_auth(websocket: WebSocket, timeout: float) -> Optional[str]:
    """The token of the next {"type": "AUTH", "token": ...} message; None on timeout or anything else."""
    try:
        msg = await asyncio.wait_for(websocket.receive_json(), timeout)
    except (asyncio.TimeoutError, ValueError):
        return None
    return msg.get("token") if isinstance(msg, dict) and msg.get("type") == "AUTH" else None

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # Browsers can't set headers on a WebSocket, and a token in the URL ends up in proxy logs:
    # the first message carries it instead.
    await websocket.accept()
    try:
        if not schema.ready:
            await websocket.close(code=WS_CLOSE_TRY_LATER)
            return
        session, close_code = await asyncio.to_thread(ws_session, await receive_auth(websocket, WS_AUTH_TIMEOUT))
        if session is None:
            await websocket.close(code=close_code)
            return
        user_id, scope, expires_at = session

        await trade_manager.connect_web(websocket, scope)
        # The connection lives as long as the token; the dashboard re-sends AUTH after each refresh
        while True:
            remaining = expires_at - time.time()
            token = await receive_auth(websocket, remaining) if remaining > 0 else None
            if token is None:
                if remaining > 0:
                    continue  # Keepalive or unknown message: ignore
                await websocket.close(code=WS_CLOSE_UNAUTHORIZED)  # Token expired without a refresh
                return
            renewed, close_code = await asyncio.to_thread(ws_session, token)
            if renewed is None or renewed[0] != user_id:
                await websocket.close(code=close_code or WS_CLOSE_UNAUTHORIZED)
                return
            expires_at = renewed[2]
    except WebSocketDisconnect:
        pass
    except DATABASE_DOWN as e:
        database_outage("/ws", e)
        try:
            await websocket.close(code=WS_CLOSE_TRY_LATER)  # The dashboard retries with backoff
        except RuntimeError:  # Already closed by the client
            pass
    finally:
        trade_manager.disconnect_web(websocket)

def fetch_hub_health() -> dict:
    try:
        with urllib.request.urlopen(HUB_HEALTH_URL, timeout=1) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:  # 503 = hub loop stalled; the body still has the details
        try:
            return json.loads(e.read())
        except Exception:
            return {"status": "error", "message": f"HTTP {e.code}"}
    except Exception as e:
        return {"status": "unreachable", "message": str(e)}

@app.get("/health/live", include_in_schema=False)
async def liveness():
    """Container healthcheck: the process answers. A database outage must not make Docker restart the API
    in a loop (migrate.py would fail on every boot); /health reports it instead."""
    return {"status": "alive"}

@app.get("/health")
@app.get("/api/health")
def health_check(db: Session = Depends(get_session)):
    db_type = "PostgreSQL (Supabase)" if database.IS_POSTGRES else "SQLite (Local)"
    hub = fetch_hub_health()
    try:
        user_count = db.query(models.User).count()
    except Exception as e:
        database_outage("/health", e)
        # Only a dead database makes the API itself unhealthy; hub problems are reported, not fatal.
        # The error stays in the log: it can name the database host and user.
        return JSONResponse(status_code=503, content={"status": "error", "database": "unavailable",
                                                      "schema": schema.state, "hub": hub})
    if not schema.ready:  # Migrating at startup, or the migration failed: data routes answer 503
        return JSONResponse(status_code=503, content={"status": "starting" if schema.state == "pending" else "error",
                                                      "schema": schema.state, "hub": hub})

    return {
        "status": "healthy" if hub.get("status") == "healthy" and not hub.get("warming") else "degraded",
        "version": "v2026.09.15",
        "database_type": db_type,
        "user_count": user_count,
        "schema": schema.state,
        "hub": hub,
    }

@app.post("/token", response_model=Token)
def login_for_access_token(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    check_not_limited("login", request)
    logger.info(f"Login attempt for user: {form_data.username}")
    user = db.query(models.User).filter(func.lower(models.User.email) == form_data.username.strip().lower()).first()

    if not user:
        failure_limiter.fail(f"login:{client_ip(request)}")
        logger.warning(f"Login failed: User {form_data.username} not found")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")

    valid, needs_rehash = auth.verify_password(form_data.password, user.password_hash)
    if not valid:
        failure_limiter.fail(f"login:{client_ip(request)}")
        logger.warning(f"Login failed: Incorrect password for user {form_data.username}")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    
    if is_blocked(user):
        logger.warning(f"Login failed: Account {user.email} is {user.status}")
        raise HTTPException(status_code=403, detail=f"Account is {user.status}")

    # sha256_crypt hashes become bcrypt the first time the plain password is available
    if needs_rehash and not auth.validate_password(form_data.password):
        user.password_hash = auth.get_password_hash(form_data.password)
        db.commit()
        logger.info(f"Password hash of {user.email} upgraded to bcrypt")
    
    access_token = auth.create_access_token(data={"sub": user.email, "role": user.role})
    logger.info(f"Login successful for user: {user.email}")
    return {"access_token": access_token, "token_type": "bearer"}

@app.post("/token/refresh", response_model=Token)
def refresh_access_token(token: str = Depends(oauth2_scheme), current_user: models.User = Depends(get_current_user)):
    """A new token for a still-valid one. The session still ends SESSION_MAX_HOURS after the login."""
    auth_time = auth.decode_token(token).get("auth_time")
    access_token = auth.create_access_token(data={"sub": current_user.email, "role": current_user.role},
                                            session_start=auth_time)
    return {"access_token": access_token, "token_type": "bearer"}

@app.get("/admin/managers")
def list_managers(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "TDM_DEV": raise HTTPException(status_code=403)
    managers = db.query(models.User).filter(models.User.role == "MANAGER").all()
    # Mask passwords
    for m in managers: m.password_hash = "***"
    return managers

@app.post("/admin/managers")
def create_manager(user: UserCreate, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "TDM_DEV": raise HTTPException(status_code=403)
    if db.query(models.User).filter(models.User.email == user.email).first():
        raise HTTPException(status_code=400, detail="Email already registered")
    password_error = auth.validate_password(user.password)
    if password_error:
        raise HTTPException(status_code=400, detail=password_error)
    
    hashed_password = auth.get_password_hash(user.password)
    # Managers created by Dev are active by default, or frozen? Let's say active.
    new_user = models.User(email=user.email, password_hash=hashed_password, role="MANAGER", status="active")
    db.add(new_user)
    db.commit()
    return {"message": "Manager created successfully"}

@app.patch("/admin/managers/{user_id}/status")
def update_manager_status(user_id: int, status: str, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "TDM_DEV": raise HTTPException(status_code=403)
    if status not in ["active", "frozen", "archived"]: raise HTTPException(status_code=400, detail="Invalid status")
    
    manager = db.query(models.User).filter(models.User.id == user_id).first()
    if not manager: raise HTTPException(status_code=404)
    manager.status = status
    db.commit()
    return {"message": f"Manager status updated to {status}"}

@app.post("/strategies")
def create_strategy(strategy: StrategyCreate, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    
    # Check if Magic Number already exists for this user
    existing = db.query(models.Strategy).filter(models.Strategy.user_id == current_user.id, models.Strategy.magic_number == strategy.magic_number).first()
    if existing:
        raise HTTPException(status_code=400, detail="Magic Number already exists for this account")

    new_strategy = models.Strategy(user_id=current_user.id, name=strategy.name, magic_number=strategy.magic_number)
    db.add(new_strategy)
    db.commit()
    db.refresh(new_strategy)
    return new_strategy

@app.get("/strategies")
def list_strategies(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    return current_user.strategies

@app.post("/portfolios")
def create_portfolio(portfolio: PortfolioCreate, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    new_portfolio = models.Portfolio(user_id=current_user.id, name=portfolio.name)
    db.add(new_portfolio)
    db.commit()
    db.refresh(new_portfolio)
    return new_portfolio

@app.get("/portfolios")
def list_portfolios(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    result = []
    for p in current_user.portfolios:
        result.append({
            "id": p.id,
            "name": p.name,
            "strategies": [
                {"id": s.id, "name": s.name, "magic_number": s.magic_number}
                for s in p.strategies
            ],
            "client_limits": clients.limits_of(p).model_dump(),
            "master_login": p.master_login,
        })
    return result

@app.get("/me/manager")
def get_manager_details(current_user: models.User = Depends(get_current_user)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    return {
        "id": current_user.id,
        "email": current_user.email,
        "status": current_user.status
    }

# --- Master keys (SEC-08): one per Master/VPS, shown once, revoked one by one ---

@app.get("/me/master-keys")
def list_master_keys(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    rows = db.query(models.MasterKey).filter(models.MasterKey.user_id == current_user.id).order_by(models.MasterKey.id).all()
    return [master_key_out(mk) for mk in rows]

@app.post("/me/master-keys")
def create_master_key(data: MasterKeyCreate, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The key is in this response only: the database keeps its hash."""
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    active = db.query(models.MasterKey).filter(models.MasterKey.user_id == current_user.id,
                                               models.MasterKey.revoked_at.is_(None)).count()
    if active >= MAX_MASTER_KEYS:
        raise HTTPException(status_code=409, detail=f"Limite de {MAX_MASTER_KEYS} chaves ativas: revogue uma antes")
    key = keys.new_key(keys.MASTER)
    mk = models.MasterKey(user_id=current_user.id, label=data.label.strip(), key_hash=keys.key_hash(key),
                          key_prefix=keys.key_prefix(key))
    db.add(mk)
    db.commit()
    db.refresh(mk)
    logger.info(f"Master key {mk.id} ({mk.key_prefix}) created by manager {current_user.id}")
    notify_hub()
    return master_key_out(mk, key)

@app.delete("/me/master-keys/{key_id}")
def revoke_master_key(key_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The hub drops the Masters connected with it at once."""
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    mk = db.get(models.MasterKey, key_id)
    if mk is None or mk.user_id != current_user.id: raise HTTPException(status_code=404)
    if mk.revoked_at is None:
        mk.revoked_at = datetime.datetime.utcnow()
        db.commit()
        logger.info(f"Master key {mk.id} ({mk.key_prefix}) revoked by manager {current_user.id}")
        notify_hub()
    db.refresh(mk)
    return master_key_out(mk)

@app.get("/me/connections")
def list_connections(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Masters and Slaves connected to the hub right now."""
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    latest = {kind: release["version"] for kind, release in ea_releases().items()}  # Flags terminals to update
    sessions = fetch_hub_sessions()
    if sessions is None:
        return {"available": False, "masters": [], "slaves": [], "latest": latest}
    portfolios = {p.id: p.name for p in current_user.portfolios}
    labels = {mk.id: mk.label for mk in db.query(models.MasterKey).filter(models.MasterKey.user_id == current_user.id)}
    masters = [{**s, "key_label": labels.get(s["key_id"])} for s in sessions
               if s["kind"] == "master" and s["manager_id"] == current_user.id]
    slaves = [{**s, "portfolio_name": portfolios[s["portfolio_id"]]} for s in sessions
              if s["kind"] == "slave" and s["portfolio_id"] in portfolios]
    return {"available": True, "masters": masters, "slaves": slaves, "latest": latest}

@app.get("/ea/releases")
def list_ea_releases(current_user: models.User = Depends(get_current_user)):
    """The Master and Slave EAs a manager installs; a client gets the Slave only."""
    kinds = ea_kinds_for(current_user)
    return {kind: release for kind, release in ea_releases().items() if kind in kinds}

def ea_kinds_for(user: models.User) -> Tuple[str, ...]:
    if user.role == "MANAGER": return EA_KINDS
    if user.role == "CLIENT": return ("slave",)
    raise HTTPException(status_code=403)

@app.get("/ea/releases/{kind}")
def download_ea(kind: str, current_user: models.User = Depends(get_current_user)):
    release = ea_releases().get(kind) if kind in ea_kinds_for(current_user) else None
    if release is None: raise HTTPException(status_code=404)
    # no-store: a browser would otherwise hand the cached file to a later request without the token
    return FileResponse(os.path.join(EA_DIR, release["file"]), media_type="application/octet-stream",
                        filename=release["file"], headers={"Cache-Control": "no-store"})

@app.get("/me/copy-issues")
def list_copy_issues(days: int = 7, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Copies the Slaves of this manager's portfolios could not make, or made smaller, in the last `days` days:
    the broker refused the order, there was not enough margin, or the license's lot limit held part of it back
    (the volume is what was left out). Each Slave reports a given failure once. Newest first, at most 200."""
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    portfolios = {p.id: p.name for p in current_user.portfolios}
    if not portfolios:
        return []
    since = datetime.datetime.utcnow() - datetime.timedelta(days=max(1, min(days, 90)))
    rows = (db.query(models.Execution)
            .filter(models.Execution.portfolio_id.in_(portfolios), models.Execution.created_at >= since,
                    models.Execution.retcode.notin_(models.EXECUTION_DONE))
            .order_by(models.Execution.created_at.desc(), models.Execution.id.desc()).limit(200).all())
    licenses = {(l.portfolio_id, l.client_mt5_login): l.id
                for l in db.query(models.License).filter(models.License.portfolio_id.in_(portfolios))}
    return [{"at": r.created_at, "portfolio_id": r.portfolio_id, "portfolio_name": portfolios[r.portfolio_id],
             "login": r.mt5_login, "license_id": licenses.get((r.portfolio_id, r.mt5_login)), "uid": r.uid,
             "action": r.action, "volume": r.volume, "retcode": r.retcode} for r in rows]

@app.get("/licenses")
def list_licenses(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    # Join nicely to show context
    licenses = db.query(models.License).filter(
        (models.License.strategy_id.in_([s.id for s in current_user.strategies])) | 
        (models.License.portfolio_id.in_([p.id for p in current_user.portfolios]))
    ).all()
    return [license_out(lic) for lic in licenses]

@app.post("/portfolios/{portfolio_id}/add_strategy/{strategy_id}")
def add_strategy_to_portfolio(portfolio_id: int, strategy_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    portfolio = db.query(models.Portfolio).filter(models.Portfolio.id == portfolio_id, models.Portfolio.user_id == current_user.id).first()
    strategy = db.query(models.Strategy).filter(models.Strategy.id == strategy_id, models.Strategy.user_id == current_user.id).first()
    
    if not portfolio or not strategy: raise HTTPException(status_code=404)
    if strategy in portfolio.strategies:
        raise HTTPException(status_code=409, detail="A estratégia já está neste portfólio")
    portfolio.strategies.append(strategy)
    db.commit()
    return {"message": "Strategy added to Portfolio"}

@app.delete("/portfolios/{portfolio_id}/strategies/{strategy_id}")
def remove_strategy_from_portfolio(portfolio_id: int, strategy_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    portfolio = db.query(models.Portfolio).filter(models.Portfolio.id == portfolio_id, models.Portfolio.user_id == current_user.id).first()
    strategy = next((s for s in portfolio.strategies if s.id == strategy_id), None) if portfolio else None
    if not strategy: raise HTTPException(status_code=404)

    # The next SNAP of this portfolio would no longer list these positions, and every Slave would close its copies
    open_positions = db.query(models.MasterPosition).filter(
        models.MasterPosition.strategy_id == strategy.id, models.MasterPosition.closed_at.is_(None)
    ).count()
    if open_positions:
        raise HTTPException(status_code=409, detail=(
            f"{strategy.name} tem {open_positions} {'posição aberta' if open_positions == 1 else 'posições abertas'}. "
            "Remover agora fecharia as cópias dos clientes deste portfólio: espere o fechamento no master."
        ))
    portfolio.strategies.remove(strategy)
    db.commit()
    logger.info(f"Strategy {strategy.id} removed from portfolio {portfolio.id} by manager {current_user.id}")
    return {"message": "Strategy removed from Portfolio"}

@app.post("/licenses")
def create_license(license_data: LicenseCreate, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    port = db.query(models.Portfolio).filter(models.Portfolio.id == license_data.portfolio_id, models.Portfolio.user_id == current_user.id).first()
    if not port: raise HTTPException(status_code=404, detail="Portfolio not found")
    existing = db.query(models.License).filter(
        models.License.portfolio_id == port.id, models.License.client_mt5_login == license_data.client_mt5_login
    ).first()
    if existing:
        state = "ativa" if existing.is_active else "revogada: reative-a na lista"
        raise HTTPException(status_code=409, detail=f"A conta {license_data.client_mt5_login} já tem licença neste portfólio ({state})")

    new_license = models.License(
        portfolio_id=license_data.portfolio_id,
        client_mt5_login=license_data.client_mt5_login,
        max_lots=license_data.max_lots,
        expires_at=utc_naive(license_data.expires_at),
    )
    key = set_license_key(new_license)
    db.add(new_license)
    db.commit()
    db.refresh(new_license)
    notify_hub()
    return license_out(new_license, key)

def owned_license(license_id: int, user: models.User, db: Session) -> models.License:
    if user.role != "MANAGER": raise HTTPException(status_code=403)
    lic = db.get(models.License, license_id)
    owner = None
    if lic is not None:
        owner = lic.portfolio.user_id if lic.portfolio else (lic.strategy.user_id if lic.strategy else None)
    if owner != user.id: raise HTTPException(status_code=404)
    return lic

@app.post("/licenses/{license_id}/key")
def regenerate_license_key(license_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """New Slave key for this license; the previous one stops working at once (the hub drops its connection)."""
    lic = owned_license(license_id, current_user, db)
    if lic.portfolio_id is None:
        raise HTTPException(status_code=409, detail="Licenças por estratégia ainda não funcionam no hub")
    key = set_license_key(lic)
    hosted = db.query(models.HostedTerminal).filter(models.HostedTerminal.license_id == lic.id).first()
    if hosted is not None:  # The pod gets the new key and restarts the terminal with it
        hosted.license_key_enc = hosting.encrypt(hosting_cipher(), key)
        hosted.config_version += 1
        hosted.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(lic)
    logger.info(f"License {lic.id} got a new key ({lic.key_prefix}) from manager {current_user.id}")
    notify_hub()
    return license_out(lic, key)

@app.patch("/licenses/{license_id}")
def update_license(license_id: int, changes: LicenseUpdate, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Edit the lot limit, the expiry, or revoke/reactivate. A revoked or expired Slave stops opening positions
    but keeps managing the ones that were open when it stopped being valid."""
    lic = owned_license(license_id, current_user, db)
    if changes.max_lots is not None:
        lic.max_lots = changes.max_lots
    if changes.is_active is not None and changes.is_active != lic.is_active:
        lic.is_active = changes.is_active
        lic.revoked_at = None if changes.is_active else datetime.datetime.utcnow()
    if "expires_at" in changes.model_fields_set:
        lic.expires_at = utc_naive(changes.expires_at)
    db.commit()
    db.refresh(lic)
    logger.info(f"License {lic.id} updated by manager {current_user.id}: max_lots={lic.max_lots} "
                f"is_active={lic.is_active} expires_at={lic.expires_at}")
    notify_hub()
    return license_out(lic)

# --- Hosted terminals (hosting.py) ---

def hosting_cipher():
    f = hosting.cipher()
    if f is None:
        raise HTTPException(status_code=503, detail="Hospedagem não configurada no servidor (HOSTING_SECRET ausente ou inválido)")
    return f

def pod_from_request(request: Request, db: Session) -> models.HostedPod:
    check_not_limited("pod", request)
    header = request.headers.get("Authorization", "")
    key = header[7:].strip() if header.startswith("Bearer ") else ""
    pod = db.query(models.HostedPod).filter(models.HostedPod.key_hash == keys.key_hash(key),
                                            models.HostedPod.revoked_at.is_(None)).first() if key.startswith(keys.POD) else None
    if pod is None:
        failure_limiter.fail(f"pod:{client_ip(request)}")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown or revoked pod key")
    return pod

@app.get("/hosting")
def list_hosting(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The manager's hosted terminals with what their pod last reported, and the broker servers the pods support."""
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    now = datetime.datetime.utcnow()
    portfolio_ids = [p.id for p in current_user.portfolios]
    terminals = (db.query(models.HostedTerminal).join(models.License)
                 .filter(models.License.portfolio_id.in_(portfolio_ids))
                 .order_by(models.HostedTerminal.id).all()) if portfolio_ids else []
    connected = {s.get("license_id") for s in (fetch_hub_sessions() or []) if s.get("kind") == "slave"} if terminals else set()
    return {"available": hosting.cipher() is not None, "servers": hosting.known_servers(db, now),
            "terminals": [hosting.terminal_out(t, now, t.license_id in connected) for t in terminals]}

@app.put("/licenses/{license_id}/hosting")
def update_hosting(license_id: int, changes: hosting.HostingUpdate, current_user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Hosts this license's Slave in a pod, or changes how it runs: the pod restarts the terminal with the new
    configuration. The first call needs the server and the password, and gives the license a new key, so a Slave
    the client runs on their own machine is disconnected."""
    f = hosting_cipher()
    lic = owned_license(license_id, current_user, db)
    if lic.portfolio_id is None:
        raise HTTPException(status_code=409, detail="Licenças por estratégia ainda não funcionam no hub")
    return save_hosting(lic, changes, f, current_user, db)

def save_hosting(lic: models.License, changes: hosting.HostingUpdate, f, user: models.User, db: Session):
    now = datetime.datetime.utcnow()
    try:
        t, created = hosting.upsert(db, lic, changes, f, now, set_license_key)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    db.commit()
    db.refresh(t)
    logger.info(f"Hosting of license {lic.id} {'created' if created else 'updated'} by {user.role.lower()} {user.id}: "
                f"server={t.server} enabled={t.enabled} version={t.config_version}")
    notify_hub()  # A new key cuts the previous one off at once; new settings reach the Slave as CFG
    return hosting.terminal_out(t, now)

@app.delete("/licenses/{license_id}/hosting")
def remove_hosting(license_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Stops hosting: the pod closes the terminal and deletes its folder at its next sync. Nobody else has the
    license key the pod used: generate a new one to run the Slave elsewhere."""
    return delete_hosting(owned_license(license_id, current_user, db), current_user, db)

def delete_hosting(lic: models.License, user: models.User, db: Session):
    t = db.query(models.HostedTerminal).filter(models.HostedTerminal.license_id == lic.id).first()
    if t is None: raise HTTPException(status_code=404)
    db.delete(t)
    db.commit()
    logger.info(f"Hosting of license {lic.id} removed by {user.role.lower()} {user.id}")
    return {"message": "Hospedagem removida"}

# --- Client accounts (clients.py) ---

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# Sign-ups per client IP per hour: an open form is the cheapest way to fill the users table
signup_limiter = FailureLimiter(int(os.getenv("SIGNUP_MAX_PER_HOUR", "5")), 3600)


class RegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=200)
    name: Optional[str] = Field(default=None, max_length=100, pattern=hosting.ONE_LINE)  # Filled in later


class ClaimRequest(BaseModel):
    code: str = Field(min_length=4, max_length=40)


class ClientHosting(BaseModel):
    """What a client sets on its own hosted terminal; the Slave settings go through /settings."""
    server: Optional[str] = hosting.HostingUpdate.model_fields["server"]
    password: Optional[str] = hosting.HostingUpdate.model_fields["password"]
    enabled: Optional[bool] = None


@app.post("/register")
def register(data: RegisterRequest, request: Request, db: Session = Depends(get_db)):
    """Open sign-up for clients, logged in at once. Licenses are linked afterwards with an access code."""
    ip = client_ip(request)
    if signup_limiter.blocked(f"signup:{ip}"):
        raise HTTPException(status_code=429, detail="Muitos cadastros a partir desta rede. Tente de novo mais tarde.")
    email = data.email.strip().lower()
    if not EMAIL_PATTERN.match(email):
        raise HTTPException(status_code=422, detail="Email inválido")
    if auth.validate_password(data.password):
        raise HTTPException(status_code=422, detail=f"A senha precisa ter de {auth.PASSWORD_MIN_LENGTH} a "
                                                    f"{auth.PASSWORD_MAX_BYTES} caracteres")
    signup_limiter.fail(f"signup:{ip}")
    if db.query(models.User).filter(func.lower(models.User.email) == email).first():
        raise HTTPException(status_code=409, detail="Este email já tem conta: entre com ele")
    user = models.User(email=email, name=(data.name or "").strip() or None, password_hash=auth.get_password_hash(data.password),
                       role="CLIENT", status="active")
    db.add(user)
    db.commit()
    logger.info(f"Client {user.id} signed up")
    if mailer.enabled():
        token = mailer.issue_token(db, user, "verify", datetime.datetime.utcnow())
        db.commit()
        mailer.send_verification(user, token)
    return {"access_token": auth.create_access_token(data={"sub": user.email, "role": user.role}),
            "token_type": "bearer"}

def client_only(user: models.User):
    if user.role != "CLIENT": raise HTTPException(status_code=403)

def own_license(license_id: int, user: models.User, db: Session) -> models.License:
    client_only(user)
    lic = db.get(models.License, license_id)
    if lic is None or lic.client_user_id != user.id: raise HTTPException(status_code=404)
    return lic

def my_license_view(lic: models.License, db: Session) -> dict:
    terminal = db.query(models.HostedTerminal).filter(models.HostedTerminal.license_id == lic.id).first()
    session = next((s for s in (fetch_hub_sessions() or [])
                    if s.get("kind") == "slave" and s.get("license_id") == lic.id), None)
    return clients.license_view(lic, terminal, session, datetime.datetime.utcnow()) | {
        "billing": billing_view(stripe_subscriptions([lic.id], db).get(lic.id))}

def stripe_subscriptions(license_ids, db: Session) -> Dict[int, models.Subscription]:
    """The Stripe subscription behind each license, the latest when it had several."""
    if not license_ids: return {}
    rows = (db.query(models.Subscription)
            .filter(models.Subscription.license_id.in_(license_ids), models.Subscription.stripe_subscription_id.isnot(None))
            .order_by(models.Subscription.id).all())
    return {s.license_id: s for s in rows}

def billing_view(sub: Optional[models.Subscription]) -> Optional[dict]:
    """How the license is paid in Stripe, and the plans it can change to."""
    if sub is None: return None
    return {"subscription_id": sub.id, "status": sub.stripe_status, "renewing": sub.stripe_status in payments.RENEWING,
            "cancel_at_period_end": bool(sub.stripe_cancel_at_period_end), "period_end": sub.stripe_period_end,
            "plan": marketplace.plan_out(sub.plan, public=True),
            "plans": [marketplace.plan_out(p, public=True) for p in marketplace.active_plans(sub.listing)]}

class PauseIn(BaseModel):
    paused: bool

@app.get("/me/dashboard")
def get_client_dashboard(days: int = 30, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Overview for the client/subscriber: today, week and month profit, running strategies, cumulative curve, traders."""
    client_only(current_user)
    return clients.client_dashboard(db, current_user, datetime.datetime.utcnow(), days=days)

@app.put("/me/licenses/{license_id}/pause")
def pause_my_license(license_id: int, data: PauseIn, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Soft pause toggle: when paused, stops opening new positions but keeps managing and closing open ones."""
    lic = own_license(license_id, current_user, db)
    now = datetime.datetime.utcnow()
    clients.set_pause(lic, data.paused, now)
    db.commit()
    logger.info(f"License {lic.id}: pause set to {data.paused} by client {current_user.id}")
    notify_hub()
    db.refresh(lic)
    return my_license_view(lic, db)

@app.post("/me/licenses/pause-all")
def pause_all_my_licenses(data: PauseIn, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Master pause toggle: pause or resume all active licenses belonging to this client."""
    client_only(current_user)
    now = datetime.datetime.utcnow()
    lics = db.query(models.License).filter(models.License.client_user_id == current_user.id).all()
    count = 0
    for lic in lics:
        if clients.license_valid(lic, now):
            clients.set_pause(lic, data.paused, now)
            count += 1
    db.commit()
    logger.info(f"Client {current_user.id} set pause={data.paused} for {count} licenses")
    notify_hub()
    return {"paused": data.paused, "count": count}

@app.get("/me/licenses")
def list_my_licenses(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The client's licenses, with how each one is copying right now."""
    client_only(current_user)
    now = datetime.datetime.utcnow()
    lics = db.query(models.License).filter(models.License.client_user_id == current_user.id).order_by(models.License.id).all()
    ids = [l.id for l in lics]
    terminals = {t.license_id: t for t in db.query(models.HostedTerminal).filter(models.HostedTerminal.license_id.in_(ids))} if ids else {}
    sessions = {s.get("license_id"): s for s in (fetch_hub_sessions() or []) if s.get("kind") == "slave"} if ids else {}
    available = hosting.cipher() is not None
    billing = stripe_subscriptions(ids, db)
    return {"hosting_available": available, "servers": hosting.known_servers(db, now) if available else [],
            "licenses": [clients.license_view(l, terminals.get(l.id), sessions.get(l.id), now) | {"billing": billing_view(billing.get(l.id))}
                         for l in lics]}

@app.post("/me/licenses/claim")
def claim_license(data: ClaimRequest, request: Request, current_user: models.User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    """Links the license behind a manager's access code to this client. The code works once."""
    client_only(current_user)
    check_not_limited("claim", request)
    lic = clients.find_claim(db, data.code, datetime.datetime.utcnow())
    if lic is None:
        failure_limiter.fail(f"claim:{client_ip(request)}")
        raise HTTPException(status_code=404, detail="Código inválido ou vencido. Peça um novo a quem vendeu a licença.")
    lic.client_user_id, lic.claim_hash, lic.claim_expires_at = current_user.id, None, None
    db.commit()
    db.refresh(lic)
    logger.info(f"License {lic.id} claimed by client {current_user.id}")
    return my_license_view(lic, db)

@app.get("/me/licenses/{license_id}/copies")
def list_my_copies(license_id: int, days: int = 30, current_user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    lic = own_license(license_id, current_user, db)
    return clients.copies(db, lic, days, datetime.datetime.utcnow())

@app.get("/me/licenses/{license_id}/issues")
def list_my_issues(license_id: int, days: int = 7, current_user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Copies this license's Slave could not make, or made smaller (same as the manager's /me/copy-issues)."""
    lic = own_license(license_id, current_user, db)
    since = datetime.datetime.utcnow() - datetime.timedelta(days=max(1, min(days, 90)))
    rows = (db.query(models.Execution)
            .filter(models.Execution.portfolio_id == lic.portfolio_id, models.Execution.mt5_login == lic.client_mt5_login,
                    models.Execution.created_at >= since, models.Execution.retcode.notin_(models.EXECUTION_DONE))
            .order_by(models.Execution.created_at.desc(), models.Execution.id.desc()).limit(200).all())
    return [{"at": r.created_at, "uid": r.uid, "action": r.action, "volume": r.volume, "retcode": r.retcode} for r in rows]

@app.put("/me/licenses/{license_id}/settings")
def update_my_settings(license_id: int, data: clients.ClientSettings, current_user: models.User = Depends(get_current_user),
                       db: Session = Depends(get_db)):
    """The client's Slave settings, inside the limits of the portfolio. The hub sends them to the Slave (CFG)."""
    lic = own_license(license_id, current_user, db)
    error = clients.check_settings(data, clients.limits_of(lic.portfolio))
    if error:
        raise HTTPException(status_code=422, detail=error)
    if clients.apply_settings(lic, data.model_dump()):
        db.commit()
        logger.info(f"License {lic.id}: settings changed by client {current_user.id}")
        notify_hub()
    db.refresh(lic)
    return my_license_view(lic, db)

@app.put("/me/licenses/{license_id}/hosting")
def update_my_hosting(license_id: int, changes: ClientHosting, current_user: models.User = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    """The client hosts its own license: the manager never sees the broker password."""
    f = hosting_cipher()
    lic = own_license(license_id, current_user, db)
    account_required(lic)
    return save_hosting(lic, hosting.HostingUpdate(**changes.model_dump()), f, current_user, db)

@app.delete("/me/licenses/{license_id}/hosting")
def remove_my_hosting(license_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    return delete_hosting(own_license(license_id, current_user, db), current_user, db)

class AccountIn(BaseModel):
    mt5_login: int = Field(gt=0, le=10**12)

@app.put("/me/licenses/{license_id}/account")
def connect_account(license_id: int, data: AccountIn, current_user: models.User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    """The MT5 account of a license bought without one. Once set, only the manager changes it."""
    lic = own_license(license_id, current_user, db)
    if lic.client_mt5_login is not None:
        raise HTTPException(status_code=409, detail="Esta licença já tem conta. Para trocar, fale com o gestor")
    if mailer.enabled() and current_user.email_verified_at is None:
        raise HTTPException(status_code=403, detail="Confirme seu email antes de conectar a conta: o link está na sua caixa de entrada")
    if db.query(models.License).filter(models.License.portfolio_id == lic.portfolio_id,
                                       models.License.client_mt5_login == data.mt5_login).first():
        raise HTTPException(status_code=409, detail="Esta conta MT5 já tem licença deste portfólio")
    lic.client_mt5_login = data.mt5_login
    db.commit()
    logger.info(f"License {lic.id}: client {current_user.id} connected MT5 account {data.mt5_login}")
    notify_hub()
    return my_license_view(lic, db)

def account_required(lic: models.License):
    if lic.client_mt5_login is None:
        raise HTTPException(status_code=409, detail="Conecte a conta MT5 da licença primeiro")

@app.post("/me/licenses/{license_id}/key")
def new_my_key(license_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """A key for the Slave on the client's own computer, shown once; the previous one stops working."""
    lic = own_license(license_id, current_user, db)
    account_required(lic)
    if db.query(models.HostedTerminal).filter(models.HostedTerminal.license_id == lic.id).first():
        raise HTTPException(status_code=409, detail="Esta licença roda no nosso servidor e a chave fica com ele. "
                                                    "Remova a hospedagem para usar o EA no seu computador.")
    key = set_license_key(lic)
    db.commit()
    logger.info(f"License {lic.id} got a new key ({lic.key_prefix}) from client {current_user.id}")
    notify_hub()
    return {"license_key": key, "key_prefix": lic.key_prefix}

@app.post("/licenses/{license_id}/claim-code")
def create_claim_code(license_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """A one-time code the client types after signing up to get this license; it replaces any earlier code.
    Claiming a license linked to someone else moves it to the new account."""
    lic = owned_license(license_id, current_user, db)
    if lic.portfolio_id is None:
        raise HTTPException(status_code=409, detail="Licenças por estratégia ainda não funcionam no hub")
    code, expires_at = clients.set_claim(lic, datetime.datetime.utcnow())
    db.commit()
    logger.info(f"License {lic.id}: access code created by manager {current_user.id}")
    return {"code": code, "expires_at": expires_at}

@app.delete("/licenses/{license_id}/client")
def unlink_client(license_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The license leaves the client's account (copying goes on: the Slave does not depend on it)."""
    lic = owned_license(license_id, current_user, db)
    lic.client_user_id, lic.claim_hash, lic.claim_expires_at = None, None, None
    db.commit()
    db.refresh(lic)
    logger.info(f"License {lic.id}: client unlinked by manager {current_user.id}")
    return license_out(lic)

@app.put("/licenses/{license_id}/settings")
def update_license_settings(license_id: int, data: hosting.SlaveInputs, current_user: models.User = Depends(get_current_user),
                            db: Session = Depends(get_db)):
    """The manager sets any Slave setting of the license, outside the portfolio's client limits too."""
    lic = owned_license(license_id, current_user, db)
    new = json.dumps(data.model_dump(exclude_none=True), sort_keys=True)
    if new != (lic.settings or "{}"):
        lic.settings = new
        db.commit()
        logger.info(f"License {lic.id}: settings changed by manager {current_user.id}")
        notify_hub()
    db.refresh(lic)
    return license_out(lic)

@app.get("/portfolios/{portfolio_id}/performance")
def portfolio_performance(portfolio_id: int, days: int = 90, current_user: models.User = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    """What the portfolio's strategies realized in the period, from the Master's deals (Master 4.01+)."""
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    portfolio = db.query(models.Portfolio).filter(models.Portfolio.id == portfolio_id,
                                                  models.Portfolio.user_id == current_user.id).first()
    if not portfolio: raise HTTPException(status_code=404)
    return performance.portfolio(db, portfolio, days, datetime.datetime.utcnow())

class DashLinkIn(BaseModel):
    token: str = Field(min_length=1, max_length=200)
    history_days: int = Field(0, ge=0, le=dash_bridge.HISTORY_MAX_DAYS)

def own_portfolio(portfolio_id: int, current_user: models.User, db: Session) -> models.Portfolio:
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    portfolio = db.query(models.Portfolio).filter(models.Portfolio.id == portfolio_id,
                                                  models.Portfolio.user_id == current_user.id).first()
    if not portfolio: raise HTTPException(status_code=404)
    return portfolio

@app.get("/portfolios/{portfolio_id}/dash")
def get_dash_link(portfolio_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The portfolio's link to a Trademetric Dash portfolio, if any (dash_bridge.py)."""
    portfolio = own_portfolio(portfolio_id, current_user, db)
    link = db.query(models.DashLink).filter(models.DashLink.portfolio_id == portfolio.id).first()
    return {"available": hosting.cipher() is not None, "link": dash_bridge.link_out(link)}

@app.put("/portfolios/{portfolio_id}/dash")
def save_dash_link(portfolio_id: int, data: DashLinkIn, current_user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Links the portfolio to a Dash portfolio by its API token: from now on (or from history_days before), each
    trade the Master closes in one of its strategies goes to the Dash. The Dash checks the token first."""
    portfolio = own_portfolio(portfolio_id, current_user, db)
    token = data.token.strip()
    if not dash_bridge.TOKEN_PATTERN.match(token):
        raise HTTPException(status_code=422, detail="Cole o token de API do portfólio do Dash: ele começa com tc_")
    fernet = hosting.cipher()
    if fernet is None:
        raise HTTPException(status_code=503, detail="O vínculo com o Dash não está disponível neste servidor")
    status_code, _ = dash_bridge.send(token, [])  # Nothing to ingest: the Dash only checks the token and the plan
    if status_code not in (200, 201):
        refused = dash_bridge.refusal(status_code)
        if refused:
            raise HTTPException(status_code=422, detail=refused)
        raise HTTPException(status_code=502, detail="Não foi possível falar com o Dash agora. Tente de novo em alguns minutos.")
    now = datetime.datetime.utcnow()
    link = db.query(models.DashLink).filter(models.DashLink.portfolio_id == portfolio.id).first()
    if link is None:
        link = models.DashLink(portfolio_id=portfolio.id, created_at=now, sent_count=0)
        db.add(link)
    link.token_encrypted = fernet.encrypt(token.encode()).decode()
    link.token_hint = token[-4:]
    link.deal_cursor = 0  # The Dash drops what it already has (external_id): going through again is safe
    link.send_since = now - datetime.timedelta(days=data.history_days)
    link.status, link.last_error = "active", None
    link.backtest_fetched_at = None  # The next round reads this portfolio's backtest
    db.commit()
    db.refresh(link)
    logger.info(f"Portfolio {portfolio.id}: linked to the Dash (history {data.history_days} days)")
    return dash_bridge.link_out(link)

@app.get("/portfolios/{portfolio_id}/backtest")
def portfolio_backtest(portfolio_id: int, days: int = 90, current_user: models.User = Depends(get_current_user),
                       db: Session = Depends(get_db)):
    """The linked Dash portfolio's backtest and the cone, for the manager, whether or not the listing shows it."""
    portfolio = own_portfolio(portfolio_id, current_user, db)
    link = db.query(models.DashLink).filter(models.DashLink.portfolio_id == portfolio.id).first()
    return backtest.view(db, portfolio, link, days, datetime.datetime.utcnow(), seed=portfolio.id)

@app.delete("/portfolios/{portfolio_id}/dash")
def delete_dash_link(portfolio_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    portfolio = own_portfolio(portfolio_id, current_user, db)
    db.query(models.DashLink).filter(models.DashLink.portfolio_id == portfolio.id).delete()
    db.commit()
    logger.info(f"Portfolio {portfolio.id}: Dash link removed")
    return {"message": "Vínculo removido"}

@app.get("/portfolios/{portfolio_id}/followers")
def portfolio_followers(portfolio_id: int, days: int = 90, current_user: models.User = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    """How the portfolio's followers copied it. The manager sees it with any number of followers: he already sees
    each client's copies."""
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    portfolio = db.query(models.Portfolio).filter(models.Portfolio.id == portfolio_id,
                                                  models.Portfolio.user_id == current_user.id).first()
    if not portfolio: raise HTTPException(status_code=404)
    return followers.portfolio(db, portfolio, days, datetime.datetime.utcnow())

@app.get("/me/licenses/{license_id}/performance")
def my_performance(license_id: int, days: int = 90, current_user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """The client's own result on this license next to what the portfolio realized in the same period."""
    lic = own_license(license_id, current_user, db)
    now = datetime.datetime.utcnow()
    return {"copies": performance.copies(db, lic, days, now),
            "portfolio": performance.portfolio(db, lic.portfolio, days, now) if lic.portfolio else None}

class PortfolioOriginIn(BaseModel):
    master_login: Optional[int] = Field(default=None, ge=1)

@app.get("/me/master-accounts")
def list_master_accounts(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The accounts the manager's Masters ever ran on (V2HELLO), with their currency and latest balance (V2ACC)."""
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    out = []
    for a in (db.query(models.MasterAccount).filter(models.MasterAccount.manager_id == current_user.id)
              .order_by(models.MasterAccount.last_seen_at.desc())):
        snap = (db.query(models.AccountSnapshot)
                .filter(models.AccountSnapshot.kind == "master", models.AccountSnapshot.owner_id == current_user.id,
                        models.AccountSnapshot.login == a.master_login)
                .order_by(models.AccountSnapshot.hour.desc()).first())
        out.append({"master_login": a.master_login, "trade_mode": a.trade_mode, "server": a.server,
                    "company": a.company, "last_seen_at": a.last_seen_at,
                    "currency": snap.currency if snap else None, "balance": snap.balance if snap else None})
    return out

@app.put("/portfolios/{portfolio_id}/origin")
def update_portfolio_origin(portfolio_id: int, data: PortfolioOriginIn, current_user: models.User = Depends(get_current_user),
                            db: Session = Depends(get_db)):
    """The Master account the portfolio copies from (None: every account). The hub sends its clients only that
    account's positions; what they already got stays in the track record (portfolio_trades). An open position from
    an account left out would vanish from the clients' snapshot and close their copies, so it has to close first."""
    portfolio = own_portfolio(portfolio_id, current_user, db)
    if data.master_login is not None and db.query(models.MasterAccount).filter(
            models.MasterAccount.manager_id == current_user.id,
            models.MasterAccount.master_login == data.master_login).first() is None:
        raise HTTPException(status_code=422, detail="Nenhum Master seu se conectou com essa conta")
    if data.master_login is not None and data.master_login != portfolio.master_login:
        open_elsewhere = (db.query(models.MasterPosition.master_login)
                          .filter(models.MasterPosition.manager_id == current_user.id,
                                  models.MasterPosition.closed_at.is_(None),
                                  models.MasterPosition.master_login != data.master_login,
                                  models.MasterPosition.strategy_id.in_([s.id for s in portfolio.strategies] or [0]))
                          .first())
        if open_elsewhere is not None:
            raise HTTPException(status_code=409, detail=(
                f"A conta {open_elsewhere[0]} tem posições abertas deste portfólio. Trocar agora fecharia as cópias "
                "dos clientes: espere elas fecharem."))
    portfolio.master_login = data.master_login
    db.commit()
    notify_hub()
    marketplace.clear_cache()
    logger.info(f"Portfolio {portfolio.id}: copies from account {data.master_login}")
    return {"master_login": portfolio.master_login}

@app.put("/portfolios/{portfolio_id}/limits")
def update_client_limits(portfolio_id: int, data: clients.ClientLimits, current_user: models.User = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    """What clients may set on this portfolio's licenses. Settings already saved keep working until changed."""
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    portfolio = db.query(models.Portfolio).filter(models.Portfolio.id == portfolio_id,
                                                  models.Portfolio.user_id == current_user.id).first()
    if not portfolio: raise HTTPException(status_code=404)
    portfolio.client_limits = data.model_dump_json()
    db.commit()
    return clients.limits_of(portfolio).model_dump()

# --- Email: confirming the address and resetting the password (mailer.py) ---

class TokenIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)


class ForgotIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)


class ResetIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    password: str = Field(min_length=1, max_length=200)


@app.post("/email/verify")
def verify_email(data: TokenIn, request: Request, db: Session = Depends(get_db)):
    check_not_limited("token", request)
    now = datetime.datetime.utcnow()
    user = mailer.consume_token(db, "verify", data.token, now)
    if user is None:
        failure_limiter.fail(f"token:{client_ip(request)}")
        raise HTTPException(status_code=400, detail="Link inválido ou vencido. Peça um novo no painel.")
    user.email_verified_at = user.email_verified_at or now
    db.commit()
    return {"message": "Email confirmado"}

@app.post("/email/resend")
def resend_verification(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """A new confirmation link, at most a few per window (it goes to the account's own address)."""
    if current_user.email_verified_at is not None:
        return {"message": "Email já confirmado"}
    if not mailer.enabled():
        raise HTTPException(status_code=503, detail="O envio de emails não está configurado")
    if failure_limiter.blocked(f"resend:{current_user.id}"):
        raise HTTPException(status_code=429, detail="Aguarde alguns minutos para pedir outro link")
    failure_limiter.fail(f"resend:{current_user.id}")
    token = mailer.issue_token(db, current_user, "verify", datetime.datetime.utcnow())
    db.commit()
    # Sent now, not queued: the user is waiting on it, so a failure shows on screen instead of only in the log
    if mailer.send_verification(current_user, token, wait=True):
        raise HTTPException(status_code=502, detail="Não foi possível enviar o link agora. Tente de novo em alguns minutos.")
    return {"message": "Link enviado"}

@app.post("/password/forgot")
def forgot_password(data: ForgotIn, request: Request, db: Session = Depends(get_db)):
    """Sends a reset link if the account exists. The answer is the same either way, so it tells nobody which
    emails have accounts."""
    check_not_limited("forgot", request)
    failure_limiter.fail(f"forgot:{client_ip(request)}")  # Every request counts: each one may send an email
    if not mailer.enabled():
        raise HTTPException(status_code=503, detail="A recuperação de senha por email não está disponível. Fale com o suporte.")
    user = db.query(models.User).filter(func.lower(models.User.email) == data.email.strip().lower()).first()
    if user is not None and not is_blocked(user):
        token = mailer.issue_token(db, user, "reset", datetime.datetime.utcnow())
        db.commit()
        mailer.send_reset(user, token)
    return {"message": "Se houver uma conta com este email, o link chega em instantes"}

@app.post("/password/reset")
def reset_password(data: ResetIn, request: Request, db: Session = Depends(get_db)):
    """A new password from a reset link. It ends every open session of the account."""
    check_not_limited("token", request)
    if auth.validate_password(data.password):
        raise HTTPException(status_code=422, detail=f"A senha precisa ter de {auth.PASSWORD_MIN_LENGTH} a "
                                                    f"{auth.PASSWORD_MAX_BYTES} caracteres")
    now = datetime.datetime.utcnow()
    user = mailer.consume_token(db, "reset", data.token, now)
    if user is None:
        failure_limiter.fail(f"token:{client_ip(request)}")
        raise HTTPException(status_code=400, detail="Link inválido ou vencido. Peça um novo.")
    user.password_hash = auth.get_password_hash(data.password)
    user.password_changed_at = now
    user.email_verified_at = user.email_verified_at or now  # The link reached the address
    db.commit()
    logger.info(f"Password of user {user.id} reset by email link")
    return {"message": "Senha redefinida"}

# --- Marketplace (marketplace.py) ---

@app.get("/me")
def my_account(current_user: models.User = Depends(get_current_user)):
    return {"email": current_user.email, "name": current_user.name, "role": current_user.role, "bio": current_user.bio,
            "youtube_url": current_user.youtube_url, "instagram_url": current_user.instagram_url,
            "email_verified": current_user.email_verified_at is not None, "email_enabled": mailer.enabled()}

@app.put("/me/profile")
def update_profile(data: marketplace.Profile, current_user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """The name others see (a manager's also in the marketplace, with the bio)."""
    current_user.name = data.name.strip()
    if current_user.role == "MANAGER":
        current_user.bio = (data.bio or "").strip() or None
        current_user.youtube_url = data.youtube_url
        current_user.instagram_url = data.instagram_url
    db.commit()
    marketplace.clear_cache()
    return my_account(current_user)

def published_listing(slug: str, db: Session) -> models.Listing:
    listing = db.query(models.Listing).filter(models.Listing.slug == slug, models.Listing.status == "published").first()
    if listing is None: raise HTTPException(status_code=404, detail="Portfólio não encontrado")
    return listing

@app.get("/api/marketplace")  # /marketplace itself is the dashboard's page
def list_marketplace(db: Session = Depends(get_db)):
    """Published listings with the headline numbers of the last 90 days. Public."""
    now = datetime.datetime.utcnow()
    listings = db.query(models.Listing).filter(models.Listing.status == "published").order_by(models.Listing.published_at).all()
    return [marketplace.public_listing(db, l, now) for l in listings]

@app.get("/api/marketplace/{slug}")
def get_marketplace_listing(slug: str, db: Session = Depends(get_db)):
    return marketplace.public_listing(db, published_listing(slug, db), datetime.datetime.utcnow())

def public_days(days: int) -> int:
    return min((d for d in (30, 90, 180, 365, 3650) if d >= days), default=3650)  # A few periods, so the cache holds

@app.get("/api/marketplace/{slug}/performance")
def get_marketplace_performance(slug: str, days: int = marketplace.PUBLIC_DAYS, db: Session = Depends(get_db)):
    return marketplace.public_performance(db, published_listing(slug, db), public_days(days), datetime.datetime.utcnow())

@app.get("/api/marketplace/{slug}/backtest")
def get_marketplace_backtest(slug: str, days: int = marketplace.PUBLIC_DAYS, db: Session = Depends(get_db)):
    """The backtest the manager declared on the Trademetric Dash and the live result in its Monte Carlo cone, when
    the manager chose to show it (backtest.py)."""
    return marketplace.public_backtest(db, published_listing(slug, db), public_days(days), datetime.datetime.utcnow())

@app.get("/api/marketplace/{slug}/followers")
def get_marketplace_followers(slug: str, days: int = marketplace.PUBLIC_DAYS, db: Session = Depends(get_db)):
    """How the followers copied the portfolio (followers.py), once there are enough of them to show."""
    return marketplace.public_followers(db, published_listing(slug, db), public_days(days), datetime.datetime.utcnow())

# Requests per client per day: each one emails the manager, and cancelling frees the pending slot again
subscribe_limiter = FailureLimiter(int(os.getenv("SUBSCRIBE_MAX_PER_DAY", "20")), 86400)

@app.post("/api/marketplace/{slug}/subscribe")
def subscribe(slug: str, data: marketplace.SubscriptionIn, current_user: models.User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    """A client asks for a listing. The manager approves it once paid, or Stripe's payment does when the listing is
    paid online: the client then opens /me/subscriptions/{id}/checkout. The MT5 account is optional: without it, the
    client connects it on the license afterwards, so buying never waits on looking the number up. Nor on the email
    link: that is asked when connecting the account, before anything copies."""
    client_only(current_user)
    listing = published_listing(slug, db)
    plan = None
    if marketplace.pay_online(listing):
        plan = next((p for p in marketplace.active_plans(listing) if p.id == data.plan_id), None)
        if plan is None: raise HTTPException(status_code=422, detail="Escolha um dos planos do portfólio")
    pending = db.query(models.Subscription).filter(models.Subscription.client_user_id == current_user.id,
                                                   models.Subscription.status == "pending")
    same = pending.filter(models.Subscription.listing_id == listing.id,
                          models.Subscription.mt5_login == data.mt5_login).first()
    if same is not None and plan is not None:
        same.plan = plan  # Back from an abandoned Checkout: pay that one, maybe on another plan
        db.commit()
        return marketplace.subscription_out(same, for_manager=False)
    if same is not None:
        raise HTTPException(status_code=409, detail="Já existe um pedido desta conta esperando resposta")
    if pending.count() >= marketplace.MAX_PENDING_PER_CLIENT:
        raise HTTPException(status_code=429, detail="Você tem pedidos demais esperando resposta")
    existing = None if data.mt5_login is None else db.query(models.License).filter(
        models.License.portfolio_id == listing.portfolio_id, models.License.client_mt5_login == data.mt5_login).first()
    if existing is not None and existing.client_user_id not in (None, current_user.id):
        raise HTTPException(status_code=409, detail="Esta conta MT5 já tem licença deste portfólio em outro cadastro")
    if subscribe_limiter.blocked(f"subscribe:{current_user.id}"):
        raise HTTPException(status_code=429, detail="Pedidos demais hoje. Tente de novo amanhã ou fale com o gestor")
    subscribe_limiter.fail(f"subscribe:{current_user.id}")
    sub = models.Subscription(listing_id=listing.id, client_user_id=current_user.id, mt5_login=data.mt5_login,
                              kind="renewal" if existing is not None else "new", plan=plan,
                              note=(data.note or "").strip() or None, created_at=datetime.datetime.utcnow())
    db.add(sub)
    db.commit()
    db.refresh(sub)
    logger.info(f"Subscription {sub.id}: client {current_user.id} asked for listing {listing.id}")
    if listing.portfolio and listing.portfolio.owner and not marketplace.pay_online(listing):
        mailer.send_new_subscription(listing.portfolio.owner, sub)
    return marketplace.subscription_out(sub, for_manager=False)

class RenewIn(BaseModel):
    plan_id: Optional[int] = None  # Default: the plan the license had, if it is still sold

@app.post("/me/licenses/{license_id}/renew")
def renew_my_license(license_id: int, data: Optional[RenewIn] = None, current_user: models.User = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    """A renewal request for the portfolio's listing: approving it, or paying it in Stripe, extends the license."""
    lic = own_license(license_id, current_user, db)
    listing = db.query(models.Listing).filter(models.Listing.portfolio_id == lic.portfolio_id,
                                              models.Listing.status == "published").first()
    if listing is None:
        raise HTTPException(status_code=409, detail="Este portfólio não está no marketplace: renove com quem vendeu a licença")
    account_required(lic)
    paid = stripe_subscriptions([lic.id], db).get(lic.id)
    if paid is not None and paid.stripe_status in payments.RENEWING:
        raise HTTPException(status_code=409, detail="Esta licença já renova sozinha pelo cartão")
    plan_id = data.plan_id if data and data.plan_id else (paid.plan_id if paid else None)
    return subscribe(listing.slug, marketplace.SubscriptionIn(mt5_login=lic.client_mt5_login, plan_id=plan_id), current_user, db)

@app.post("/me/subscriptions/{subscription_id}/checkout")
def open_checkout(subscription_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Stripe's payment page for a pending request of a listing paid online. A new one each call: the previous
    Checkout is closed, so one request is never paid twice."""
    client_only(current_user)
    sub = db.get(models.Subscription, subscription_id)
    if sub is None or sub.client_user_id != current_user.id: raise HTTPException(status_code=404)
    if sub.status != "pending": raise HTTPException(status_code=409, detail="Este pedido já foi respondido")
    if sub.listing.status != "published" or not marketplace.pay_online(sub.listing):
        raise HTTPException(status_code=409, detail="Este portfólio não aceita pagamento online. Fale com o gestor")
    if sub.plan is None or sub.plan.archived or sub.plan.listing_id != sub.listing_id:
        raise HTTPException(status_code=409, detail="Este plano não é mais vendido. Assine de novo pela página do portfólio")
    try:
        url = payments.checkout(db, sub, datetime.datetime.utcnow())
    except payments.PaymentError as e:
        raise HTTPException(status_code=e.status, detail=str(e))
    db.commit()
    return {"url": url}

@app.post("/me/billing/portal")
def open_billing_portal(current_user: models.User = Depends(get_current_user)):
    """Stripe's page where the client changes the card and sees the invoices."""
    client_only(current_user)
    if not payments.enabled(): raise HTTPException(status_code=409, detail="Pagamento online indisponível")
    try:
        return {"url": payments.portal(current_user)}
    except payments.PaymentError as e:
        raise HTTPException(status_code=e.status, detail=str(e))

def paid_subscription(subscription_id: int, user: models.User, db: Session) -> models.Subscription:
    """The client's own subscription paid in Stripe and still alive there."""
    client_only(user)
    sub = db.get(models.Subscription, subscription_id)
    if sub is None or sub.client_user_id != user.id: raise HTTPException(status_code=404)
    if not payments.enabled() or sub.stripe_subscription_id is None or sub.stripe_status not in payments.RENEWING:
        raise HTTPException(status_code=409, detail="Esta assinatura não está ativa na Stripe")
    return sub

class PlanChange(BaseModel):
    plan_id: int

@app.post("/me/subscriptions/{subscription_id}/plan")
def change_my_plan(subscription_id: int, data: PlanChange, current_user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Another plan of the same listing. The prorated difference is charged (or credited) now, and the license's
    lot limit follows once Stripe takes it."""
    sub = paid_subscription(subscription_id, current_user, db)
    plan = next((p for p in marketplace.active_plans(sub.listing) if p.id == data.plan_id), None)
    if plan is None: raise HTTPException(status_code=422, detail="Escolha um dos planos do portfólio")
    if plan.id == sub.plan_id: raise HTTPException(status_code=409, detail="Este já é o seu plano")
    if sub.stripe_status == "past_due":
        raise HTTPException(status_code=409, detail="A última cobrança falhou: atualize o cartão em Pagamentos antes de trocar de plano")
    try:
        payments.change_plan(db, sub, plan, datetime.datetime.utcnow())
    except payments.PaymentError as e:
        db.commit()  # What Stripe did say is kept
        raise HTTPException(status_code=e.status, detail=str(e))
    db.commit()
    logger.info(f"Subscription {sub.id}: client {current_user.id} moved to plan {sub.plan_id}")
    notify_hub()
    return marketplace.subscription_out(sub, for_manager=False)

class RenewalChange(BaseModel):
    renew: bool  # False: ends with the paid period; True: undoes that

@app.post("/me/subscriptions/{subscription_id}/renewal")
def set_my_renewal(subscription_id: int, data: RenewalChange, current_user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Cancels the renewal (the license stays valid until the paid period ends) or resumes it."""
    sub = paid_subscription(subscription_id, current_user, db)
    try:
        payments.set_renewal(db, sub, data.renew, datetime.datetime.utcnow())
    except payments.PaymentError as e:
        raise HTTPException(status_code=e.status, detail=str(e))
    db.commit()
    logger.info(f"Subscription {sub.id}: client {current_user.id} set renewal to {data.renew}")
    return marketplace.subscription_out(sub, for_manager=False)

async def raw_body(request: Request) -> bytes:
    return await request.body()  # The signature covers the exact bytes Stripe sent

@app.post("/api/stripe/webhook")
def stripe_webhook(request: Request, payload: bytes = Depends(raw_body), db: Session = Depends(get_db)):
    """Stripe's events (payments.handle). An error answers 5xx, and Stripe sends the event again later."""
    if not payments.enabled() or not os.getenv("STRIPE_WEBHOOK_SECRET"):
        raise HTTPException(status_code=503, detail="Stripe not configured")
    try:
        sub, approved = payments.handle(db, payload, request.headers.get("stripe-signature", ""), datetime.datetime.utcnow())
    except payments.stripe.SignatureVerificationError:
        raise HTTPException(status_code=400, detail="Bad signature")
    db.commit()
    if sub is not None and sub.license_id is not None:
        notify_hub()
    if approved:
        mailer.send_decision(sub)
        if sub.listing.portfolio and sub.listing.portfolio.owner:
            mailer.send_sale(sub.listing.portfolio.owner, sub)
    return {"ok": True}

@app.get("/me/subscriptions")
def list_my_subscriptions(status_filter: Optional[str] = None, current_user: models.User = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    """A client's own requests, or the requests for a manager's listings."""
    q = db.query(models.Subscription).join(models.Listing)
    if current_user.role == "CLIENT":
        q = q.filter(models.Subscription.client_user_id == current_user.id)
    elif current_user.role == "MANAGER":
        q = q.join(models.Portfolio, models.Portfolio.id == models.Listing.portfolio_id).filter(
            models.Portfolio.user_id == current_user.id)
    else:
        raise HTTPException(status_code=403)
    if status_filter:
        q = q.filter(models.Subscription.status == status_filter)
    rows = q.order_by(models.Subscription.created_at.desc()).limit(500).all()
    return [marketplace.subscription_out(s, for_manager=current_user.role == "MANAGER") for s in rows]

def managed_subscription(subscription_id: int, user: models.User, db: Session) -> models.Subscription:
    if user.role != "MANAGER": raise HTTPException(status_code=403)
    sub = db.get(models.Subscription, subscription_id)
    if sub is None or sub.listing.portfolio is None or sub.listing.portfolio.user_id != user.id:
        raise HTTPException(status_code=404)
    if sub.status != "pending":
        raise HTTPException(status_code=409, detail="Este pedido já foi respondido")
    return sub

@app.post("/subscriptions/{subscription_id}/approve")
def approve_subscription(subscription_id: int, decision: marketplace.Decision,
                         current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Creates the license for the client's account (or extends it), already linked to the client."""
    sub = managed_subscription(subscription_id, current_user, db)
    lic = marketplace.approve(db, sub, decision, datetime.datetime.utcnow())
    payments.expire_checkout(sub)  # Approved by hand: its Stripe Checkout must not charge it too
    db.commit()
    logger.info(f"Subscription {sub.id} approved by manager {current_user.id}: license {lic.id} until {lic.expires_at}")
    notify_hub()
    mailer.send_decision(sub)
    return marketplace.subscription_out(sub, for_manager=True)

@app.post("/subscriptions/{subscription_id}/reject")
def reject_subscription(subscription_id: int, decision: marketplace.Decision,
                        current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    sub = managed_subscription(subscription_id, current_user, db)
    sub.status, sub.decided_at = "rejected", datetime.datetime.utcnow()
    sub.decision_note = (decision.note or "").strip() or None
    payments.expire_checkout(sub)
    db.commit()
    mailer.send_decision(sub)
    return marketplace.subscription_out(sub, for_manager=True)

@app.post("/me/subscriptions/{subscription_id}/cancel")
def cancel_my_subscription(subscription_id: int, current_user: models.User = Depends(get_current_user),
                           db: Session = Depends(get_db)):
    client_only(current_user)
    sub = db.get(models.Subscription, subscription_id)
    if sub is None or sub.client_user_id != current_user.id: raise HTTPException(status_code=404)
    if sub.status != "pending": raise HTTPException(status_code=409, detail="Este pedido já foi respondido")
    sub.status, sub.decided_at = "cancelled", datetime.datetime.utcnow()
    payments.expire_checkout(sub)
    db.commit()
    return marketplace.subscription_out(sub, for_manager=False)

def owned_portfolio(portfolio_id: int, user: models.User, db: Session) -> models.Portfolio:
    if user.role != "MANAGER": raise HTTPException(status_code=403)
    portfolio = db.query(models.Portfolio).filter(models.Portfolio.id == portfolio_id, models.Portfolio.user_id == user.id).first()
    if not portfolio: raise HTTPException(status_code=404)
    return portfolio

@app.get("/me/listings")
def list_my_listings(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Every portfolio of the manager, with its listing if it has one."""
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    listings = {l.portfolio_id: l for l in db.query(models.Listing).join(models.Portfolio)
                .filter(models.Portfolio.user_id == current_user.id)}
    return [{"portfolio": {"id": p.id, "name": p.name, "strategies": len(p.strategies)},
             "listing": marketplace.listing_out(listings[p.id]) if p.id in listings else None}
            for p in current_user.portfolios]

@app.put("/portfolios/{portfolio_id}/listing")
def save_listing(portfolio_id: int, data: marketplace.ListingIn, current_user: models.User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    """Creates the portfolio's listing as a draft, or edits it (published edits show at once)."""
    portfolio = owned_portfolio(portfolio_id, current_user, db)
    now = datetime.datetime.utcnow()
    listing = db.query(models.Listing).filter(models.Listing.portfolio_id == portfolio.id).first()
    if listing is None:
        listing = models.Listing(portfolio_id=portfolio.id, status="draft")
        db.add(listing)
    slug = marketplace.unique_slug(db, data.slug or marketplace.slugify(data.title), listing.id)
    marketplace.apply(listing, data, slug, now)
    db.flush()
    try:
        payments.save_plans(db, listing, data.plans)  # The plans' price, currency and period come from Stripe
    except payments.PaymentError as e:
        db.rollback()
        raise HTTPException(status_code=e.status, detail=str(e))
    db.commit()
    db.refresh(listing)
    marketplace.clear_cache()
    return marketplace.listing_out(listing)

@app.post("/portfolios/{portfolio_id}/listing/publish")
def publish_listing(portfolio_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    portfolio = owned_portfolio(portfolio_id, current_user, db)
    listing = db.query(models.Listing).filter(models.Listing.portfolio_id == portfolio.id).first()
    if listing is None: raise HTTPException(status_code=404, detail="Crie o anúncio antes de publicar")
    if listing.status == "suspended":
        raise HTTPException(status_code=409, detail="Anúncio suspenso pela administração: " + (listing.suspended_reason or "fale com o suporte"))
    if not portfolio.strategies:
        raise HTTPException(status_code=409, detail="Vincule ao menos uma estratégia ao portfólio antes de publicar")
    if not current_user.name:
        raise HTTPException(status_code=409, detail="Preencha seu nome público no perfil antes de publicar")
    listing.status = "published"
    listing.published_at = listing.published_at or datetime.datetime.utcnow()
    db.commit()
    marketplace.clear_cache()
    logger.info(f"Listing {listing.id} published by manager {current_user.id}")
    return marketplace.listing_out(listing)

@app.post("/portfolios/{portfolio_id}/listing/unpublish")
def unpublish_listing(portfolio_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Leaves the marketplace; licenses already sold keep working."""
    portfolio = owned_portfolio(portfolio_id, current_user, db)
    listing = db.query(models.Listing).filter(models.Listing.portfolio_id == portfolio.id).first()
    if listing is None: raise HTTPException(status_code=404)
    if listing.status == "published":
        listing.status = "draft"
        db.commit()
        marketplace.clear_cache()
    return marketplace.listing_out(listing)

class Suspension(BaseModel):
    reason: str = Field(min_length=3, max_length=255, pattern=hosting.ONE_LINE)

class EmailTestIn(BaseModel):
    to: str = Field(min_length=3, max_length=255)


@app.post("/admin/email-test")
def email_test(data: EmailTestIn, current_user: models.User = Depends(get_current_user)):
    """One message now, outside the queue, with what the SMTP server answered (mailer.test)."""
    if current_user.role != "TDM_DEV": raise HTTPException(status_code=403)
    to = data.to.strip().lower()
    if not EMAIL_PATTERN.match(to):
        raise HTTPException(status_code=422, detail="Email inválido")
    return mailer.test(to)

@app.get("/admin/listings")
def admin_list_listings(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "TDM_DEV": raise HTTPException(status_code=403)
    return [{**marketplace.listing_out(l), "manager": l.portfolio.owner.email if l.portfolio and l.portfolio.owner else None}
            for l in db.query(models.Listing).order_by(models.Listing.id)]

@app.post("/admin/listings/{listing_id}/suspend")
def admin_suspend_listing(listing_id: int, data: Suspension, current_user: models.User = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    """Takes a listing out of the marketplace; its manager cannot publish it again. Licenses keep working."""
    if current_user.role != "TDM_DEV": raise HTTPException(status_code=403)
    listing = db.get(models.Listing, listing_id)
    if listing is None: raise HTTPException(status_code=404)
    listing.status, listing.suspended_reason = "suspended", data.reason.strip()
    db.commit()
    marketplace.clear_cache()
    logger.info(f"Listing {listing.id} suspended by {current_user.id}: {listing.suspended_reason}")
    return marketplace.listing_out(listing)

@app.post("/admin/listings/{listing_id}/restore")
def admin_restore_listing(listing_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Back to draft: its manager decides when to publish again."""
    if current_user.role != "TDM_DEV": raise HTTPException(status_code=403)
    listing = db.get(models.Listing, listing_id)
    if listing is None: raise HTTPException(status_code=404)
    if listing.status == "suspended":
        listing.status, listing.suspended_reason = "draft", None
        db.commit()
    return marketplace.listing_out(listing)

@app.post("/pods/sync")
def pod_sync(report: hosting.PodSync, request: Request, db: Session = Depends(get_db)):
    """A hosting pod (pod_agent.py) reports its terminals and gets the ones it runs, credentials included."""
    f = hosting_cipher()
    pod = pod_from_request(request, db)
    out = hosting.sync(db, pod, report, f, datetime.datetime.utcnow())
    db.commit()
    return JSONResponse(out, headers={"Cache-Control": "no-store"})

# Serve static files (Frontend)
FRONTEND_DIST = "frontend/dist"
if not os.path.exists(FRONTEND_DIST):
    logger.warning("frontend/dist not found.")
    if not os.path.exists("frontend"): os.makedirs("frontend")
else:
    app.mount("/assets", StaticFiles(directory=f"{FRONTEND_DIST}/assets"), name="assets")

    # SPA catch-all: serve index.html for any unknown path
    # This handles page refreshes on React Router routes (e.g. /manager/portfolios)
    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        index = f"{FRONTEND_DIST}/index.html"
        if os.path.exists(index):
            return FileResponse(index)
        raise HTTPException(status_code=404, detail="Frontend not found")

# --- Main Entry Point (local dev; the container runs `python migrate.py && uvicorn server:app`) ---
async def main():
    config = uvicorn.Config(app=app, host="0.0.0.0", port=8000, log_level="info")
    server = uvicorn.Server(config)
    await server.serve()

if __name__ == "__main__":
    import migrate
    migrate.main()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass