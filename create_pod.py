"""
Create a hosting pod and print its key once, or revoke one.

    python create_pod.py <name>
    python create_pod.py --revoke <name>

The key goes in the pod's POD_KEY (pod_agent.py). Only its hash is stored. A revoked pod gets 401 at its next
sync and stops its terminals; they stay assigned to it (their copy mapping lives in its slot folders).
"""
import datetime
import sys

import database
import keys
import models


def main():
    args = sys.argv[1:]
    revoke = args[:1] == ["--revoke"]
    if revoke:
        args = args[1:]
    if len(args) != 1 or not args[0].strip():
        sys.exit(__doc__)
    name = args[0].strip()[:64]

    db = database.SessionLocal()
    try:
        if revoke:
            pods = db.query(models.HostedPod).filter(models.HostedPod.name == name,
                                                     models.HostedPod.revoked_at.is_(None)).all()
            if not pods:
                sys.exit(f"No active pod named {name}")
            for pod in pods:
                pod.revoked_at = datetime.datetime.utcnow()
            db.commit()
            print(f"Revoked {len(pods)} pod key(s) named {name}")
            return
        key = keys.new_key(keys.POD)
        db.add(models.HostedPod(name=name, key_hash=keys.key_hash(key), key_prefix=keys.key_prefix(key)))
        db.commit()
        print(f"Pod {name} created. Its POD_KEY (shown only now):\n{key}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
