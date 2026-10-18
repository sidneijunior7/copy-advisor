
from sqlalchemy import Column, Integer, BigInteger, String, Float, Boolean, ForeignKey, DateTime, Table, Text, Index, UniqueConstraint
from sqlalchemy.orm import relationship
from database import Base
import datetime

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
    name = Column(String(100), nullable=True) # Shown to the other side: a client's manager, a manager's clients
    bio = Column(Text, nullable=True) # A manager's public profile in the marketplace
    email_verified_at = Column(DateTime, nullable=True)
    password_changed_at = Column(DateTime, nullable=True) # Sessions that began before it are over
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
    is_active = Column(Boolean, default=True)

    owner = relationship("User", back_populates="strategies")
    portfolios = relationship("Portfolio", secondary=portfolio_items, back_populates="strategies")
    licenses = relationship("License", back_populates="strategy")

class Portfolio(Base):
    __tablename__ = "portfolios"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    name = Column(String(100))
    client_limits = Column(Text) # JSON (clients.ClientLimits): what a client may set on its own licenses

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
    # Slave key of this license alone (keys.py): only its hash is stored. NULL until the manager generates one.
    key_hash = Column(String(64), unique=True, index=True, nullable=True)
    key_prefix = Column(String(16), nullable=True)
    expires_at = Column(DateTime, nullable=True) # UTC; NULL = no expiry. Expired = revoked for the hub
    revoked_at = Column(DateTime, nullable=True) # UTC, set when is_active goes false: positions opened after it are never sent
    # The client account it belongs to, linked with a one-time access code (clients.py)
    client_user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    claim_hash = Column(String(64), nullable=True, unique=True, index=True) # Pending access code, hashed; cleared once used
    claim_expires_at = Column(DateTime, nullable=True)
    settings = Column(Text) # JSON (hosting.SlaveInputs): how this license's Slave copies

    portfolio = relationship("Portfolio", back_populates="licenses")
    strategy = relationship("Strategy", back_populates="licenses")
    client = relationship("User", foreign_keys=[client_user_id])

class MasterKey(Base):
    """Key a Master EA authenticates with. A manager can hold several (one per Master/VPS) and revoke each."""
    __tablename__ = "master_keys"
    __table_args__ = (UniqueConstraint("key_hash", name="uq_master_keys_key_hash"),)

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    label = Column(String(64), nullable=False)
    key_hash = Column(String(64), nullable=False)
    key_prefix = Column(String(16), nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    last_used_at = Column(DateTime, nullable=True) # Updated by the hub at most hourly
    revoked_at = Column(DateTime, nullable=True)

# --- Marketplace (marketplace.py) ---

class Listing(Base):
    """A portfolio offered in the public marketplace. Only its manager edits it; a TDM_DEV can suspend it."""
    __tablename__ = "listings"
    __table_args__ = (UniqueConstraint("portfolio_id", name="uq_listings_portfolio"),
                      UniqueConstraint("slug", name="uq_listings_slug"))

    id = Column(Integer, primary_key=True)
    portfolio_id = Column(Integer, ForeignKey("portfolios.id"), nullable=False)
    slug = Column(String(80), nullable=False) # Its address: /marketplace/<slug>
    title = Column(String(80), nullable=False)
    summary = Column(String(200))
    description = Column(Text) # Plain text, shown as written
    markets = Column(String(100)) # Comma-separated (marketplace.MARKETS)
    price = Column(Float) # Per period of default_days, in currency
    currency = Column(String(3), default="BRL")
    checkout_url = Column(String(500)) # Where the client pays, until payments are built in
    default_days = Column(Integer, default=30) # Validity an approved subscription grants
    default_max_lots = Column(Float, default=1.0)
    min_capital = Column(Float)
    hosting_allowed = Column(Boolean, default=True)
    status = Column(String(16), nullable=False, default="draft") # draft, published, suspended
    suspended_reason = Column(String(255))
    published_at = Column(DateTime)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)

    portfolio = relationship("Portfolio")

class Subscription(Base):
    """A client asking for a listing (or to renew its license). Approving creates or extends the license."""
    __tablename__ = "subscriptions"
    __table_args__ = (Index("ix_subscriptions_listing_status", "listing_id", "status"),)

    id = Column(Integer, primary_key=True)
    listing_id = Column(Integer, ForeignKey("listings.id"), nullable=False)
    client_user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    mt5_login = Column(BigInteger, nullable=False)
    kind = Column(String(16), nullable=False, default="new") # new, renewal
    status = Column(String(16), nullable=False, default="pending") # pending, approved, rejected, cancelled
    note = Column(String(500)) # From the client
    decision_note = Column(String(500)) # From the manager
    license_id = Column(Integer, ForeignKey("licenses.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    decided_at = Column(DateTime)

    listing = relationship("Listing")
    client = relationship("User")
    license = relationship("License")

class UserToken(Base):
    """One-time links sent by email: verify the address, reset the password. Only the hash is stored."""
    __tablename__ = "user_tokens"
    __table_args__ = (UniqueConstraint("token_hash", name="uq_user_tokens_hash"),)

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    kind = Column(String(16), nullable=False) # verify, reset
    token_hash = Column(String(64), nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

# --- Hosted terminals (hosting.py): the client's MT5 runs in one of our pods instead of on the client's machine ---

class HostedPod(Base):
    """A container running hosted terminals (pod_agent.py). It authenticates with its own key (pod_...)."""
    __tablename__ = "hosted_pods"
    __table_args__ = (UniqueConstraint("key_hash", name="uq_hosted_pods_key_hash"),)

    id = Column(Integer, primary_key=True)
    name = Column(String(64), nullable=False)
    key_hash = Column(String(64), nullable=False)
    key_prefix = Column(String(16), nullable=False)
    capacity = Column(Integer, nullable=False, default=0) # Terminals it can run, from its last sync
    info = Column(Text) # JSON from its last sync: agent version, memory, broker servers it knows
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    last_seen_at = Column(DateTime, nullable=True)
    revoked_at = Column(DateTime, nullable=True)

class HostedTerminal(Base):
    """A license whose Slave runs in a pod. The broker password and the license key are stored encrypted, not
    hashed: the pod has to hand them to MT5."""
    __tablename__ = "hosted_terminals"
    __table_args__ = (UniqueConstraint("license_id", name="uq_hosted_terminals_license_id"),)

    id = Column(Integer, primary_key=True)
    license_id = Column(Integer, ForeignKey("licenses.id"), nullable=False)
    server = Column(String(64), nullable=False) # Broker server, as in the MT5 login dialog
    password_enc = Column(Text, nullable=False)
    license_key_enc = Column(Text, nullable=False)
    inputs = Column(Text) # JSON of Slave inputs (hosting.SlaveInputs)
    enabled = Column(Boolean, nullable=False, default=True)
    config_version = Column(Integer, nullable=False, default=1) # Bumped on every change: the pod restarts the terminal
    pod_id = Column(Integer, ForeignKey("hosted_pods.id"), nullable=True, index=True) # Kept while disabled: the copy mapping lives in that pod
    status = Column(String(32), nullable=False, default="pending") # As the pod last reported it
    status_detail = Column(String(255))
    status_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)

    license = relationship("License")
    pod = relationship("HostedPod")

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

class MasterAccount(Base):
    """Trading account a Master EA runs on, as reported by its V2HELLO."""
    __tablename__ = "master_accounts"
    __table_args__ = (UniqueConstraint("manager_id", "master_login", name="uq_master_accounts_identity"),)

    id = Column(Integer, primary_key=True)
    manager_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    master_login = Column(BigInteger, nullable=False)
    trade_mode = Column(String(16), nullable=False) # demo, contest, real, unknown (ACCOUNT_TRADE_MODE)
    server = Column(String(64))
    company = Column(String(128))
    first_seen_at = Column(DateTime, default=datetime.datetime.utcnow)
    last_seen_at = Column(DateTime, default=datetime.datetime.utcnow)

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

# MT5 TRADE_RETCODE_PLACED, DONE and DONE_PARTIAL: the order went through. Anything else in executions.retcode
# is a copy the Slave could not make, or made smaller: the broker's refusal, NO_MONEY (10019) from the Slave's
# own margin check, or LIMIT_VOLUME (10034) for the volume the license's lot limit held back.
EXECUTION_DONE = (10008, 10009, 10010)
# A done execution with one of these is part of a copy's result (followers.py): kept past HUB_RETENTION_DAYS
COPY_ACTIONS = ("OPEN", "ADD", "REVERSE", "PARTIAL", "CLOSE", "CLOSE_EXT")


class Execution(Base):
    """Execution reports sent by Slave EAs."""
    __tablename__ = "executions"
    __table_args__ = (Index("ix_executions_portfolio_created", "portfolio_id", "created_at"),)

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
    latency_ms = Column(Integer, nullable=True) # Hub publishing the state -> this report; None when unmatched
    profit = Column(Float, nullable=True) # Of a close, in the account's currency, swap and commission included (Slave 4.04+)
    created_at = Column(DateTime, default=datetime.datetime.utcnow, index=True)

class MasterDeal(Base):
    """A deal on a Master account (V2DEAL, Master 4.01+): what each position realized, and deposits and withdrawals.
    Kept past HUB_RETENTION_DAYS: it is the performance history."""
    __tablename__ = "master_deals"
    __table_args__ = (
        UniqueConstraint("manager_id", "master_login", "deal_id", name="uq_master_deals_identity"),
        Index("ix_master_deals_position", "manager_id", "master_login", "pos_id"),
        Index("ix_master_deals_time", "manager_id", "time"),
    )

    id = Column(BigIntPK, primary_key=True)
    manager_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    master_login = Column(BigInteger, nullable=False)
    deal_id = Column(BigInteger, nullable=False) # DEAL_TICKET
    pos_id = Column(BigInteger, nullable=False) # POSITION_IDENTIFIER; 0 for deposits and withdrawals
    entry = Column(Integer, nullable=False) # DEAL_ENTRY: 0 in, 1 out, 2 in/out (reversal), 3 out by
    type = Column(Integer, nullable=False) # DEAL_TYPE: 0 buy, 1 sell, 2 balance, 3 credit, ...
    symbol = Column(String(64))
    magic = Column(BigInteger)
    volume = Column(Float)
    price = Column(Float)
    profit = Column(Float) # Account currency
    swap = Column(Float)
    commission = Column(Float)
    time = Column(DateTime, nullable=False) # UTC
    received_at = Column(DateTime, default=datetime.datetime.utcnow)

class AccountSnapshot(Base):
    """Balance and equity of a Master (V2ACC) or Slave (ACC) account, the last one of each hour."""
    __tablename__ = "account_snapshots"
    __table_args__ = (
        UniqueConstraint("kind", "owner_id", "login", "hour", name="uq_account_snapshots_hour"),
        Index("ix_account_snapshots_series", "kind", "owner_id", "hour"),
    )

    id = Column(BigIntPK, primary_key=True)
    kind = Column(String(8), nullable=False) # master: owner_id is the manager; slave: owner_id is the license
    owner_id = Column(Integer, nullable=False)
    login = Column(BigInteger, nullable=False)
    hour = Column(DateTime, nullable=False) # UTC, truncated to the hour
    balance = Column(Float)
    equity = Column(Float)
    currency = Column(String(8))
    updated_at = Column(DateTime, default=datetime.datetime.utcnow)
