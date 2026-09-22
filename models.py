
from sqlalchemy import Column, Integer, BigInteger, String, Float, Boolean, ForeignKey, DateTime, Table, Text, Index, UniqueConstraint
from sqlalchemy.orm import relationship
from database import Base
import datetime
import uuid

def generate_key():
    return str(uuid.uuid4())

# SQLite only autoincrements INTEGER PRIMARY KEY, so BigInteger PKs fall back to Integer there
BigIntPK = BigInteger().with_variant(Integer, "sqlite")

# Many-to-Many relationship between Portfolios and Strategies
portfolio_items = Table(
    'portfolio_items',
    Base.metadata,
    Column('portfolio_id', Integer, ForeignKey('portfolios.id'), primary_key=True),
    Column('strategy_id', Integer, ForeignKey('strategies.id'), primary_key=True)
)

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, index=True)
    password_hash = Column(String(255))
    role = Column(String(50), default="CLIENT") # MANAGER, CLIENT, TDM_DEV
    status = Column(String(20), default="active") # active, frozen, archived
    master_key = Column(String(100), unique=True, default=generate_key) # Single Key for Master EA
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    strategies = relationship("Strategy", back_populates="owner")
    portfolios = relationship("Portfolio", back_populates="owner")

class Strategy(Base):
    __tablename__ = "strategies"
    __table_args__ = (UniqueConstraint("user_id", "magic_number", name="uq_strategies_user_magic"),)

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    name = Column(String(100))
    magic_number = Column(BigInteger) # Magic number used in MT5 (ulong in MQL5)
    # secret_key removed in favor of User.master_key
    is_active = Column(Boolean, default=True)

    owner = relationship("User", back_populates="strategies")
    portfolios = relationship("Portfolio", secondary=portfolio_items, back_populates="strategies")
    licenses = relationship("License", back_populates="strategy")

class Portfolio(Base):
    __tablename__ = "portfolios"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    name = Column(String(100))
    public_key = Column(String(100), unique=True, default=generate_key) # Key for Client to Subscribe

    owner = relationship("User", back_populates="portfolios")
    strategies = relationship("Strategy", secondary=portfolio_items, back_populates="portfolios")
    licenses = relationship("License", back_populates="portfolio")

class License(Base):
    __tablename__ = "licenses"

    id = Column(Integer, primary_key=True, index=True)
    portfolio_id = Column(Integer, ForeignKey("portfolios.id"), nullable=True) # Access to whole Portfolio
    strategy_id = Column(Integer, ForeignKey("strategies.id"), nullable=True) # OR Access to single Strategy

    client_mt5_login = Column(BigInteger) # The MT5 login allowed
    max_lots = Column(Float, default=1.0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    portfolio = relationship("Portfolio", back_populates="licenses")
    strategy = relationship("Strategy", back_populates="licenses")

# --- Signal history (written by hub.py) ---

class MasterPosition(Base):
    """Last known state of a position on a Master account. closed_at is set once and never cleared."""
    __tablename__ = "master_positions"
    __table_args__ = (
        UniqueConstraint("manager_id", "master_login", "pos_id", name="uq_master_positions_identity"),
        Index("ix_master_positions_strategy_open", "strategy_id", "closed_at"),
    )

    id = Column(BigIntPK, primary_key=True)
    manager_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    strategy_id = Column(Integer, ForeignKey("strategies.id"), nullable=False) # Frozen at creation
    master_login = Column(BigInteger, nullable=False)
    pos_id = Column(BigInteger, nullable=False) # POSITION_IDENTIFIER on the Master
    symbol = Column(String(64), nullable=False)
    type = Column(Integer, nullable=False) # 0 = buy, 1 = sell
    volume = Column(Float, nullable=False)
    price_open = Column(Float)
    sl = Column(Float)
    tp = Column(Float)
    magic = Column(BigInteger)
    opened_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)
    closed_at = Column(DateTime, nullable=True)

class Signal(Base):
    """Every state change the hub accepted and published."""
    __tablename__ = "signals"

    id = Column(BigIntPK, primary_key=True)
    master_position_id = Column(BigInteger, ForeignKey("master_positions.id"), nullable=False, index=True)
    reason = Column(String(16), nullable=False) # OPEN, ADD, PARTIAL, CLOSE, REVERSE, MODIFY, SYNC
    type = Column(Integer)
    volume = Column(Float)
    price_open = Column(Float)
    sl = Column(Float)
    tp = Column(Float)
    raw = Column(Text)
    received_at = Column(DateTime, default=datetime.datetime.utcnow, index=True)

class Execution(Base):
    """Execution reports sent by Slave EAs."""
    __tablename__ = "executions"

    id = Column(BigIntPK, primary_key=True)
    uid = Column(String(64), nullable=False, index=True) # <master_login>_<pos_id>
    portfolio_id = Column(Integer, ForeignKey("portfolios.id"), nullable=True)
    mt5_login = Column(BigInteger, nullable=False)
    action = Column(String(16), nullable=False)
    position_id = Column(BigInteger)
    volume = Column(Float)
    price = Column(Float)
    retcode = Column(Integer)
    seq = Column(BigInteger)
    created_at = Column(DateTime, default=datetime.datetime.utcnow, index=True)
