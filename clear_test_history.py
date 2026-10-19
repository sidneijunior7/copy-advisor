"""
Take a test account's trades out of a portfolio's track record (portfolio_trades), once, before the portfolio is
sold: the track record is otherwise never edited (performance.py).

    python clear_test_history.py <portfolio_id>                 lists the accounts behind its track record
    python clear_test_history.py <portfolio_id> <login>         shows what would go
    python clear_test_history.py <portfolio_id> <login> --apply takes it out

Only the record of what went to the portfolio goes: the Master's positions and deals stay. The public page keeps
its old numbers for up to 5 minutes (marketplace cache).
"""
import sys
from collections import defaultdict

import database
import models
import performance


def main():
    args = [a for a in sys.argv[1:] if a != "--apply"]
    if len(args) not in (1, 2) or not all(a.isdigit() for a in args):
        sys.exit(__doc__)
    portfolio_id = int(args[0])
    db = database.SessionLocal()
    try:
        portfolio = db.get(models.Portfolio, portfolio_id)
        if portfolio is None:
            sys.exit(f"No portfolio {portfolio_id}")
        trades = db.query(models.PortfolioTrade).filter(models.PortfolioTrade.portfolio_id == portfolio_id).all()
        accounts = {a.master_login: a for a in db.query(models.MasterAccount)
                    .filter(models.MasterAccount.manager_id == portfolio.user_id)}
        if len(args) == 1:
            by_login = defaultdict(int)
            for t in trades:
                by_login[t.master_login] += 1
            print(f"Portfolio {portfolio_id} ({portfolio.name}), copies from: {portfolio.master_login or 'every account'}")
            for login, count in sorted(by_login.items()):
                a = accounts.get(login)
                print(f"  {login}: {count} trade(s) - {a.company if a else '?'} {a.server if a else ''} "
                      f"({a.trade_mode if a else '?'})")
            return
        login = int(args[1])
        mine = [t for t in trades if t.master_login == login]
        deals = performance._deals_of(db, portfolio.user_id, {(t.master_login, t.pos_id) for t in mine})
        net = sum((d.profit or 0) + (d.swap or 0) + (d.commission or 0) for ds in deals.values() for d in ds)
        print(f"Portfolio {portfolio_id} ({portfolio.name}): {len(mine)} trade(s) of account {login}, net {net:.2f}")
        if not mine:
            return
        if "--apply" not in sys.argv:
            print("Nothing changed. Run again with --apply to take them out.")
            return
        if login == portfolio.master_login:
            sys.exit("That is the account the portfolio copies from: pick another origin first")
        db.query(models.PortfolioTrade).filter(models.PortfolioTrade.portfolio_id == portfolio_id,
                                               models.PortfolioTrade.master_login == login).delete()
        db.commit()
        print(f"Taken out: {len(mine)} trade(s)")
    finally:
        db.close()


if __name__ == "__main__":
    main()
