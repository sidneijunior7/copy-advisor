import datetime

import pytest
from sqlalchemy import event
from sqlalchemy.exc import OperationalError, ProgrammingError

import database
import hub
import models
from hub import Retention, Writer, load_directory


def seed():
    db = database.SessionLocal()
    try:
        manager = models.User(email=f"m{datetime.datetime.utcnow().timestamp()}@x.com", password_hash="x", role="MANAGER")
        db.add(manager)
        db.flush()
        strategy = models.Strategy(user_id=manager.id, name="S", magic_number=2**40)  # 64-bit magic
        portfolio = models.Portfolio(user_id=manager.id, name="P")
        portfolio.strategies.append(strategy)
        db.add_all([strategy, portfolio])
        db.commit()
        return manager.id, strategy.id, portfolio.id
    finally:
        db.close()


def position_job(manager_id, strategy_id, volume, reason, closed=False, pos_id=3_000_000_000):
    return {
        "kind": "position", "manager_id": manager_id, "strategy_id": strategy_id, "master_login": 5_000_000_000,
        "pos_id": pos_id, "type": 0, "symbol": "WINV26", "volume": volume, "price_open": 130000.0,
        "sl": 0.0, "tp": 0.0, "magic": 2**40, "reason": reason, "raw": None, "closed": closed,
        "at": datetime.datetime.utcnow(),
    }


def execution_job(portfolio_id, uid="5000000000_1", login=4_000_000_000, at=None):
    return {"kind": "execution", "uid": uid, "portfolio_id": portfolio_id, "mt5_login": login, "action": "OPEN",
            "position_id": 1, "volume": 1.0, "price": 1.1, "retcode": 10009, "seq": 1, "latency_ms": None,
            "at": at or datetime.datetime.utcnow()}


class FakeTime:
    def __init__(self):
        self.now = 0.0
        self.slept = []

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


def test_writer_upserts_position_and_records_signals():
    manager_id, strategy_id, _ = seed()
    w = Writer()
    for job in (position_job(manager_id, strategy_id, 2.0, "OPEN"), position_job(manager_id, strategy_id, 1.0, "PARTIAL"),
                position_job(manager_id, strategy_id, 0.0, "CLOSE", closed=True),
                position_job(manager_id, strategy_id, 5.0, "ADD")):  # After close: ignored
        w.write([job])

    db = database.SessionLocal()
    try:
        rows = db.query(models.MasterPosition).filter_by(manager_id=manager_id).all()
        assert len(rows) == 1
        row = rows[0]
        assert row.closed_at is not None and row.volume == 1.0 and row.pos_id == 3_000_000_000
        reasons = [s.reason for s in db.query(models.Signal).filter_by(master_position_id=row.id).order_by(models.Signal.id)]
        assert reasons == ["OPEN", "PARTIAL", "CLOSE"]
    finally:
        db.close()


def test_one_batch_holds_a_position_story_and_many_execution_reports():
    """What the hub queues during a busy second goes in one transaction: a position opened and changed inside
    the same batch is one row, and the execution reports go in a single executemany."""
    manager_id, strategy_id, portfolio_id = seed()
    batch = [position_job(manager_id, strategy_id, 2.0, "OPEN", pos_id=11),
             position_job(manager_id, strategy_id, 1.0, "PARTIAL", pos_id=11),
             position_job(manager_id, strategy_id, 3.0, "OPEN", pos_id=12)]
    batch += [execution_job(portfolio_id, uid=f"5000000000_{n}", login=n) for n in range(300)]
    Writer().write(batch)

    db = database.SessionLocal()
    try:
        rows = {r.pos_id: r for r in db.query(models.MasterPosition).filter_by(manager_id=manager_id)}
        assert rows[11].volume == 1.0 and rows[12].volume == 3.0
        reasons = [s.reason for s in db.query(models.Signal).filter_by(master_position_id=rows[11].id).order_by(models.Signal.id)]
        assert reasons == ["OPEN", "PARTIAL"]
        assert db.query(models.Execution).filter_by(portfolio_id=portfolio_id).count() == 300
    finally:
        db.close()


def test_execution_reports_cost_a_few_statements_per_batch():
    """The audit measured ~5 round trips per report, one transaction each: 9 reports/s with 20 ms to the
    database. A batch now costs the same handful of statements however many reports it carries."""
    _, _, portfolio_id = seed()
    statements = []

    def count(conn, cursor, statement, params, context, executemany):
        statements.append(statement)

    event.listen(database.engine, "before_cursor_execute", count)
    try:
        Writer().write([execution_job(portfolio_id, uid=f"rt_{n}", login=n) for n in range(300)])
    finally:
        event.remove(database.engine, "before_cursor_execute", count)
    assert len(statements) <= 3  # SET LOCAL statement_timeout on Postgres, then one INSERT for all 300


def test_a_bad_job_is_dropped_alone():
    manager_id, strategy_id, portfolio_id = seed()
    t = FakeTime()
    w = Writer(sleep=t.sleep, clock=lambda: t.now)
    bad = execution_job(portfolio_id, uid=None)  # executions.uid is NOT NULL
    w.write([execution_job(portfolio_id, uid="good_1"), bad, position_job(manager_id, strategy_id, 1.0, "OPEN", pos_id=21),
             execution_job(portfolio_id, uid="good_2")])
    assert w.failed == 1
    db = database.SessionLocal()
    try:
        assert {e.uid for e in db.query(models.Execution).filter(models.Execution.uid.in_(["good_1", "good_2"]))} == {"good_1", "good_2"}
        assert db.query(models.MasterPosition).filter_by(manager_id=manager_id, pos_id=21).count() == 1
    finally:
        db.close()


def test_unreachable_database_is_waited_for_and_reported(monkeypatch):
    t = FakeTime()
    w = Writer(sleep=t.sleep, clock=lambda: t.now)
    outages = [OperationalError("SELECT 1", {}, Exception("connection refused"))] * 4
    written = []

    def flaky(batch):
        assert w.db_ok is (not t.slept)  # Marked down from the first failure on
        if outages:
            raise outages.pop()
        written.append(batch)

    monkeypatch.setattr(w, "_write_batch", flaky)
    w.write([{"kind": "master_key_used", "id": 1, "at": None}] * 3)
    assert len(written) == 1 and len(written[0]) == 3  # Retried whole, never split or dropped
    assert w.db_ok and w.failed == 0 and t.slept == [0.5, 1.0, 1.5, 2.0]


def test_a_missing_schema_is_waited_for_a_while_then_given_up(monkeypatch):
    t = FakeTime()
    w = Writer(sleep=t.sleep, clock=lambda: t.now)
    missing = ProgrammingError("INSERT INTO master_accounts", {}, Exception("relation does not exist"))
    monkeypatch.setattr(w, "_write_batch", lambda batch: (_ for _ in ()).throw(missing))
    w.write([{"kind": "master_account"}])
    assert w.failed == 1 and hub.SCHEMA_WAIT_SECONDS <= t.now < hub.SCHEMA_WAIT_SECONDS + 10

    # Still failing after the window: the next job no longer waits
    before = t.now
    w.write([{"kind": "master_account"}])
    assert w.failed == 2 and t.now - before < 5


def test_execution_reports_are_dropped_before_position_state(monkeypatch):
    monkeypatch.setattr(hub, "EXEC_QUEUE_SIZE", 2)
    monkeypatch.setattr(hub, "WRITE_QUEUE_SIZE", 3)
    w = Writer()
    for _ in range(5):
        w.submit({"kind": "execution"})
    for _ in range(3):
        w.submit({"kind": "position"})
    assert w.dropped == 3 and w.qsize() == 5
    batch = w._take()
    assert [j["kind"] for j in batch] == ["position"] * 3 + ["execution"] * 2


def test_stop_writes_what_is_queued():
    manager_id, strategy_id, portfolio_id = seed()
    w = Writer()
    w.start()
    for n in range(50):
        w.submit(execution_job(portfolio_id, uid=f"stop_{n}"))
    w.submit(position_job(manager_id, strategy_id, 1.0, "OPEN", pos_id=31))
    w.stop(timeout=10)
    assert not w.is_alive() and w.qsize() == 0
    db = database.SessionLocal()
    try:
        assert db.query(models.Execution).filter(models.Execution.uid.like("stop_%")).count() == 50
        assert db.query(models.MasterPosition).filter_by(manager_id=manager_id, pos_id=31).count() == 1
    finally:
        db.close()


def test_writer_records_execution_and_directory_loads():
    manager_id, strategy_id, portfolio_id = seed()
    Writer().write([execution_job(portfolio_id)])
    db = database.SessionLocal()
    try:
        assert db.query(models.Execution).filter_by(portfolio_id=portfolio_id).count() == 1
        directory = load_directory(db)
        assert directory.strategies_by_magic[(manager_id, 2**40)].id == strategy_id
        assert directory.portfolios_by_strategy[strategy_id] == (portfolio_id,)
        assert portfolio_id in directory.portfolio_ids
    finally:
        db.close()


def test_writer_upserts_master_account():
    manager_id, _, _ = seed()
    w = Writer()
    first = datetime.datetime(2026, 10, 14, 10, 0)
    later = first + datetime.timedelta(minutes=5)
    job = {"kind": "master_account", "manager_id": manager_id, "master_login": 5_000_000_000,
           "trade_mode": "demo", "server": "XPMT5-DEMO", "company": "XP", "at": first}
    w.write([job])
    w.write([dict(job, trade_mode="real", server="XPMT5-PRD", at=later)])
    db = database.SessionLocal()
    try:
        rows = db.query(models.MasterAccount).filter_by(manager_id=manager_id).all()
        assert len(rows) == 1
        row = rows[0]
        assert (row.trade_mode, row.server, row.company) == ("real", "XPMT5-PRD", "XP")
        assert row.first_seen_at == first and row.last_seen_at == later
    finally:
        db.close()


# --- Retention (HUB_RETENTION_DAYS) ---

def test_retention_deletes_only_what_is_older_than_the_cutoff(monkeypatch):
    monkeypatch.setattr(hub, "RETENTION_CHUNK", 7)  # Several chunks
    manager_id, strategy_id, portfolio_id = seed()
    cutoff = datetime.datetime(2026, 7, 1)
    old, recent = cutoff - datetime.timedelta(days=1), cutoff + datetime.timedelta(days=1)
    jobs = [position_job(manager_id, strategy_id, 1.0, "OPEN", pos_id=41)]
    jobs += [dict(position_job(manager_id, strategy_id, 1.0 + n, "ADD", pos_id=41), at=old) for n in range(1, 16)]
    jobs += [dict(position_job(manager_id, strategy_id, 99.0, "ADD", pos_id=41), at=recent)]
    jobs += [dict(execution_job(portfolio_id, uid=f"old_{n}", at=old), retcode=10019) for n in range(20)]  # Refusals
    jobs += [dict(execution_job(portfolio_id, uid=f"old_mod_{n}", at=old), action="MODIFY") for n in range(3)]
    jobs += [execution_job(portfolio_id, uid=f"old_copy_{n}", at=old) for n in range(3)]  # A copy's result: kept
    jobs += [execution_job(portfolio_id, uid=f"new_{n}", at=recent) for n in range(3)]
    Writer().write(jobs)

    deleted = Retention.purge(cutoff, pause=0)

    db = database.SessionLocal()
    try:
        assert deleted["signals"] >= 15 and deleted["executions"] >= 20  # Older rows of other tests go too
        position = db.query(models.MasterPosition).filter_by(manager_id=manager_id, pos_id=41).one()
        left = [s.volume for s in db.query(models.Signal).filter_by(master_position_id=position.id)]
        assert 99.0 in left and not any(1.0 < v < 99.0 for v in left)
        left = {e.uid for e in db.query(models.Execution).filter(models.Execution.portfolio_id == portfolio_id)}
        assert left == {f"old_copy_{n}" for n in range(3)} | {f"new_{n}" for n in range(3)}
    finally:
        db.close()


@pytest.mark.parametrize("error,expected", [
    (OperationalError("x", {}, Exception()), True),
    (ProgrammingError("x", {}, Exception()), False),
    (ValueError(), False),
])
def test_only_connection_errors_count_as_the_database_being_down(error, expected):
    assert hub._is_connection_error(error) is expected


def test_writer_records_each_trade_sent_to_a_portfolio_once():
    manager_id, strategy_id, portfolio_id = seed()
    job = {"kind": "portfolio_trade", "portfolio_id": portfolio_id, "manager_id": manager_id,
           "master_login": 5_000_000_000, "pos_id": 77, "strategy_id": strategy_id, "at": datetime.datetime.utcnow()}
    w = Writer()
    w.write([job, dict(job)])  # Twice in one batch
    w.write([dict(job)])  # And again after a hub restart
    db = database.SessionLocal()
    try:
        assert db.query(models.PortfolioTrade).filter_by(portfolio_id=portfolio_id).count() == 1
    finally:
        db.close()
    assert load_directory(database.SessionLocal()).portfolio_logins.get(portfolio_id) is None
