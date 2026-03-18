
import asyncio
import logging
from typing import List, Dict, Set, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, status
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
import uvicorn
import os
import zmq
import zmq.asyncio
from pydantic import BaseModel

# Internal Imports
import database
import models
import auth

import time

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Initialize DB Tables (with retry for container startup)
MAX_DB_RETRIES = 5
for _attempt in range(1, MAX_DB_RETRIES + 1):
    try:
        models.Base.metadata.create_all(bind=database.engine)
        break
    except Exception as e:
        if _attempt == MAX_DB_RETRIES:
            logger.error(f"Failed to connect to database after {MAX_DB_RETRIES} attempts: {e}")
            raise
        logger.warning(f"DB connection attempt {_attempt}/{MAX_DB_RETRIES} failed: {e}. Retrying in {_attempt * 2}s...")
        time.sleep(_attempt * 2)
     
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

seed_superuser()


# --- Trade Manager (Updated for Multi-Tenant) ---
class TradeManager:
    def __init__(self):
        # In-memory state for Web Dashboard
        self.active_trades: Dict[str, dict] = {} 
        self.web_clients: Set[WebSocket] = set()
        
        # ZMQ Context
        self.zmq_context = zmq.asyncio.Context()
        self.pub_socket = self.zmq_context.socket(zmq.PUB)
        self.pub_socket.bind("tcp://*:5556") # Publisher for Slaves

    async def connect_web(self, websocket: WebSocket):
        await websocket.accept()
        self.web_clients.add(websocket)
        logger.info(f"New Web Client connected. Total: {len(self.web_clients)}")
        # Send current state
        await websocket.send_json({"type": "STATE", "trades": self.active_trades})

    def disconnect_web(self, websocket: WebSocket):
        self.web_clients.remove(websocket)
        logger.info(f"Web Client disconnected. Total: {len(self.web_clients)}")

    async def broadcast_to_web(self, message: dict):
        if not self.web_clients:
            return
        
        disconnected = []
        for client in self.web_clients:
            try:
                await client.send_json(message)
            except Exception as e:
                logger.error(f"Error sending to web client: {e}")
                disconnected.append(client)
        
        for client in disconnected:
            self.web_clients.remove(client)

    async def broadcast_to_specific_topic(self, topic: str, message: str):
        """
        Broadcasts to a specific ZMQ Topic.
        Format: TOPIC message
        """
        try:
            full_msg = f"{topic} {message}"
            await self.pub_socket.send_string(full_msg)
        except Exception as e:
            logger.error(f"Error broadcasting: {e}")

    async def process_master_message(self, master_key: str, payload: str, db: Session):
        try:
            parts = payload.split('|')
            # Format: ACTION|POS_ID|TYPE|SYMBOL|VOL|PRICE|SL|TP|MAGIC
            if len(parts) < 9: return
            
            action = parts[0]
            pos_id = int(parts[1])
            type_   = int(parts[2])
            symbol  = parts[3]
            vol     = float(parts[4])
            price   = float(parts[5])
            sl      = float(parts[6])
            tp      = float(parts[7])
            magic   = int(parts[8])

            # 1. FIND MANAGER BY MASTER KEY
            manager = db.query(models.User).filter(models.User.master_key == master_key).first()
            if not manager:
                logger.warning(f"Invalid Master Key: {master_key}")
                return

            if manager.status != 'active':
                logger.warning(f"Manager {manager.email} is {manager.status}. Trade ignored.")
                return

            # 2. FIND STRATEGY BY MAGIC NUMBER FOR THIS MANAGER
            strategy = db.query(models.Strategy).filter(
                models.Strategy.user_id == manager.id, 
                models.Strategy.magic_number == magic
            ).first()
            
            if not strategy:
                logger.warning(f"Strategy not found for Magic {magic} (Manager: {manager.email})")
                return

            if not strategy.is_active: return

            # 3. CONSTRUCT SIGNAL
            signal = {
                "action": action,
                "ticket": pos_id,
                "symbol": symbol,
                "type": type_,
                "volume": vol,
                "price": price,
                "sl": sl,
                "tp": tp,
                "strategy_id": strategy.id,
                "magic": magic
            }

            # 4. BROADCAST to ZMQ Topics (Strategy & Portfolios)
            await self.broadcast_to_specific_topic(f"S_{strategy.id}", payload)
            for portfolio in strategy.portfolios:
                await self.broadcast_to_specific_topic(f"P_{portfolio.id}", payload)

            # 5. UPDATE WEB DASHBOARD
            trade_data = {
                "action": action,
                "raw": payload,
                "strategy_name": strategy.name,
                "timestamp": asyncio.get_event_loop().time(),
                "ticket": pos_id,
                "magic": magic
            }
            if action == "OPEN":
                trade_details = {
                    "type": type_,
                    "symbol": symbol,
                    "volume": vol,
                    "price": price,
                    "sl": sl,
                    "tp": tp
                }
                unique_id = f"{strategy.id}_{pos_id}"
                self.active_trades[unique_id] = {**trade_data, **trade_details}
                trade_data.update(trade_details)
            
            elif action == "CLOSE":
                unique_id = f"{strategy.id}_{pos_id}"
                if unique_id in self.active_trades:
                    del self.active_trades[unique_id]

            await self.broadcast_to_web({"type": "UPDATE", "data": trade_data})
            logger.info(f"Broadcasted signal for Strategy {strategy.name} (Magic {magic})")

        except Exception as e:
            logger.error(f"Error processing master message: {e}")

trade_manager = TradeManager()

# --- FastAPI App ---
app = FastAPI()
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

@app.get("/health")
@app.get("/api/health")
async def health_check(db: Session = Depends(get_db)):
    try:
        # Check database connection type
        db_url = str(database.engine.url)
        db_type = "PostgreSQL (Supabase)" if "postgresql" in db_url else "SQLite (Local)"
        
        # Check if users table is accessible
        user_count = db.query(models.User).count()
        
        return {
            "status": "healthy",
            "version": "v2026.02.23.2307",
            "database_type": db_type,
            "user_count": user_count
        }
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return {"status": "error", "message": str(e)}

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

# --- ZeroMQ Listener (For Master) ---
async def start_zmq_listener():
    pull_socket = trade_manager.zmq_context.socket(zmq.PULL)
    master_port = os.environ.get("ZMQ_MASTER_PORT", "5557")
    pull_socket.bind(f"tcp://*:5557") 
    try:
        while True:
            msg = await pull_socket.recv_string()
            logger.info(f"DEBUG: ZMQ Received raw: {msg}")
            parts = msg.split('|', 1)
            if len(parts) == 2:
                key = parts[0]
                payload = parts[1]
                db = database.SessionLocal()
                try:
                    await trade_manager.process_master_message(key, payload, db)
                finally:
                    db.close()
            else:
                logger.warning(f"Malformed message: {msg}")
    except Exception as e:
        logger.error(f"ZMQ Listener Error: {e}")
    finally:
        pull_socket.close()

# --- Main Entry Point ---
async def main():
    zmq_task = asyncio.create_task(start_zmq_listener())
    config = uvicorn.Config(app=app, host="0.0.0.0", port=8000, log_level="info")
    server = uvicorn.Server(config)
    await asyncio.gather(zmq_task, server.serve())

if __name__ == "__main__":
    import os
    if os.name == 'nt':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass