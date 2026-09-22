import os
import sys
import tempfile

# database.py reads DATABASE_URL at import time: point it at a throwaway database first.
# TEST_DATABASE_URL runs the whole suite against an empty Postgres database instead of SQLite.
_tmpdir = tempfile.mkdtemp(prefix="tdm_tests_")
os.environ["DATABASE_URL"] = os.getenv("TEST_DATABASE_URL") or \
    "sqlite:///" + os.path.join(_tmpdir, "test.db").replace("\\", "/")
os.environ.setdefault("SECRET_KEY", "test-secret")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

import migrate  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def schema():
    migrate.main()
