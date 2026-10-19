"""Performance of a portfolio (Master deals) and of a client's copies (Slave profit) (performance.py)."""
import datetime
import os
import uuid

import pytest

os.environ["HUB_HEALTH_URL"] = "http://127.0.0.1:9/health"  # Nothing listens here: hub unreachable
os.environ["HUB_EVENTS_URL"] = "tcp://127.0.0.1:9"

from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
import performance  # noqa: E402
import server  # noqa: E402
from test_clients import claimed_license, fresh_limits  # noqa: E402,F401
from test_management import make_manager  # noqa: E402

NOW = datetime.datetime.utcnow()


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as c:
        yield c


def ago(days=0, hours=0):
    return NOW - datetime.timedelta(days=days, hours=hours)


def test_stats():
    s = performance.stats([(ago(3), 100.0), (ago(2), -40.0), (ago(1), -30.0), (ago(0, 1), 50.0)],
                          start_balance=1000.0, currency="USD")
    assert (s["trades"], s["wins"], s["losses"], s["win_rate"]) == (4, 2, 2, 50.0)
    assert (s["net"], s["gross_profit"], s["gross_loss"], s["profit_factor"]) == (80.0, 150.0, 70.0, 2.14)
    assert (s["max_drawdown"], s["max_drawdown_pct"], s["return_pct"]) == (70.0, 7.0, 8.0)
    assert [p["v"] for p in s["curve"]] == [100.0, 60.0, 30.0, 80.0]
    assert sum(m["net"] for m in s["months"]) == 80.0
    empty = performance.stats([])
    assert empty["trades"] == 0 and empty["win_rate"] is None and empty["return_pct"] is None


def seed_portfolio(client):
    """A claimed license on a portfolio whose strategy closed two positions on the Master, one of them long ago."""
    manager_id, mgr, portfolio_id, lic, cli, _ = claimed_license(client)
    db = database.SessionLocal()
    try:
        strategy = models.Strategy(user_id=manager_id, name="Trend", magic_number=uuid.uuid4().int % 10**9)
        db.add(strategy)
        db.flush()
        portfolio = db.get(models.Portfolio, portfolio_id)
        portfolio.strategies.append(strategy)
        db.flush()
        for pos_id, closed_at in ((1, ago(2)), (2, ago(1)), (3, None), (4, ago(400))):
            db.add(models.MasterPosition(manager_id=manager_id, strategy_id=strategy.id, master_login=900, pos_id=pos_id,
                                         symbol="EURUSD", type=0, volume=1, price_open=1.1, closed_at=closed_at))
            db.add(models.PortfolioTrade(portfolio_id=portfolio_id, manager_id=manager_id, master_login=900, pos_id=pos_id,
                                         strategy_id=strategy.id))

        def deal(deal_id, pos_id, entry, profit, commission, at):
            db.add(models.MasterDeal(manager_id=manager_id, master_login=900, deal_id=deal_id, pos_id=pos_id, entry=entry,
                                     type=0, volume=1, price=1.1, profit=profit, swap=0, commission=commission, time=at))
        deal(10, 1, 0, 0, -2, ago(3))
        deal(11, 1, 1, 50, -2, ago(2))
        deal(20, 2, 0, 0, -2, ago(2))
        deal(21, 2, 1, -20, -2, ago(1))
        deal(30, 3, 0, 0, -2, ago(1))  # Still open
        deal(40, 4, 1, 999, 0, ago(400))  # Outside the period
        db.add(models.AccountSnapshot(kind="master", owner_id=manager_id, login=900,
                                      hour=ago(5).replace(minute=0, second=0, microsecond=0),
                                      balance=2000, equity=2000, currency="USD"))
        db.commit()
    finally:
        db.close()
    return manager_id, mgr, portfolio_id, lic, cli


def test_portfolio_performance_from_master_deals(client):
    _, mgr, portfolio_id, _, _ = seed_portfolio(client)
    r = client.get(f"/portfolios/{portfolio_id}/performance", headers=mgr, params={"days": 30})
    assert r.status_code == 200
    p = r.json()
    assert (p["trades"], p["net"], p["currency"], p["start_balance"]) == (2, 22.0, "USD", 2000)  # 46 - 24
    assert p["return_pct"] == 1.1 and p["strategies"][0]["name"] == "Trend"
    _, other = make_manager()
    assert client.get(f"/portfolios/{portfolio_id}/performance", headers=other).status_code == 404


def test_client_sees_its_result_and_the_portfolio(client):
    _, _, portfolio_id, lic, cli = seed_portfolio(client)
    db = database.SessionLocal()
    try:
        def ex(uid, action, profit, at):
            db.add(models.Execution(uid=uid, portfolio_id=portfolio_id, mt5_login=lic["client_mt5_login"], action=action,
                                    volume=0.1, price=1.1, retcode=10009, profit=profit, created_at=at))
        ex("900_1", "OPEN", -0.2, ago(3))
        ex("900_1", "CLOSE", 5.0, ago(2))
        ex("900_2", "OPEN", -0.2, ago(2))
        ex("900_2", "CLOSE_EXT", -2.0, ago(1))  # Its SL, hit only on the client
        for h in (30, 20, 10):
            db.add(models.AccountSnapshot(kind="slave", owner_id=lic["id"], login=lic["client_mt5_login"],
                                          hour=ago(0, h).replace(minute=0, second=0, microsecond=0),
                                          balance=500 + h, equity=495 + h, currency="BRL"))
        db.commit()
    finally:
        db.close()
    r = client.get(f"/me/licenses/{lic['id']}/performance", headers=cli, params={"days": 30})
    assert r.status_code == 200
    mine, portfolio = r.json()["copies"], r.json()["portfolio"]
    assert (mine["trades"], mine["net"], mine["wins"], mine["currency"]) == (2, 2.6, 1, "BRL")
    assert [e["balance"] for e in mine["equity"]] == [530, 520, 510]
    assert portfolio["trades"] == 2
    copies = {c["uid"]: c for c in client.get(f"/me/licenses/{lic['id']}/copies", headers=cli).json()}
    assert copies["900_2"]["status"] == "closed" and copies["900_2"]["profit"] == -2.2


def seed_track(manager_id, portfolio_id, magic, login, company, currency, balance, trades, sent=True, first_seen=None):
    """A Master account and closed positions of the strategy with this magic: (pos_id, profit, days ago it closed).
    sent: the hub sent them to the portfolio's clients."""
    db = database.SessionLocal()
    try:
        strategy = db.query(models.Strategy).filter_by(user_id=manager_id, magic_number=magic).one()
        db.add(models.MasterAccount(manager_id=manager_id, master_login=login, trade_mode="demo", company=company,
                                    first_seen_at=first_seen or ago(60)))
        db.add(models.AccountSnapshot(kind="master", owner_id=manager_id, login=login, balance=balance, equity=balance,
                                      currency=currency, hour=ago(0, 1).replace(minute=0, second=0, microsecond=0)))
        for pos_id, profit, days in trades:
            if sent:
                db.add(models.MasterPosition(manager_id=manager_id, strategy_id=strategy.id, master_login=login,
                                             pos_id=pos_id, symbol="WIN", type=0, volume=1, price_open=1,
                                             closed_at=ago(days)))
                db.add(models.PortfolioTrade(portfolio_id=portfolio_id, manager_id=manager_id, master_login=login,
                                             pos_id=pos_id, strategy_id=strategy.id, sent_at=ago(days + 1)))
            for n, (entry, pnl, at) in enumerate(((0, 0, ago(days + 1)), (1, profit, ago(days)))):
                db.add(models.MasterDeal(manager_id=manager_id, master_login=login, deal_id=pos_id * 10 + n,
                                         pos_id=pos_id, entry=entry, type=entry, volume=1, price=1, profit=pnl, swap=0,
                                         commission=0, time=at, magic=magic))
        db.commit()
    finally:
        db.close()


def portfolio_with_strategy(client, name):
    manager_id, mgr, portfolio_id, _, _, _ = claimed_license(client)
    magic = uuid.uuid4().int % 10**9
    db = database.SessionLocal()
    try:
        strategy = models.Strategy(user_id=manager_id, name=name, magic_number=magic)
        db.add(strategy)
        db.flush()
        portfolio = db.get(models.Portfolio, portfolio_id)
        portfolio.strategies.append(strategy)
        db.commit()
        strategy_id = strategy.id
    finally:
        db.close()
    return manager_id, mgr, portfolio_id, magic, strategy_id


def test_the_track_record_is_what_the_clients_got(client):
    """Trades the hub never sent (another account running the same magic) stay out; trades it sent stay in after
    the strategy leaves the portfolio; the percentages are over the Dash's capital, not the demo account's balance."""
    manager_id, mgr, portfolio_id, magic, strategy_id = portfolio_with_strategy(client, "WIN")
    login = uuid.uuid4().int % 10**8
    seed_track(manager_id, portfolio_id, magic, login, "XP Investimentos", "BRL", 500_000, [(1, 300, 5), (2, -100, 4)])
    seed_track(manager_id, portfolio_id, magic, login + 1, "RoboForex", "USD", 1000, [(3, 7, 3)], sent=False,
               first_seen=ago(10))
    url = f"/portfolios/{portfolio_id}/performance"
    p = client.get(url, headers=mgr).json()
    assert (p["trades"], p["net"], p["currency"], p["capital_source"]) == (2, 200.0, "BRL", "account")
    assert p["start_balance"] == 499_800  # The balance before the first trade, from today's and the deals since
    assert p["before_mirror"]["trades"] == 0  # Opened after its account connected: never sent, never counted

    db = database.SessionLocal()
    try:
        db.add(models.DashLink(portfolio_id=portfolio_id, token_encrypted="x", deal_cursor=0, send_since=ago(30),
                               backtest='{"initial_balance": 10000, "currency": "BRL", "pnl": [1]}'))
        portfolio = db.get(models.Portfolio, portfolio_id)
        portfolio.strategies.clear()
        db.commit()
    finally:
        db.close()
    p = client.get(url, headers=mgr).json()
    assert (p["trades"], p["start_balance"], p["return_pct"], p["capital_source"]) == (2, 10_000, 2.0, "dash")
    assert p["strategies"] == [{"id": strategy_id, "name": "WIN", "trades": 2, "net": 200.0}]
    assert (p["lots"], p["per_lot"]) == (2, 100.0)  # 200 over the 2 lots closed

    db = database.SessionLocal()
    try:
        db.query(models.DashLink).filter_by(portfolio_id=portfolio_id).one().backtest = (
            '{"initial_balance": 113000, "capital": 2500, "currency": "BRL", "pnl": [1]}')
        db.commit()
    finally:
        db.close()
    p = client.get(url, headers=mgr).json()  # The Monte Carlo's DD + 3 sigma comes first
    assert (p["start_balance"], p["return_pct"], p["capital_source"]) == (2500, 8.0, "dash-mc")


def test_trades_from_before_the_mirror_are_apart(client):
    """The history a Master 4.01 sends when it first connects is shown apart from the track record."""
    manager_id, mgr, portfolio_id, magic, _ = portfolio_with_strategy(client, "Old")
    login = uuid.uuid4().int % 10**8
    seed_track(manager_id, portfolio_id, magic, login, "XP Investimentos", "BRL", 1000, [(1, 100, 50), (2, -40, 45)],
               sent=False, first_seen=ago(20))
    p = client.get(f"/portfolios/{portfolio_id}/performance", headers=mgr, params={"days": 90}).json()
    assert p["trades"] == 0
    assert (p["before_mirror"]["trades"], p["before_mirror"]["net"]) == (2, 60.0)


def test_the_origin_account(client):
    manager_id, mgr, portfolio_id, magic, _ = portfolio_with_strategy(client, "Origin")
    login = uuid.uuid4().int % 10**8
    seed_track(manager_id, portfolio_id, magic, login, "XP Investimentos", "BRL", 1000, [])
    url = f"/portfolios/{portfolio_id}/origin"
    assert client.put(url, headers=mgr, json={"master_login": 123}).status_code == 422
    accounts = {a["master_login"]: a for a in client.get("/me/master-accounts", headers=mgr).json()}
    assert accounts[login]["currency"] == "BRL" and accounts[login]["company"] == "XP Investimentos"

    db = database.SessionLocal()
    try:  # An open position of the portfolio on another account: its clients' copies would close
        strategy = db.query(models.Strategy).filter_by(user_id=manager_id, magic_number=magic).one()
        db.add(models.MasterPosition(manager_id=manager_id, strategy_id=strategy.id, master_login=login + 1, pos_id=9,
                                     symbol="WIN", type=0, volume=1, price_open=1))
        db.commit()
    finally:
        db.close()
    assert client.put(url, headers=mgr, json={"master_login": login}).status_code == 409
    db = database.SessionLocal()
    try:
        db.query(models.MasterPosition).filter_by(manager_id=manager_id, pos_id=9).one().closed_at = ago(0)
        db.commit()
    finally:
        db.close()
    assert client.put(url, headers=mgr, json={"master_login": login}).json() == {"master_login": login}
    assert next(p for p in client.get("/portfolios", headers=mgr).json() if p["id"] == portfolio_id)["master_login"] == login
    assert client.put(url, headers=mgr, json={"master_login": None}).json() == {"master_login": None}


def test_a_test_account_can_be_taken_out_once(client, capsys, monkeypatch):
    import clear_test_history
    manager_id, mgr, portfolio_id, magic, _ = portfolio_with_strategy(client, "Clean")
    login = uuid.uuid4().int % 10**8
    seed_track(manager_id, portfolio_id, magic, login, "XP Investimentos", "BRL", 1000, [(1, 300, 5)])
    seed_track(manager_id, portfolio_id, magic, login + 1, "RoboForex", "USD", 1000, [(2, -97, 4), (3, 10, 3)])
    url = f"/portfolios/{portfolio_id}/performance"
    assert client.get(url, headers=mgr).json()["trades"] == 3

    def run(*args):
        monkeypatch.setattr("sys.argv", ["clear_test_history.py", *map(str, args)])
        clear_test_history.main()
        return capsys.readouterr().out
    assert f"{login + 1}: 2 trade(s) - RoboForex" in run(portfolio_id)
    assert "net -87.00" in run(portfolio_id, login + 1) and client.get(url, headers=mgr).json()["trades"] == 3
    assert "Taken out: 2" in run(portfolio_id, login + 1, "--apply")
    p = client.get(url, headers=mgr).json()
    assert (p["trades"], p["net"], p["currency"]) == (1, 300.0, "BRL")
