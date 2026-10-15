"""
Spike fixtures, idempotent: one manager, one strategy in one portfolio, and an active license for
every login in /spike/private/accounts.json. The keys are fixed so pod.sh can use them.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import database  # noqa: E402
import models  # noqa: E402

EMAIL = "spike-manager@local"
MASTER_KEY = "spike-master-key"
PORTFOLIO_KEY = "spike-portfolio-key"
MAGIC = 777001
ACCOUNTS = "/spike/private/accounts.json"


def main():
    db = database.SessionLocal()
    try:
        manager = db.query(models.User).filter_by(email=EMAIL).one_or_none()
        if manager is None:
            manager = models.User(email=EMAIL, password_hash="!", role="MANAGER", master_key=MASTER_KEY)
            db.add(manager)
            db.flush()
        strategy = db.query(models.Strategy).filter_by(user_id=manager.id, magic_number=MAGIC).one_or_none()
        if strategy is None:
            strategy = models.Strategy(user_id=manager.id, name="Spike", magic_number=MAGIC)
            db.add(strategy)
            db.flush()
        portfolio = db.query(models.Portfolio).filter_by(public_key=PORTFOLIO_KEY).one_or_none()
        if portfolio is None:
            portfolio = models.Portfolio(user_id=manager.id, name="Spike", public_key=PORTFOLIO_KEY)
            portfolio.strategies.append(strategy)
            db.add(portfolio)
            db.flush()

        logins = [int(a["login"]) for a in json.load(open(ACCOUNTS))] if os.path.exists(ACCOUNTS) else []
        for login in logins:
            if not db.query(models.License).filter_by(portfolio_id=portfolio.id, client_mt5_login=login).first():
                db.add(models.License(portfolio_id=portfolio.id, client_mt5_login=login, max_lots=1.0))
        db.commit()
        print(f"seed: manager {manager.id}, strategy {strategy.id} (magic {MAGIC}), "
              f"portfolio {portfolio.id} (P_{portfolio.id}), {len(logins)} licensed logins")
    finally:
        db.close()


if __name__ == "__main__":
    main()
