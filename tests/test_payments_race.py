"""
Stripe sends a purchase's events at once (checkout.session.completed, customer.subscription.created, invoice.paid),
each in a request of its own. Against real Postgres, two of them handled in parallel must approve the request once:
a request without an MT5 account once got a license per event (3 licenses for 1 purchase, 11/2026).
Uses TEST_POSTGRES_URL or, locally, the pgserver package; skipped without either.
"""
import datetime
import os
import tempfile
import threading
import time

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models
import payments


@pytest.fixture(scope="module")
def pg_sessions():
    url = os.getenv("TEST_POSTGRES_URL")
    server = None
    if not url:
        pgserver = pytest.importorskip("pgserver", reason="set TEST_POSTGRES_URL or pip install pgserver")
        server = pgserver.get_server(tempfile.mkdtemp(prefix="tdm_pg_race_"), cleanup_mode="stop")
        url = server.get_uri()
    engine = create_engine(url)
    models.Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine)
    engine.dispose()
    if server is not None:
        server.cleanup()


def pending_request(Session) -> int:
    with Session() as db:
        manager = models.User(email=f"gestor{time.time_ns()}@test", role="MANAGER")
        client = models.User(email=f"cliente{time.time_ns()}@test", role="CLIENT")
        portfolio = models.Portfolio(name="Select", owner=manager)
        listing = models.Listing(portfolio=portfolio, slug=f"select-{time.time_ns()}", title="Select", status="published")
        plan = models.ListingPlan(listing=listing, stripe_price_id="price_5", name="5 contratos", max_lots=5,
                                  price=100, currency="BRL", days=30)
        sub = models.Subscription(listing=listing, client=client, plan=plan, created_at=datetime.datetime.utcnow())
        db.add_all([manager, client, portfolio, listing, plan, sub])
        db.commit()
        return sub.id


def test_two_events_of_one_purchase_in_parallel_make_one_license(pg_sessions):
    sub_id = pending_request(pg_sessions)
    end = int(time.time()) + 30 * 86400
    s = {"id": f"sub_{sub_id}", "status": "active", "customer": "cus_1", "metadata": {"subscription_id": str(sub_id)},
         "items": {"data": [{"price": {"id": "price_5"}, "current_period_end": end}]}}
    first_synced, results, errors = threading.Event(), [], []

    def deliver(first: bool):
        try:
            with pg_sessions() as db:
                if not first:
                    first_synced.wait(5)  # The first event has approved, not committed yet
                results.append(payments.sync(db, s, datetime.datetime.utcnow())[1])
                if first:
                    first_synced.set()
                    time.sleep(0.5)  # Holds its transaction open while the second event arrives
                db.commit()
        except Exception as e:  # pragma: no cover - reported below
            errors.append(e)
            first_synced.set()

    threads = [threading.Thread(target=deliver, args=(first,)) for first in (True, False)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert not errors, errors
    assert sorted(results) == [False, True]  # Only one of them approved: one email, one sale
    with pg_sessions() as db:
        sub = db.get(models.Subscription, sub_id)
        licenses = db.query(models.License).filter(models.License.portfolio_id == sub.listing.portfolio_id).all()
        assert [lic.id for lic in licenses] == [sub.license_id]
        assert licenses[0].max_lots == 5
