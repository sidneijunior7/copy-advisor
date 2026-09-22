"""
Apply database migrations. Runs before the API starts (see Dockerfile CMD).

Databases created before Alembic (by Base.metadata.create_all or supabase_schema.sql)
have tables but no alembic_version: they are stamped at the baseline and then upgraded.
"""
import logging
import os
import sys
import time

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text

import database

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("migrate")

BASELINE = "0001_baseline"
ADVISORY_LOCK_ID = 727001  # Arbitrary, just has to be the same for every migrate.py
MAX_DB_RETRIES = 5


def connect():
    for attempt in range(1, MAX_DB_RETRIES + 1):
        try:
            return database.engine.connect()
        except Exception as e:
            if attempt == MAX_DB_RETRIES:
                raise
            logger.warning(f"DB connection attempt {attempt}/{MAX_DB_RETRIES} failed: {e}. Retrying in {attempt * 2}s...")
            time.sleep(attempt * 2)


def main():
    cfg = Config(os.path.join(os.path.dirname(os.path.abspath(__file__)), "alembic.ini"))
    cfg.attributes["configure_logger"] = False

    conn = connect()
    try:
        if database.IS_POSTGRES:
            # Two API containers starting together must not migrate at the same time
            conn.execute(text(f"SELECT pg_advisory_lock({ADVISORY_LOCK_ID})"))
            conn.commit()

        tables = inspect(conn).get_table_names()
        cfg.attributes["connection"] = conn
        if "users" in tables and "alembic_version" not in tables:
            logger.info(f"Existing schema without alembic_version: stamping {BASELINE}")
            command.stamp(cfg, BASELINE)
        command.upgrade(cfg, "head")
        conn.commit()
        logger.info("Database is at head")
    except Exception:
        conn.rollback()  # Postgres DDL is transactional: a failed migration leaves nothing half-applied
        raise
    finally:
        if database.IS_POSTGRES:
            conn.execute(text(f"SELECT pg_advisory_unlock({ADVISORY_LOCK_ID})"))
            conn.commit()
        conn.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        logger.error(f"Migration failed: {e}")
        sys.exit(1)
