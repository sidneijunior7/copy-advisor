
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
from sqlalchemy.orm import Session
import uvicorn
import os
import threading
import zmq
from pydantic import BaseModel

# Internal Imports
import database
import models
import auth
import observability

observability.setup("api")
logger = logging.getLogger(__name__)

# The signal hub (hub.py) runs as a separate service; the API only relays its events to the dashboard.
# Schema is managed by Alembic: run `python migrate.py` before starting (the Dockerfile CMD does).
HUB_EVENTS_URL = os.getenv("HUB_EVENTS_URL", "tcp://127.0.0.1:5558")
HUB_HEALTH_URL = os.getenv("HUB_HEALTH_URL", "http://127.0.0.1:8001/health")

# Browser origins allowed to call the API from another host (e.g. the Vite dev server).
# Empty in production: the dashboard is served by this same app.
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]

WS_AUTH_TIMEOUT = 5  # Seconds a dashboard has to send its token after connecting
WS_CLOSE_UNAUTHORIZED = 4401  # The client should log out instead of reconnecting
WS_CLOSE_FORBIDDEN = 4403

# Failed logins and license checks allowed per client IP inside the window, then 429 until it slides
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
    stop = threading.Event()
    relay = threading.Thread(target=trade_manager.relay_hub_events, args=(asyncio.get_running_loop(), stop),
                             name="hub-relay", daemon=True)
    relay.start()
    yield
    stop.set()
    relay.join(2)

app = FastAPI(lifespan=lifespan)
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
def get_db():
    db = database.SessionLocal()
    try:
        yield db
    finally:
        db.close()

def user_from_token(token: str, db: Session) -> Optional[models.User]:
    """The account behind a valid, unexpired token, or None."""
    payload = auth.decode_token(token)
    email = payload.get("sub") if payload else None
    if not email:
        return None
    return db.query(models.User).filter(models.User.email == email).first()

async def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
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
    max_lots: float
    portfolio_id: int

class LicenseCheck(BaseModel):
    connection_key: str
    mt5_login: int

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

@app.get("/health")
@app.get("/api/health")
async def health_check(db: Session = Depends(get_db)):
    db_type = "PostgreSQL (Supabase)" if database.IS_POSTGRES else "SQLite (Local)"
    hub = await asyncio.to_thread(fetch_hub_health)
    try:
        user_count = db.query(models.User).count()
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        # Only a dead database makes the API itself unhealthy; hub problems are reported, not fatal
        return JSONResponse(status_code=503, content={"status": "error", "database": str(e), "hub": hub})

    return {
        "status": "healthy" if hub.get("status") == "healthy" and not hub.get("warming") else "degraded",
        "version": "v2026.09.15",
        "database_type": db_type,
        "user_count": user_count,
        "hub": hub,
    }

@app.post("/token", response_model=Token)
async def login_for_access_token(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
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
async def refresh_access_token(token: str = Depends(oauth2_scheme), current_user: models.User = Depends(get_current_user)):
    """A new token for a still-valid one. The session still ends SESSION_MAX_HOURS after the login."""
    auth_time = auth.decode_token(token).get("auth_time")
    access_token = auth.create_access_token(data={"sub": current_user.email, "role": current_user.role},
                                            session_start=auth_time)
    return {"access_token": access_token, "token_type": "bearer"}

@app.get("/admin/managers")
async def list_managers(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "TDM_DEV": raise HTTPException(status_code=403)
    managers = db.query(models.User).filter(models.User.role == "MANAGER").all()
    # Mask passwords
    for m in managers: m.password_hash = "***"
    return managers

@app.post("/admin/managers")
async def create_manager(user: UserCreate, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
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
async def update_manager_status(user_id: int, status: str, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "TDM_DEV": raise HTTPException(status_code=403)
    if status not in ["active", "frozen", "archived"]: raise HTTPException(status_code=400, detail="Invalid status")
    
    manager = db.query(models.User).filter(models.User.id == user_id).first()
    if not manager: raise HTTPException(status_code=404)
    manager.status = status
    db.commit()
    return {"message": f"Manager status updated to {status}"}

@app.post("/strategies")
async def create_strategy(strategy: StrategyCreate, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
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
async def list_strategies(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    return current_user.strategies

@app.post("/portfolios")
async def create_portfolio(portfolio: PortfolioCreate, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    new_portfolio = models.Portfolio(user_id=current_user.id, name=portfolio.name)
    db.add(new_portfolio)
    db.commit()
    db.refresh(new_portfolio)
    return new_portfolio

@app.get("/portfolios")
async def list_portfolios(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    result = []
    for p in current_user.portfolios:
        result.append({
            "id": p.id,
            "name": p.name,
            "public_key": p.public_key,
            "strategies": [
                {"id": s.id, "name": s.name, "magic_number": s.magic_number}
                for s in p.strategies
            ]
        })
    return result

@app.get("/me/manager")
async def get_manager_details(current_user: models.User = Depends(get_current_user)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    return {
        "id": current_user.id,
        "email": current_user.email,
        "master_key": current_user.master_key,
        "status": current_user.status
    }

@app.post("/me/manager/rotate-key")
async def rotate_master_key(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Revoke a leaked master_key. Every Master EA of this manager must be reconfigured with the new one;
    the hub stops accepting the old key within HUB_DIRECTORY_TTL_SECONDS."""
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    current_user.master_key = models.generate_key()
    db.commit()
    logger.info(f"master_key rotated for manager {current_user.id}")
    return {"master_key": current_user.master_key}

@app.get("/licenses")
async def list_licenses(current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    # Join nicely to show context
    licenses = db.query(models.License).filter(
        (models.License.strategy_id.in_([s.id for s in current_user.strategies])) | 
        (models.License.portfolio_id.in_([p.id for p in current_user.portfolios]))
    ).all()
    return licenses

@app.post("/portfolios/{portfolio_id}/add_strategy/{strategy_id}")
async def add_strategy_to_portfolio(portfolio_id: int, strategy_id: int, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    portfolio = db.query(models.Portfolio).filter(models.Portfolio.id == portfolio_id, models.Portfolio.user_id == current_user.id).first()
    strategy = db.query(models.Strategy).filter(models.Strategy.id == strategy_id, models.Strategy.user_id == current_user.id).first()
    
    if not portfolio or not strategy: raise HTTPException(status_code=404)
    portfolio.strategies.append(strategy)
    db.commit()
    return {"message": "Strategy added to Portfolio"}

@app.post("/licenses")
async def create_license(license_data: LicenseCreate, current_user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if current_user.role != "MANAGER": raise HTTPException(status_code=403)
    port = db.query(models.Portfolio).filter(models.Portfolio.id == license_data.portfolio_id, models.Portfolio.user_id == current_user.id).first()
    if not port: raise HTTPException(status_code=404, detail="Portfolio not found")

    new_license = models.License(
        portfolio_id=license_data.portfolio_id,
        client_mt5_login=license_data.client_mt5_login,
        max_lots=license_data.max_lots
    )
    db.add(new_license)
    db.commit()
    return new_license

@app.post("/api/license/check")
async def check_license(check: LicenseCheck, request: Request, db: Session = Depends(get_db)):
    """Anonymous (the Slave EA calls it); failures are rate limited per IP against key enumeration."""
    check_not_limited("license", request)
    valid_license = None
    zmq_topic = ""
    portfolio = db.query(models.Portfolio).filter(models.Portfolio.public_key == check.connection_key).first()
    if portfolio:
        valid_license = db.query(models.License).filter(
            models.License.portfolio_id == portfolio.id,
            models.License.client_mt5_login == check.mt5_login,
            models.License.is_active == True
        ).first()
        zmq_topic = f"P_{portfolio.id}"
    
    if not valid_license:
        failure_limiter.fail(f"license:{client_ip(request)}")
        raise HTTPException(status_code=403, detail="Invalid License or Key")
    return {"status": "active", "topic": zmq_topic, "max_lots": valid_license.max_lots}

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