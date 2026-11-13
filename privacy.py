"""
Privacy (LGPD): what the holder of the data can ask for, and how long each thing is kept. The Privacy Policy on the
site (frontend, pages/Legal.tsx) promises exactly what this module does: change one, change the other.

- export: everything the Mirror holds about a user, in one document (LGPD art. 18, II and V).
- close: ends a client's account. Access and credentials go at once (the password, the hosted accounts' broker
  passwords); what the law lets the Mirror keep for KEEP_CLOSED (who the client was, what was accepted, the
  subscriptions and the copies) stays apart from the live data and is dropped by purge after that.
- purge: checkout leads after LEAD_DAYS, access records after ACCESS_LOG_DAYS, and after KEEP_CLOSED a closed
  account's identity, its account numbers and the copies and balances recorded under them.
- log_access: when an account was used and from which address, kept for six months (Marco Civil, art. 15).
"""
import datetime
import json
import logging
from typing import List, Optional

from sqlalchemy.orm import Session

import models
import payments

logger = logging.getLogger(__name__)

TERMS_VERSION = "1.0"  # The Terms of Use and the Privacy Policy on the site: bump with the texts
LEAD_DAYS = 30  # A checkout lead that never became an account
ACCESS_LOG_DAYS = 190  # Six months by law, with a margin: never less
KEEP_CLOSED = datetime.timedelta(days=5 * 365)  # A closed account's records: defence in court and the regulator's
EXPORT_ROWS = 20_000  # Copies and balance records in one export
WATCH_SECONDS = 6 * 3600


class CloseError(Exception):
    """Why an account cannot be closed yet, in the admin's language."""

    def __init__(self, blockers: List[str]):
        super().__init__("; ".join(blockers))
        self.blockers = blockers


def log_access(db: Session, user_id: Optional[int], event: str, ip: str, now: datetime.datetime):
    """Never in the way of the login itself: a failure here is logged and forgotten."""
    try:
        db.add(models.AccessLog(user_id=user_id, event=event, ip=(ip or "unknown")[:45], created_at=now))
        db.commit()
    except Exception as e:
        db.rollback()
        logger.error(f"Access record failed: {type(e).__name__}: {str(e)[:200]}")


def _licenses(db: Session, user: models.User) -> List[models.License]:
    return db.query(models.License).filter(models.License.client_user_id == user.id).order_by(models.License.id).all()


def export(db: Session, user: models.User, now: datetime.datetime) -> dict:
    """Never a password, a key or anything encrypted: those are not the holder's data to read back, and a stolen
    session must not get them."""
    licenses = _licenses(db, user)
    ids = [l.id for l in licenses]
    logins = sorted({l.client_mt5_login for l in licenses if l.client_mt5_login is not None})
    terminals = db.query(models.HostedTerminal).filter(models.HostedTerminal.license_id.in_(ids)).all() if ids else []
    subs = (db.query(models.Subscription).filter(models.Subscription.client_user_id == user.id)
            .order_by(models.Subscription.id).all())
    executions = (db.query(models.Execution).filter(models.Execution.mt5_login.in_(logins))
                  .order_by(models.Execution.id.desc()).limit(EXPORT_ROWS).all()) if logins else []
    snapshots = (db.query(models.AccountSnapshot)
                 .filter(models.AccountSnapshot.kind == "slave", models.AccountSnapshot.owner_id.in_(ids))
                 .order_by(models.AccountSnapshot.hour.desc()).limit(EXPORT_ROWS).all()) if ids else []
    return {
        "generated_at": now, "policy_version": TERMS_VERSION,
        "account": {
            "email": user.email, "name": user.name, "cpf": user.cpf, "role": user.role, "created_at": user.created_at,
            "email_verified_at": user.email_verified_at, "broker": user.broker, "broker_other": user.broker_other,
            "advisor": user.advisor, "advisor_unknown": bool(user.advisor_unknown),
            "terms_accepted_at": user.terms_accepted_at, "terms_version": user.terms_version,
            "terms_ip": user.terms_ip, "closure_requested_at": user.closure_requested_at,
            "seller_name": user.seller_name, "seller_document": user.seller_document,
            "seller_address": user.seller_address, "seller_email": user.seller_email,
            "analyst_credential": user.analyst_credential, "credential_status": user.credential_status,
            "credential_checked_at": user.credential_checked_at, "credential_note": user.credential_note,
        },
        "licenses": [{"id": l.id, "portfolio": l.portfolio.name if l.portfolio else None,
                      "mt5_login": l.client_mt5_login, "max_lots": l.max_lots, "is_active": l.is_active,
                      "created_at": l.created_at, "expires_at": l.expires_at, "revoked_at": l.revoked_at}
                     for l in licenses],
        "hosted_accounts": [{"license_id": t.license_id, "server": t.server, "enabled": t.enabled, "status": t.status,
                             "created_at": t.created_at} for t in terminals],
        "subscriptions": [{"id": s.id, "portfolio": s.listing.title if s.listing else None, "kind": s.kind,
                           "status": s.status, "plan": s.plan.name if s.plan else None, "mt5_login": s.mt5_login,
                           "wants_hosting": bool(s.wants_hosting), "created_at": s.created_at,
                           "decided_at": s.decided_at, "risk_ack_at": s.risk_ack_at, "payment_status": s.stripe_status}
                          for s in subs],
        "launch_codes": [{"license_id": r.license_id, "free_days": r.free_days, "used_at": r.created_at,
                          "started_at": r.started_at}
                         for r in db.query(models.PromoRedemption).filter(models.PromoRedemption.user_id == user.id)],
        "lessons_done": [{"lesson_id": p.lesson_id, "completed_at": p.completed_at}
                         for p in db.query(models.EduProgress).filter(models.EduProgress.user_id == user.id)],
        "checkout_simulations": [{"portfolio": l.listing.title if l.listing else None, "lots": l.lots,
                                  "wants_hosting": l.wants_hosting, "first_seen": l.created_at, "last_seen": l.updated_at}
                                 for l in db.query(models.CheckoutLead).filter(models.CheckoutLead.email == user.email)],
        "access_records": [{"event": a.event, "ip": a.ip, "at": a.created_at}
                           for a in db.query(models.AccessLog).filter(models.AccessLog.user_id == user.id)
                           .order_by(models.AccessLog.id.desc()).limit(EXPORT_ROWS)],
        "copies": [{"at": e.created_at, "mt5_login": e.mt5_login, "action": e.action, "volume": e.volume,
                    "price": e.price, "retcode": e.retcode, "profit": e.profit} for e in executions],
        "balance_records": [{"mt5_login": s.login, "hour": s.hour, "balance": s.balance, "equity": s.equity,
                             "currency": s.currency} for s in snapshots],
    }


def blockers(db: Session, user: models.User) -> List[str]:
    """What has to be settled by a person before the account can be closed."""
    out = []
    if user.role != "CLIENT":
        out.append("Só contas de cliente são encerradas por aqui: a de trader tem portfólios e clientes ligados a ela")
    if user.closed_at is not None:
        out.append("A conta já está encerrada")
    live = (db.query(models.Subscription)
            .filter(models.Subscription.client_user_id == user.id,
                    models.Subscription.stripe_subscription_id.isnot(None),
                    models.Subscription.stripe_status.in_(payments.RENEWING)).count())
    if live:
        out.append(f"{live} assinatura(s) ainda ativa(s) na Stripe: cancele e reembolse o que for devido antes")
    return out


def close(db: Session, user: models.User, now: datetime.datetime) -> dict:
    """Closes a client's account; the caller commits and tells the hub. Raises CloseError with what is in the way,
    and payments.PaymentError if Stripe refuses to end a hosting."""
    reasons = blockers(db, user)
    if reasons:
        raise CloseError(reasons)
    licenses = _licenses(db, user)
    ids = [l.id for l in licenses]
    terminals = db.query(models.HostedTerminal).filter(models.HostedTerminal.license_id.in_(ids)).all() if ids else []
    for t in terminals:  # The broker passwords go with them
        payments.end_hosting(t)
        db.delete(t)
    for lic in licenses:  # As a manager's revoke: no new copies, the open ones still follow to their close
        if lic.is_active:
            lic.is_active, lic.revoked_at = False, now
    pending = (db.query(models.Subscription)
               .filter(models.Subscription.client_user_id == user.id, models.Subscription.status == "pending").all())
    for s in pending:
        s.status, s.decided_at = "cancelled", now
    counts = {
        "hosted_accounts": len(terminals), "licenses": len(licenses), "pending_requests": len(pending),
        "tokens": db.query(models.UserToken).filter(models.UserToken.user_id == user.id).delete(synchronize_session=False),
        "lessons": db.query(models.EduProgress).filter(models.EduProgress.user_id == user.id).delete(synchronize_session=False),
        "simulations": db.query(models.CheckoutLead).filter(models.CheckoutLead.email == user.email).delete(synchronize_session=False),
    }
    # Who the client was stays apart for the legal period; the live row keeps nothing that identifies or logs in
    user.closed_identity = json.dumps({"email": user.email, "name": user.name, "cpf": user.cpf}, ensure_ascii=False)
    user.email, user.name, user.cpf = f"encerrada-{user.id}@conta.invalid", None, None
    user.password_hash, user.password_changed_at = None, now
    user.broker = user.broker_other = user.advisor = None
    user.advisor_unknown = False
    user.status, user.closed_at = "archived", now
    return counts


def purge(db: Session, now: datetime.datetime) -> dict:
    """What is past its time; the caller commits."""
    leads = (db.query(models.CheckoutLead)
             .filter(models.CheckoutLead.updated_at < now - datetime.timedelta(days=LEAD_DAYS))
             .delete(synchronize_session=False))
    access = (db.query(models.AccessLog)
              .filter(models.AccessLog.created_at < now - datetime.timedelta(days=ACCESS_LOG_DAYS))
              .delete(synchronize_session=False))
    closed = (db.query(models.User)
              .filter(models.User.closed_at < now - KEEP_CLOSED, models.User.closed_identity.isnot(None)).all())
    for user in closed:
        # Past the legal period nothing may still point at the person: the identity goes, and so do the account
        # numbers and what was recorded under them
        for lic in _licenses(db, user):
            (db.query(models.AccountSnapshot)
             .filter(models.AccountSnapshot.kind == "slave", models.AccountSnapshot.owner_id == lic.id)
             .delete(synchronize_session=False))
            if lic.client_mt5_login is not None:
                (db.query(models.Execution)
                 .filter(models.Execution.portfolio_id == lic.portfolio_id,
                         models.Execution.mt5_login == lic.client_mt5_login)
                 .delete(synchronize_session=False))
                lic.client_mt5_login = None
        (db.query(models.Subscription).filter(models.Subscription.client_user_id == user.id)
         .update({models.Subscription.mt5_login: None}, synchronize_session=False))
        user.closed_identity, user.terms_ip, user.stripe_customer_id = None, None, None
    return {"leads": leads, "access_records": access, "closed_accounts": len(closed)}
