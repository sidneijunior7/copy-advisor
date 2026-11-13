"""
Apply database migrations. The API container runs main() in a thread at startup (server.py,
MIGRATE_ON_START=1); locally run `python migrate.py` before starting the API.

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
# Supabase's roles for its Data API (PostgREST): whoever has the project's public anon key acts as anon. The Mirror
# never uses that API, so these roles must reach nothing in public
SUPABASE_API_ROLES = ("anon", "authenticated")
ADVISORY_LOCK_ID = 727001  # Arbitrary, just has to be the same for every migrate.py
MAX_DB_RETRIES = 5


def connect(retries: int = MAX_DB_RETRIES):
    for attempt in range(1, retries + 1):
        try:
            return database.engine.connect()
        except Exception as e:
            if attempt == retries:
                raise
            logger.warning(f"DB connection attempt {attempt}/{retries} failed: {e}. Retrying in {attempt * 2}s...")
            time.sleep(attempt * 2)


def harden(conn):
    """On Supabase: row level security on every table of public, and no privilege there for its API roles, on
    every start. A migration's new table is covered on the next deploy, and turning the Data API back on by
    mistake exposes nothing. The Mirror connects as the tables' owner, which RLS does not restrict."""
    roles = [r for (r,) in conn.execute(text("SELECT rolname FROM pg_roles WHERE rolname = ANY(:names)"),
                                        {"names": list(SUPABASE_API_ROLES)})]
    if not roles:
        return  # Not Supabase (a local or test Postgres): nothing exposes the tables
    open_tables = [t for (t,) in conn.execute(text(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity"))]
    for table in open_tables:
        conn.execute(text(f'ALTER TABLE public."{table}" ENABLE ROW LEVEL SECURITY'))
    who = ", ".join(roles)
    for kind in ("TABLES", "SEQUENCES", "FUNCTIONS"):
        conn.execute(text(f"REVOKE ALL ON ALL {kind} IN SCHEMA public FROM {who}"))
        conn.execute(text(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON {kind} FROM {who}"))
    if open_tables:
        logger.info(f"Row level security turned on for {len(open_tables)} table(s): {', '.join(sorted(open_tables))}")


def main(retries: int = MAX_DB_RETRIES):
    cfg = Config(os.path.join(os.path.dirname(os.path.abspath(__file__)), "alembic.ini"))
    cfg.attributes["configure_logger"] = False

    conn = connect(retries)
    try:
        if database.IS_POSTGRES:
            # Two API containers starting together must not migrate at the same time.
            # Transaction-scoped: the commit or rollback below releases it, and the whole migration
            # stays on one server connection even behind a transaction-mode pooler (Supabase 6543)
            conn.execute(text(f"SELECT pg_advisory_xact_lock({ADVISORY_LOCK_ID})"))

        tables = inspect(conn).get_table_names()
        cfg.attributes["connection"] = conn
        if "users" in tables and "alembic_version" not in tables:
            logger.info(f"Existing schema without alembic_version: stamping {BASELINE}")
            command.stamp(cfg, BASELINE)
        command.upgrade(cfg, "head")
        if database.IS_POSTGRES:
            harden(conn)
        conn.commit()
        logger.info("Database is at head")
    except Exception:
        conn.rollback()  # Postgres DDL is transactional: a failed migration leaves nothing half-applied
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        logger.error(f"Migration failed: {e}")
        sys.exit(1)
