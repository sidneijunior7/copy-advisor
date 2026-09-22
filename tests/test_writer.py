import datetime

import database
import models
from hub import Writer, load_directory


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


def position_job(manager_id, strategy_id, volume, reason, closed=False):
    return {
        "kind": "position", "manager_id": manager_id, "strategy_id": strategy_id, "master_login": 5_000_000_000,
        "pos_id": 3_000_000_000, "type": 0, "symbol": "WINV26", "volume": volume, "price_open": 130000.0,
        "sl": 0.0, "tp": 0.0, "magic": 2**40, "reason": reason, "raw": None, "closed": closed,
        "at": datetime.datetime.utcnow(),
    }


def test_writer_upserts_position_and_records_signals():
    manager_id, strategy_id, portfolio_id = seed()
    w = Writer()
    w._write(position_job(manager_id, strategy_id, 2.0, "OPEN"))
    w._write(position_job(manager_id, strategy_id, 1.0, "PARTIAL"))
    w._write(position_job(manager_id, strategy_id, 0.0, "CLOSE", closed=True))
    w._write(position_job(manager_id, strategy_id, 5.0, "ADD"))  # After close: ignored

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


def test_writer_records_execution_and_directory_loads():
    manager_id, strategy_id, portfolio_id = seed()
    w = Writer()
    w._write({"kind": "execution", "uid": "5000000000_1", "portfolio_id": portfolio_id, "mt5_login": 4_000_000_000,
              "action": "OPEN", "position_id": 1, "volume": 1.0, "price": 1.1, "retcode": 10009, "seq": 1,
              "at": datetime.datetime.utcnow()})
    db = database.SessionLocal()
    try:
        assert db.query(models.Execution).filter_by(portfolio_id=portfolio_id).count() == 1
        directory = load_directory(db)
        assert directory.strategies_by_magic[(manager_id, 2**40)].id == strategy_id
        assert directory.portfolios_by_strategy[strategy_id] == (portfolio_id,)
        assert portfolio_id in directory.portfolio_ids
    finally:
        db.close()
