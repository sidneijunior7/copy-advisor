
from sqlalchemy import Column, Integer, String, Float, Boolean, ForeignKey, DateTime, Table
from sqlalchemy.orm import relationship
from database import Base
import datetime
import uuid

def generate_key():
    return str(uuid.uuid4())

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

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    name = Column(String(100))
    magic_number = Column(Integer) # Magic number used in MT5
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
    
    client_mt5_login = Column(Integer) # The MT5 login allowed
    max_lots = Column(Float, default=1.0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    
    portfolio = relationship("Portfolio", back_populates="licenses")
    strategy = relationship("Strategy", back_populates="licenses")
