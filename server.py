
import asyncio
import datetime
import json
import logging
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from typing import List, Dict, Set, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, status
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

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# The signal hub (hub.py) runs as a separate service; the API only relays its events to the dashboard.
# Schema is managed by Alembic: run `python migrate.py` before starting (the Dockerfile CMD does).
HUB_EVENTS_URL = os.getenv("HUB_EVENTS_URL", "tcp://127.0.0.1:5558")
HUB_HEALTH_URL = os.getenv("HUB_HEALTH_URL", "http://127.0.0.1:8001/health")

# Seed Default TDM_DEV User
def seed_superuser():
    db = database.SessionLocal()
    try:
        # Check if TDM_DEV exists
        if not db.query(models.User).filter(models.User.role == "TDM_DEV").first():
             print("Creating default TDM_DEV user...")
             # hashed = auth.get_password_hash("tdmdev123")
             hashed = "$5$rounds=535000$Y2Q0D0XknO0vUy0N$CF1gxqanWC0SPF1qd4.VvgHD9bmfGRM6UoKy8c/p4x/"
             print(f"DEBUG SEED: Used Hardcoded Hash: {hashed}")
             print(f"DEBUG SEED: Immediate Verify: {auth.verify_password('tdmdev123', hashed)}")
             
             dev_user = models.User(email="dev@trademetric.com", password_hash=hashed, role="TDM_DEV", status="active")
             db.add(dev_user)
             db.commit()
             print("TDM_DEV created: dev@trademetric.com / tdmdev123")
    finally:
        db.close()


def open_positions_state() -> Dict[str, dict]:
    """Open Master positions, keyed like the hub's WEB events ("strategyId_login_posId")."""
    db = database.SessionLocal()
    try:
        rows = (
            db.query(models.MasterPosition, models.Strategy.name)
            .join(models.Strategy, models.Strategy.id == models.MasterPosition.strategy_id)
            .filter(models.MasterPosition.closed_at.is_(None))
            .all()
        )
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
        self.web_clients: Set[WebSocket] = set()

    async def connect_web(self, websocket: WebSocket):
        await websocket.accept()
        self.web_clients.add(websocket)
        logger.info(f"New Web Client connected. Total: {len(self.web_clients)}")
        # Send current state
        trades = await asyncio.to_thread(open_positions_state)
        await websocket.send_json({"type": "STATE", "trades": trades})

    def disconnect_web(self, websocket: WebSocket):
        self.web_clients.discard(websocket)
        logger.info(f"Web Client disconnected. Total: {len(self.web_clients)}")

    async def broadcast_to_web(self, message: dict):
        if not self.web_clients:
            return
        
        disconnected = []
        for client in list(self.web_clients):  # Clients may connect while we await a send
            try:
                await client.send_json(message)
            except Exception as e:
                logger.error(f"Error sending to web client: {e}")
                disconnected.append(client)
        
        for client in disconnected:
            self.web_clients.discard(client)

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
    seed_superuser()
    stop = threading.Event()
    relay = threading.Thread(target=trade_manager.relay_hub_events, args=(asyncio.get_running_loop(), stop),
                             name="hub-relay", daemon=True)
    relay.start()
    yield
    stop.set()
    relay.join(2)

app = FastAPI(lifespan=lifespan)
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
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

async def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    payload = auth.decode_token(token)
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    email: str = payload.get("sub")
    if email is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    
    user = db.query(models.User).filter(models.User.email == email).first()
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
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

class LicenseCreate(BaseModel):
    client_mt5_login: int
    max_lots: float
    strategy_id: Optional[int] = None
    portfolio_id: Optional[int] = None

class LicenseCheck(BaseModel):
    connection_key: str
    mt5_login: int

# --- API Routes ---

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await trade_manager.connect_web(websocket)
    try:
        while True:
            # Keep connection alive
            data = await websocket.receive_text()
    except WebSocketDisconnect:
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
async def login_for_access_token(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    logger.info(f"Login attempt for user: {form_data.username}")
    user = db.query(models.User).filter(models.User.email == form_data.username).first()
    
    if not user:
        logger.warning(f"Login failed: User {form_data.username} not found")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    
    if not auth.verify_password(form_data.password, user.password_hash):
        logger.warning(f"Login failed: Incorrect password for user {form_data.username}")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    
    if user.status != 'active' and user.role != 'TDM_DEV':
        logger.warning(f"Login failed: Account {user.email} is {user.status}")
        raise HTTPException(status_code=403, detail=f"Account is {user.status}")
    
    access_token = auth.create_access_token(data={"sub": user.email, "role": user.role})
    logger.info(f"Login successful for user: {user.email}")
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
    if license_data.strategy_id:
        strat = db.query(models.Strategy).filter(models.Strategy.id == license_data.strategy_id, models.Strategy.user_id == current_user.id).first()
        if not strat: raise HTTPException(status_code=404, detail="Strategy not found")
    elif license_data.portfolio_id:
        port = db.query(models.Portfolio).filter(models.Portfolio.id == license_data.portfolio_id, models.Portfolio.user_id == current_user.id).first()
        if not port: raise HTTPException(status_code=404, detail="Portfolio not found")
    else: raise HTTPException(status_code=400)

    new_license = models.License(
        strategy_id=license_data.strategy_id,
        portfolio_id=license_data.portfolio_id,
        client_mt5_login=license_data.client_mt5_login,
        max_lots=license_data.max_lots
    )
    db.add(new_license)
    db.commit()
    return new_license

@app.post("/api/license/check")
async def check_license(check: LicenseCheck, db: Session = Depends(get_db)):
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