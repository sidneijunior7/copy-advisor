"""
migrate.py against real Postgres, starting from each possible origin of the production database.
Uses TEST_POSTGRES_URL (CI service container) or, locally, the pgserver package if installed.
"""
import hashlib
import os
import subprocess
import sys
import tempfile

import pytest
from sqlalchemy import create_engine, inspect, text

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEGACY_SQL = os.path.join(ROOT, "tests", "fixtures", "supabase_schema_legacy.sql")


@pytest.fixture(scope="module")
def pg_url():
    url = os.getenv("TEST_POSTGRES_URL")
    if url:
        yield url
        return
    pgserver = pytest.importorskip("pgserver", reason="set TEST_POSTGRES_URL or pip install pgserver")
    server = pgserver.get_server(tempfile.mkdtemp(prefix="tdm_pg_"), cleanup_mode="stop")
    yield server.get_uri()
    server.cleanup()


def run(pg_url, *args, check=True):
    env = dict(os.environ, DATABASE_URL=pg_url)
    result = subprocess.run([sys.executable, *args], cwd=ROOT, env=env, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise AssertionError(f"{args} failed:\n{result.stdout}\n{result.stderr}")
    return result


def reset(engine):
    with engine.begin() as c:
        c.execute(text("DROP SCHEMA public CASCADE"))
        c.execute(text("CREATE SCHEMA public"))


def seed(engine, duplicate=False):
    with engine.begin() as c:
        c.execute(text("INSERT INTO users (email, password_hash, role, status, master_key) "
                       "VALUES ('m@x.com', 'h', 'MANAGER', 'active', 'k1')"))
        c.execute(text("INSERT INTO strategies (user_id, name, magic_number, is_active) VALUES (1, 'S', 42, true)"))
        if duplicate:
            c.execute(text("INSERT INTO strategies (user_id, name, magic_number, is_active) VALUES (1, 'S2', 42, true)"))
        c.execute(text("INSERT INTO licenses (client_mt5_login, max_lots, is_active) VALUES (123, 1.0, true)"))


def prepare(engine, pg_url, origin):
    reset(engine)
    if origin == "supabase_sql":
        with engine.begin() as c:
            c.exec_driver_sql(open(LEGACY_SQL, encoding="utf-8").read())
        seed(engine)
    elif origin == "create_all":
        # Same schema Base.metadata.create_all produced before Alembic, without alembic_version
        run(pg_url, "-m", "alembic", "upgrade", "0001_baseline")
        with engine.begin() as c:
            c.execute(text("DROP TABLE alembic_version"))
        seed(engine)


@pytest.mark.parametrize("origin", ["supabase_sql", "create_all", "empty"])
def test_migrate_from_every_origin(pg_url, origin):
    engine = create_engine(pg_url)
    prepare(engine, pg_url, origin)

    run(pg_url, "migrate.py")
    run(pg_url, "migrate.py")  # Idempotent: the API runs it on every start

    insp = inspect(engine)
    # A license and a subscription may wait for the client's MT5 account, whatever schema they came from
    for table in ("licenses", "subscriptions"):
        column = "client_mt5_login" if table == "licenses" else "mt5_login"
        assert next(c for c in insp.get_columns(table) if c["name"] == column)["nullable"], (origin, table)
    with engine.connect() as c:
        assert c.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0022_hosting_billing"
        if origin != "empty":
            assert c.execute(text("SELECT magic_number FROM strategies")).scalar() == 42
            # The plain-text master key was adopted as a hashed master key, exactly once, and revoked at the
            # ZMQ cut: it had crossed the open port in clear
            adopted = c.execute(text("SELECT user_id, key_hash, key_prefix, revoked_at IS NOT NULL FROM master_keys")).fetchall()
            assert [tuple(r) for r in adopted] == [(1, hashlib.sha256(b"k1").hexdigest(), "k1", True)]
    assert {"master_positions", "signals", "executions", "master_accounts", "master_keys"} <= set(insp.get_table_names())
    assert "master_key" not in {col["name"] for col in insp.get_columns("users")}
    assert "public_key" not in {col["name"] for col in insp.get_columns("portfolios")}
    columns = {col["name"]: col for col in insp.get_columns("strategies")}
    assert str(columns["magic_number"]["type"]) == "BIGINT"
    login_type = {col["name"]: col for col in insp.get_columns("licenses")}["client_mt5_login"]["type"]
    assert str(login_type) == "BIGINT"
    uniques = [u for u in insp.get_unique_constraints("strategies") if set(u["column_names"]) == {"user_id", "magic_number"}]
    assert len(uniques) == 1  # Reused when supabase_schema.sql had created it, never duplicated

    if origin != "supabase_sql":
        # supabase_schema.sql declares NOT NULLs the ORM doesn't: that drift is expected there
        run(pg_url, "-m", "alembic", "check")


def test_migrate_refuses_duplicate_magic_numbers(pg_url):
    engine = create_engine(pg_url)
    reset(engine)
    run(pg_url, "-m", "alembic", "upgrade", "0001_baseline")
    with engine.begin() as c:
        c.execute(text("DROP TABLE alembic_version"))
    seed(engine, duplicate=True)

    result = run(pg_url, "migrate.py", check=False)
    assert result.returncode == 1
    assert "duplicadas" in result.stdout + result.stderr
    # Transactional DDL: the stamp and every change rolled back together
    tables = inspect(engine).get_table_names()
    assert "alembic_version" not in tables and "master_positions" not in tables


def test_concurrent_migrations_are_serialized(pg_url):
    engine = create_engine(pg_url)
    reset(engine)
    env = dict(os.environ, DATABASE_URL=pg_url)
    procs = [subprocess.Popen([sys.executable, "migrate.py"], cwd=ROOT, env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
             for _ in range(2)]
    outputs = [p.communicate(timeout=120)[0] for p in procs]
    # Without the lock both would CREATE TABLE at once and one of them would fail
    assert [p.returncode for p in procs] == [0, 0], outputs
    with engine.connect() as c:
        assert c.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0022_hosting_billing"
        # Transaction-scoped lock: nothing stays held once migrate.py is done
        assert c.execute(text("SELECT COUNT(*) FROM pg_locks WHERE locktype = 'advisory'")).scalar() == 0


def test_access_keys_strip_master_keys_from_signal_history(pg_url):
    engine = create_engine(pg_url)
    reset(engine)
    run(pg_url, "-m", "alembic", "upgrade", "0005_master_accounts")
    seed(engine)
    with engine.begin() as c:
        c.execute(text("INSERT INTO master_positions (manager_id, strategy_id, master_login, pos_id, symbol, type, volume) "
                       "VALUES (1, 1, 900, 55, 'EURUSD', 0, 1.0)"))
        c.execute(text("INSERT INTO signals (master_position_id, reason, raw) VALUES "
                       "(1, 'OPEN', 'k1|V2|900|OPEN|55|0|EURUSD|1|1.1|0|0|42'), (1, 'SYNC', NULL)"))

    run(pg_url, "migrate.py")

    with engine.connect() as c:
        raws = [r[0] for r in c.execute(text("SELECT raw FROM signals ORDER BY id"))]
        assert raws == ["V2|900|OPEN|55|0|EURUSD|1|1.1|0|0|42", None]
