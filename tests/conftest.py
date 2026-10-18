import os
import sys
import tempfile

# database.py reads DATABASE_URL at import time: point it at a throwaway database first.
# TEST_DATABASE_URL runs the whole suite against an empty Postgres database instead of SQLite.
_tmpdir = tempfile.mkdtemp(prefix="tdm_tests_")
os.environ["DATABASE_URL"] = os.getenv("TEST_DATABASE_URL") or \
    "sqlite:///" + os.path.join(_tmpdir, "test.db").replace("\\", "/")
os.environ.setdefault("SECRET_KEY", "test-secret-key-with-at-least-32-characters")
# No bridge thread, and nothing ever reaches the real Dash
os.environ["DASH_BRIDGE_SECONDS"] = "0"
os.environ["DASH_INGEST_URL"] = "http://127.0.0.1:9/api/ingest"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

import migrate  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def schema():
    migrate.main()
