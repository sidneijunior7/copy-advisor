
import os
import sys
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")

print(f"DATABASE_URL found in ENV: {'Yes' if DATABASE_URL else 'No'}")
if DATABASE_URL:
    # Mask credentials for logging
    masked_url = DATABASE_URL.split("@")[-1] if "@" in DATABASE_URL else DATABASE_URL
    print(f"Target: ...@{masked_url}")

if not DATABASE_URL:
    DATABASE_URL = "sqlite:///./copytrade_v2.db"
    print("Falling back to SQLite")

try:
    engine = create_engine(DATABASE_URL)
    with engine.connect() as conn:
        print("Successfully connected to the database!")
        
        # Check users table
        result = conn.execute(text("SELECT email, role, status FROM users"))
        users = result.all()
        
        print(f"\nFound {len(users)} users:")
        for user in users:
            print(f"- {user.email} ({user.role}) [{user.status}]")
            
except Exception as e:
    print(f"\nERROR: Could not connect or query database: {e}")
