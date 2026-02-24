
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
import os
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

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, 
    # check_same_thread is only needed for SQLite
    connect_args={"check_same_thread": False} if SQLALCHEMY_DATABASE_URL.startswith("sqlite") else {}
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
