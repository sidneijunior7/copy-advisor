"""Results reaching the hub: Slave settings out (CFG), profit, the Master's deals and balance in (hub.py, hub_ws.py)."""
import dataclasses
import datetime

import database
import hub_ws
import models
from hub import Writer
from test_hub_ws import LICENSE, Env, make_directory, recv, run_async
from test_writer import seed


def test_cfg_line():
    assert hub_ws.cfg_line("") == "CFG"
    assert hub_ws.cfg_line("not json") == "CFG"
    line = hub_ws.cfg_line('{"lots_factor": 4, "lots_divide": true, "sizing_mode": "equity", "reference_capital": 2500.0,'
                           ' "sltp_mode": "price", "copy_sltp": false, "late_max_deviation_points": 80,'
                           ' "slippage_points": 30, "symbol_map": "WIN$=WINZ26|x", "suffix_map": ".a=m"}')
    assert line == ("CFG|factor=0.25|sizing=2|capital=2500|sltp=1|copysltp=0|late=80|slip=30|symmap=WIN$=WINZ26/x"
                    "|sufmap=.a=m")
    assert hub_ws.cfg_line('{"sizing_mode": "nonsense", "lots_factor": -1}') == "CFG"  # Left to the EA's inputs


@run_async
async def test_slave_gets_its_settings_before_the_snapshot_and_when_they_change():
    async with Env() as env:
        env.dir = make_directory(dataclasses.replace(LICENSE, settings='{"lots_factor": 0.5}'))
        ws = await env.slave()
        assert (await recv(ws)).startswith("WELCOME|")
        assert await recv(ws) == "CFG|factor=0.5"
        assert (await recv(ws)).startswith("SNAP|")
        env.dir = make_directory(dataclasses.replace(LICENSE, settings='{"lots_factor": 0.5, "sltp_mode": "price"}'))
        env.edge.tick()
        assert await recv(ws) == "CFG|factor=0.5|sltp=1"
        env.edge.tick()  # Same settings: nothing new
        env.v2("OPEN", 1)
        assert (await recv(ws)).startswith("POS|")
        await ws.close()


@run_async
async def test_slave_reports_profit_and_its_account():
    async with Env() as env:
        ws = await env.slave()
        await recv(ws), await recv(ws), await recv(ws)  # WELCOME, CFG, SNAP
        await ws.send("EXEC|31337|-|900_1|CLOSE|777|0.5|1.2|10009|0|-12.75")
        await ws.send("EXEC|31337|-|900_2|CLOSE|778|0.5|1.2|10009|0|-")
        await ws.send("EXEC|31337|-|900_3|OPEN|779|0.5|1.2|10009|0")  # A Slave before 4.04
        await ws.send("ACC|10250.5|10100.25|USD")
        await ws.send("ACC|lots|of|junk")
        await ws.close()
        for _ in range(50):
            if len(env.jobs) >= 4:
                break
            await recv_quietly()
        executions = [j for j in env.jobs if j["kind"] == "execution"]
        assert [j["profit"] for j in executions] == [-12.75, None, None]
        [acc] = [j for j in env.jobs if j["kind"] == "account_snapshot"]
        assert (acc["account"], acc["owner_id"], acc["login"], acc["balance"], acc["equity"], acc["currency"]) == \
            ("slave", LICENSE.id, 31337, 10250.5, 10100.25, "USD")
        assert acc["hour"].minute == 0 and acc["hour"].second == 0


async def recv_quietly():
    import asyncio
    await asyncio.sleep(0.02)


def test_master_deals_and_balance(monkeypatch):
    jobs = []
    from hub import HubCore
    core = HubCore(directory=make_directory, publish=lambda *a: None, web=lambda e: None, persist=jobs.append, epoch=1)
    manager = make_directory().managers_by_id[1]
    core.handle_master(manager, "V2DEAL|900|123|456789|1|1|0.5|1.10250|37.5|-1.2|-3|1792330000123|555|EUR|USD weird")
    core.handle_master(manager, "V2DEAL|900|123|456789|1|1")  # Malformed: dropped
    core.handle_master(manager, "V2ACC|900|10000|10025.5|USD")
    deal, acc = jobs
    assert deal["kind"] == "master_deal" and deal["deal_id"] == 456789 and deal["pos_id"] == 123
    assert (deal["entry"], deal["type"], deal["profit"], deal["swap"], deal["commission"]) == (1, 1, 37.5, -1.2, -3.0)
    assert deal["time"] == datetime.datetime(2026, 10, 18, 13, 26, 40, 123000) and deal["symbol"] == "EUR|USD weird"
    assert (acc["account"], acc["owner_id"], acc["login"], acc["equity"]) == ("master", 1, 900, 10025.5)


def test_writer_keeps_one_deal_and_the_last_balance_of_each_hour():
    manager_id, _, _ = seed()
    w = Writer()
    hour = datetime.datetime(2026, 10, 18, 14, 0)

    def deal(deal_id, profit=10.0):
        return {"kind": "master_deal", "manager_id": manager_id, "master_login": 900, "deal_id": deal_id, "pos_id": 5,
                "entry": 1, "type": 1, "volume": 1.0, "price": 1.1, "profit": profit, "swap": 0.0, "commission": -1.0,
                "time": hour, "magic": 555, "symbol": "EURUSD", "at": datetime.datetime.utcnow()}

    def snapshot(equity):
        return {"kind": "account_snapshot", "account": "master", "owner_id": manager_id, "login": 900, "hour": hour,
                "balance": 1000.0, "equity": equity, "currency": "USD", "at": datetime.datetime.utcnow()}

    w.write([deal(1), deal(1), snapshot(990.0)])  # Resent inside one batch
    w.write([deal(1, profit=99.0), deal(2), snapshot(1010.0)])  # And in a later one
    db = database.SessionLocal()
    try:
        deals = db.query(models.MasterDeal).filter_by(manager_id=manager_id).order_by(models.MasterDeal.deal_id).all()
        assert [(d.deal_id, d.profit) for d in deals] == [(1, 10.0), (2, 10.0)]
        [snap] = db.query(models.AccountSnapshot).filter_by(kind="master", owner_id=manager_id).all()
        assert snap.equity == 1010.0 and snap.hour == hour
    finally:
        db.close()
