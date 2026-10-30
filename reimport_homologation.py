"""
Import a portfolio's homologation from the Trademetric Dash again, from the start, under the bridge's current rules
(dash_bridge.freeze_incubation): the cursor goes back to empty, and the next round of the bridge (every
DASH_BRIDGE_SECONDS) asks the Dash for its strategies' whole live tracking. The trades already taken stay, and none is
taken twice.

    python reimport_homologation.py                         lists the portfolios linked to the Dash
    python reimport_homologation.py <portfolio_id>          shows its homologation and link
    python reimport_homologation.py <portfolio_id> --apply  imports it again

Run it after the Dash sends the whole live tracking (backend-mirror with the Mirror's composed_at).
"""
import sys

import dash_bridge
import database
import models


def main():
    args = [a for a in sys.argv[1:] if a != "--apply"]
    if len(args) > 1 or not all(a.isdigit() for a in args):
        sys.exit(__doc__)
    db = database.SessionLocal()
    try:
        if not args:
            for link in db.query(models.DashLink).order_by(models.DashLink.portfolio_id):
                p = link.portfolio
                count = db.query(models.IncubationTrade).filter(models.IncubationTrade.portfolio_id == p.id).count()
                print(f"{p.id}: {p.name} - {count} trade(s) in the homologation, link {link.status}")
            return
        portfolio = db.get(models.Portfolio, int(args[0]))
        link = db.query(models.DashLink).filter(models.DashLink.portfolio_id == int(args[0])).first()
        if portfolio is None or link is None:
            sys.exit(f"No portfolio {args[0]} linked to the Dash")
        count = db.query(models.IncubationTrade).filter(models.IncubationTrade.portfolio_id == portfolio.id).count()
        print(f"Portfolio {portfolio.id} ({portfolio.name}), copies from: {portfolio.master_login or 'every account'}")
        print(f"  homologation: {count} trade(s), cursor {portfolio.incubation_cursor or '(empty)'}")
        print(f"  link: {link.status}, backtest fetched {link.backtest_fetched_at}, error: {link.backtest_error or '-'}")
        print(f"  Dash portfolio put together: {dash_bridge.composed_at(db, portfolio.id) or '(the Dash does not say yet)'}")
        if "--apply" not in sys.argv:
            print("Add --apply to import it again.")
            return
        portfolio.incubation_cursor = None
        link.backtest_fetched_at = None  # Due now: the next round asks the Dash
        db.commit()
        print(f"Done: the bridge imports it again within {dash_bridge.INTERVAL} s. Run this again to see the count.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
