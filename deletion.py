"""
Deleting a portfolio, only when no client is left with it (blockers):

- no license still valid (active and not expired): its client copies with it;
- no subscription renewing in Stripe, and no paid hosting renewing for one of its licenses: they would keep charging;
- no request waiting for an answer: its client may be paying it;
- no copy still open on an expired or revoked license: the Slave keeps following the Master to close it.

Then all of it goes (delete): its listing with the plans, launch codes and requests, its licenses with what their
copies left (executions, account snapshots, hosted terminals), its track record, its homologation and its link to the
Dash. The strategies stay: they are the manager's, not the portfolio's.
"""
import datetime
from typing import List

from sqlalchemy.orm import Session

import clients
import models
import payments

OPEN_COPIES_DAYS = 90  # How far back a copy still open is looked for


def _licenses(db: Session, p: models.Portfolio) -> List[models.License]:
    return db.query(models.License).filter(models.License.portfolio_id == p.id).all()


def _listing(db: Session, p: models.Portfolio):
    return db.query(models.Listing).filter(models.Listing.portfolio_id == p.id).first()


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def blockers(db: Session, p: models.Portfolio, now: datetime.datetime) -> List[str]:
    """Why the portfolio cannot be deleted now, in the words the manager reads; empty when it can."""
    out = []
    lics = _licenses(db, p)
    valid = [l for l in lics if clients.license_valid(l, now)]
    if valid:
        out.append(f"{_plural(len(valid), 'licença válida', 'licenças válidas')}: revogue em Clientes ou espere vencer.")
    ids = [l.id for l in lics]
    listing = _listing(db, p)
    subs = (db.query(models.Subscription).filter(models.Subscription.listing_id == listing.id).all()
            if listing is not None else [])
    renewing = [s for s in subs if s.stripe_status in payments.RENEWING]
    if renewing:
        out.append(f"{_plural(len(renewing), 'assinatura renovando', 'assinaturas renovando')} na Stripe: "
                   "o cliente precisa cancelar, ou cancele pela Stripe.")
    pending = [s for s in subs if s.status == "pending"]
    if pending:
        out.append(f"{_plural(len(pending), 'pedido esperando', 'pedidos esperando')} resposta: recuse em Assinaturas.")
    hosting = (db.query(models.HostedTerminal).filter(models.HostedTerminal.license_id.in_(ids),
                                                      models.HostedTerminal.stripe_status.in_(payments.RENEWING)).count()
               if ids else 0)
    if hosting:
        out.append(f"{_plural(hosting, 'hospedagem paga', 'hospedagens pagas')} ainda renovando.")
    open_copies = [l for l in lics if l not in valid and l.client_mt5_login is not None
                   and any(c["status"] == "open" for c in clients.copies(db, l, OPEN_COPIES_DAYS, now))]
    if open_copies:
        out.append(f"{_plural(len(open_copies), 'conta tem', 'contas têm')} cópia ainda aberta, seguindo o Master até "
                   "fechar: espere fechar.")
    return out


def summary(db: Session, p: models.Portfolio) -> dict:
    """What deleting it takes away."""
    listing = _listing(db, p)
    return {
        "licenses": db.query(models.License).filter(models.License.portfolio_id == p.id).count(),
        "track_record": db.query(models.PortfolioTrade).filter(models.PortfolioTrade.portfolio_id == p.id).count(),
        "homologation": db.query(models.IncubationTrade).filter(models.IncubationTrade.portfolio_id == p.id).count(),
        "listing": listing is not None,
        "requests": db.query(models.Subscription).filter(models.Subscription.listing_id == listing.id).count() if listing else 0,
        "codes": db.query(models.PromoCode).filter(models.PromoCode.listing_id == listing.id).count() if listing else 0,
        "dash": db.query(models.DashLink).filter(models.DashLink.portfolio_id == p.id).first() is not None,
    }


def delete(db: Session, p: models.Portfolio):
    """Everything of the portfolio, children first, in bulk. The caller checks blockers and commits; what it had
    loaded from this session is detached."""
    ids = [l.id for l in _licenses(db, p)]
    listing = _listing(db, p)
    q = db.query
    q(models.PromoRedemption).filter(models.PromoRedemption.portfolio_id == p.id).delete(synchronize_session=False)
    if ids:
        q(models.PromoRedemption).filter(models.PromoRedemption.license_id.in_(ids)).delete(synchronize_session=False)
        q(models.Subscription).filter(models.Subscription.license_id.in_(ids)).delete(synchronize_session=False)
    if listing is not None:
        q(models.Subscription).filter(models.Subscription.listing_id == listing.id).delete(synchronize_session=False)
        q(models.PromoCode).filter(models.PromoCode.listing_id == listing.id).delete(synchronize_session=False)
        q(models.ListingPlan).filter(models.ListingPlan.listing_id == listing.id).delete(synchronize_session=False)
        q(models.Listing).filter(models.Listing.id == listing.id).delete(synchronize_session=False)
    if ids:
        q(models.HostedTerminal).filter(models.HostedTerminal.license_id.in_(ids)).delete(synchronize_session=False)
        q(models.AccountSnapshot).filter(models.AccountSnapshot.kind == "slave",
                                         models.AccountSnapshot.owner_id.in_(ids)).delete(synchronize_session=False)
    q(models.Execution).filter(models.Execution.portfolio_id == p.id).delete(synchronize_session=False)
    q(models.License).filter(models.License.portfolio_id == p.id).delete(synchronize_session=False)
    q(models.DashLink).filter(models.DashLink.portfolio_id == p.id).delete(synchronize_session=False)
    q(models.IncubationTrade).filter(models.IncubationTrade.portfolio_id == p.id).delete(synchronize_session=False)
    q(models.PortfolioTrade).filter(models.PortfolioTrade.portfolio_id == p.id).delete(synchronize_session=False)
    db.execute(models.portfolio_items.delete().where(models.portfolio_items.c.portfolio_id == p.id))
    q(models.Portfolio).filter(models.Portfolio.id == p.id).delete(synchronize_session=False)
    # In bulk, as above: the loaded objects would otherwise have the ORM update rows already gone
    db.expunge_all()
