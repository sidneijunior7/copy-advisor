"""
Spike fixtures, idempotent: one manager with its master key and two strategies, each in its own
portfolio, with an active license for every login in /spike/private/accounts.json:
- spike (magic 777001), fed by fake_master.py; license key of login N: lic_spike_N
- echo (magic 5457873, the Slave's own default magic), fed by a Master EA running on an account a
  Slave copies into (pod.sh PLAN=slave@0,master@0,echo@1); license key: lic_echo_N
The keys are fixed so pod.sh and fake_master.py can use them.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import database  # noqa: E402
import keys  # noqa: E402
import models  # noqa: E402

EMAIL = "spike-manager@local"
MASTER_KEY = "spike-master-key"
PORTFOLIO_KEY = "spike-portfolio-key"
MAGIC = 777001
ECHO_KEY = "spike-echo-key"
ECHO_MAGIC = 5457873
ACCOUNTS = "/spike/private/accounts.json"


def main():
    db = database.SessionLocal()
    try:
        manager = db.query(models.User).filter_by(email=EMAIL).one_or_none()
        if manager is None:
            manager = models.User(email=EMAIL, password_hash="!", role="MANAGER")
            db.add(manager)
            db.flush()
        if not db.query(models.MasterKey).filter_by(key_hash=keys.key_hash(MASTER_KEY)).first():
            db.add(models.MasterKey(user_id=manager.id, label="spike", key_hash=keys.key_hash(MASTER_KEY),
                                    key_prefix=keys.key_prefix(MASTER_KEY)))
        logins = [int(a["login"]) for a in json.load(open(ACCOUNTS))] if os.path.exists(ACCOUNTS) else []
        for name, magic, public_key, prefix in (("Spike", MAGIC, PORTFOLIO_KEY, "lic_spike"),
                                                ("Echo", ECHO_MAGIC, ECHO_KEY, "lic_echo")):
            strategy = db.query(models.Strategy).filter_by(user_id=manager.id, magic_number=magic).one_or_none()
            if strategy is None:
                strategy = models.Strategy(user_id=manager.id, name=name, magic_number=magic)
                db.add(strategy)
                db.flush()
            portfolio = db.query(models.Portfolio).filter_by(public_key=public_key).one_or_none()
            if portfolio is None:
                portfolio = models.Portfolio(user_id=manager.id, name=name, public_key=public_key)
                portfolio.strategies.append(strategy)
                db.add(portfolio)
                db.flush()
            for login in logins:
                lic = db.query(models.License).filter_by(portfolio_id=portfolio.id, client_mt5_login=login).first()
                if lic is None:
                    lic = models.License(portfolio_id=portfolio.id, client_mt5_login=login, max_lots=1.0)
                    db.add(lic)
                key = f"{prefix}_{login}"
                lic.key_hash, lic.key_prefix = keys.key_hash(key), keys.key_prefix(key)
            print(f"seed: {name}: strategy {strategy.id} (magic {magic}), portfolio {portfolio.id}, "
                  f"{len(logins)} licensed logins")
        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
