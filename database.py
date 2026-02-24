
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
import os
import socket
from dotenv import load_dotenv

load_dotenv()

# Priority: Get DATABASE_URL from ENV (Supabase/EasyPanel)
SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL")

# Fallback to local SQLite for local development
if not SQLALCHEMY_DATABASE_URL:
    SQLALCHEMY_DATABASE_URL = "sqlite:///./copytrade_v2.db"
# Handle SQLAlchemy 1.4+ requirement for postgresql://
elif SQLALCHEMY_DATABASE_URL.startswith("postgres://"):
    SQLALCHEMY_DATABASE_URL = SQLALCHEMY_DATABASE_URL.replace("postgres://", "postgresql://", 1)

# Log the database type (masking credentials)
if SQLALCHEMY_DATABASE_URL.startswith("postgresql"):
    print("Database: Using PostgreSQL (Supabase)")
else:
    print("Database: Using SQLite (Local)")


def _build_connect_args():
    """Build connect_args, forcing IPv4 for PostgreSQL to avoid IPv6 issues in Docker."""
    if SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
        return {"check_same_thread": False}
    
    connect_args = {}
    try:
        # Extract hostname from DATABASE_URL to resolve to IPv4
        from urllib.parse import urlparse
        parsed = urlparse(SQLALCHEMY_DATABASE_URL)
        if parsed.hostname:
            # Force IPv4 resolution (AF_INET) — avoids "Network is unreachable" on IPv6-only DNS
            ipv4 = socket.getaddrinfo(parsed.hostname, None, socket.AF_INET)[0][4][0]
            connect_args["hostaddr"] = ipv4
            print(f"Database: Resolved {parsed.hostname} -> {ipv4} (IPv4)")
    except Exception as e:
        print(f"Database: IPv4 resolution failed ({e}), using default DNS")
    
    return connect_args


engine = create_engine(
    SQLALCHEMY_DATABASE_URL, 
    connect_args=_build_connect_args(),
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
