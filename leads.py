"""
Checkout leads: the email a visitor gives right after the contract simulator, before creating an account. If the
visitor stops there, the simulation goes to that email an hour later, and one reminder a day after; nothing goes
once the visitor subscribes or uses a code (marketplace.convert_leads), already copies the portfolio, or follows
the link that stops the emails. A lead is a few days old at most: after that it is never written to again.
"""
import datetime
import secrets
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

import models

WATCH_SECONDS = 600
# (emails already sent, how long after the visitor was last seen in the checkout the next one goes)
SCHEDULE = ((0, datetime.timedelta(hours=1)), (1, datetime.timedelta(hours=24)))
MAX_AGE = datetime.timedelta(days=7)  # An older lead gets nothing


def record(db: Session, listing: models.Listing, email: str, lots: Optional[float], wants_hosting: Optional[bool],
           step: Optional[str], now: datetime.datetime) -> models.CheckoutLead:
    """One lead per email and listing: coming back updates it, and the reminders count from the last visit."""
    lead = (db.query(models.CheckoutLead)
            .filter(models.CheckoutLead.email == email, models.CheckoutLead.listing_id == listing.id).first())
    if lead is None:
        lead = models.CheckoutLead(email=email, listing_id=listing.id, token=secrets.token_urlsafe(32),
                                   reminders=0, created_at=now)
        db.add(lead)
    if lots is not None:
        lead.lots = lots
    if wants_hosting is not None:
        lead.wants_hosting = wants_hosting
    if step:
        lead.step = step
    lead.updated_at = now
    return lead


def _already_copies(db: Session, lead: models.CheckoutLead) -> bool:
    """The email has an account that subscribed to the listing, or has a license of its portfolio."""
    user = db.query(models.User).filter(models.User.email == lead.email).first()
    if user is None:
        return False
    if db.query(models.Subscription.id).filter(models.Subscription.client_user_id == user.id,
                                               models.Subscription.listing_id == lead.listing_id,
                                               models.Subscription.status.in_(("pending", "approved"))).first():
        return True
    portfolio_id = lead.listing.portfolio_id if lead.listing else None
    return portfolio_id is not None and db.query(models.License.id).filter(
        models.License.portfolio_id == portfolio_id, models.License.client_user_id == user.id).first() is not None


def due(db: Session, now: datetime.datetime) -> List[Tuple[models.CheckoutLead, int]]:
    """The leads whose next email is due, with which one (0: the simulation, 1: the reminder), already counted as
    sent: the caller commits before sending, so a failed commit sends nothing twice."""
    out = []
    for sent, wait in SCHEDULE:
        rows = (db.query(models.CheckoutLead)
                .filter(models.CheckoutLead.reminders == sent, models.CheckoutLead.converted_at.is_(None),
                        models.CheckoutLead.stopped_at.is_(None), models.CheckoutLead.updated_at <= now - wait,
                        models.CheckoutLead.created_at >= now - MAX_AGE)
                .limit(200).all())
        for lead in rows:
            if lead.listing is None or lead.listing.status != "published" or _already_copies(db, lead):
                lead.converted_at = now  # Nothing to recover: never looked at again
                continue
            lead.reminders = sent + 1
            out.append((lead, sent))
    return out


def stop(db: Session, token: str, now: datetime.datetime) -> bool:
    lead = db.query(models.CheckoutLead).filter(models.CheckoutLead.token == token).first()
    if lead is None:
        return False
    # Every listing of that email: whoever asks to stop means all of them
    (db.query(models.CheckoutLead).filter(models.CheckoutLead.email == lead.email,
                                          models.CheckoutLead.stopped_at.is_(None))
     .update({models.CheckoutLead.stopped_at: now}, synchronize_session=False))
    return True
