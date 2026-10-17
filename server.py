
import asyncio
import datetime
import json
import logging
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
from sqlalchemy.exc import InterfaceError, OperationalError, TimeoutError as PoolTimeoutError
from sqlalchemy.orm import Session
import uvicorn
import os
import threading
import zmq
from pydantic import BaseModel, Field

# Internal Imports
import database
import keys
import models
import auth
import observability

observability.setup("api")
logger = logging.getLogger(__name__)

# The signal hub (hub.py) runs as a separate service; the API only relays its events to the dashboard.
# Schema is managed by Alembic: the container migrates in the background at startup (MIGRATE_ON_START=1,
# see SchemaState); elsewhere run `python migrate.py` before starting.
HUB_EVENTS_URL = os.getenv("HUB_EVENTS_URL", "tcp://127.0.0.1:5558")
HUB_HEALTH_URL = os.getenv("HUB_HEALTH_URL", "http://127.0.0.1:8001/health")
HUB_BASE_URL = HUB_HEALTH_URL.rsplit("/health", 1)[0]  # Same internal port: /sessions and /refresh
MAX_MASTER_KEYS = 20  # Active keys per manager

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
    return db.query(models.User).filter(models.User.email == email).first()

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
    user = db.query(models.User).filter(models.User.email == form_data.username).first()

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
            ]
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
    sessions = fetch_hub_sessions()
    if sessions is None:
        return {"available": False, "masters": [], "slaves": []}
    portfolios = {p.id: p.name for p in current_user.portfolios}
    labels = {mk.id: mk.label for mk in db.query(models.MasterKey).filter(models.MasterKey.user_id == current_user.id)}
    masters = [{**s, "key_label": labels.get(s["key_id"])} for s in sessions
               if s["kind"] == "master" and s["manager_id"] == current_user.id]
    slaves = [{**s, "portfolio_name": portfolios[s["portfolio_id"]]} for s in sessions
              if s["kind"] == "slave" and s["portfolio_id"] in portfolios]
    return {"available": True, "masters": masters, "slaves": slaves}

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