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
POD_KEY = "pod_spike_local"  # The hosting pod of docker-compose.yml (tdm-spike-hosted)
MAGIC = 777001
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
        master_key = db.query(models.MasterKey).filter_by(key_hash=keys.key_hash(MASTER_KEY)).first()
        if master_key is None:
            db.add(models.MasterKey(user_id=manager.id, label="spike", key_hash=keys.key_hash(MASTER_KEY),
                                    key_prefix=keys.key_prefix(MASTER_KEY)))
        else:
            master_key.revoked_at = None  # The ZMQ cut (migration 0007) revoked every key that existed then
        if db.query(models.HostedPod).filter_by(key_hash=keys.key_hash(POD_KEY)).first() is None:
            db.add(models.HostedPod(name="spike-local", key_hash=keys.key_hash(POD_KEY),
                                    key_prefix=keys.key_prefix(POD_KEY)))
        logins = [int(a["login"]) for a in json.load(open(ACCOUNTS))] if os.path.exists(ACCOUNTS) else []
        for name, magic, prefix in (("Spike", MAGIC, "lic_spike"), ("Echo", ECHO_MAGIC, "lic_echo")):
            strategy = db.query(models.Strategy).filter_by(user_id=manager.id, magic_number=magic).one_or_none()
            if strategy is None:
                strategy = models.Strategy(user_id=manager.id, name=name, magic_number=magic)
                db.add(strategy)
                db.flush()
            portfolio = db.query(models.Portfolio).filter_by(user_id=manager.id, name=name).first()
            if portfolio is None:
                portfolio = models.Portfolio(user_id=manager.id, name=name)
                portfolio.strategies.append(strategy)
                db.add(portfolio)
                db.flush()
            for login in logins:
                lic = db.query(models.License).filter_by(portfolio_id=portfolio.id, client_mt5_login=login).first()
                if lic is None:
                    lic = models.License(portfolio_id=portfolio.id, client_mt5_login=login, max_lots=1.0)
                    db.add(lic)
                key = f"{prefix}_{login}"
                hosted = lic.id is not None and db.query(models.HostedTerminal).filter_by(license_id=lic.id).first()
                if not hosted:  # Hosting gave the license its own key, which only the pod has
                    lic.key_hash, lic.key_prefix = keys.key_hash(key), keys.key_prefix(key)
            print(f"seed: {name}: strategy {strategy.id} (magic {magic}), portfolio {portfolio.id}, "
                  f"{len(logins)} licensed logins")
        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
