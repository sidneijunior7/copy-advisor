"""
Payments through Stripe, on the platform's own account (paying each manager directly, Stripe Connect, comes later).

A listing sells plans: each one a recurring Stripe price and the lot limit it buys. A subscription request for a plan
opens a Stripe Checkout, and the webhook approves the request once Stripe says the subscription is paid
(marketplace.approve). Each renewal Stripe collects extends the license to the paid period's end plus GRACE; a failed
renewal changes nothing, the license just runs out. In the Mirror the client changes the plan (the difference is
charged or credited at once, prorated) and cancels or resumes the renewal; the card and the invoices are on Stripe's
portal. Listings without plans keep the manager's checkout link and the approval by hand.

Hosting the client's terminal (hosting.py) is a subscription of its own, to the platform's single hosting price: the
money is the platform's, not the manager's, and either one is cancelled apart from the other. The webhook tells
them apart by the metadata.

Configuration: STRIPE_SECRET_KEY (sk_test_... or sk_live_...), STRIPE_WEBHOOK_SECRET (whsec_...), PUBLIC_URL and,
to charge for hosting, STRIPE_HOSTING_PRICE_ID (a recurring price_...).
"""
import datetime
import json
import logging
import os
import time
from typing import List, Optional, Tuple

import stripe
from sqlalchemy.orm import Session

import hosting
import mailer
import marketplace
import models

logger = logging.getLogger("payments")

GRACE = datetime.timedelta(days=2)  # Stripe retries a failed renewal for days: the copy does not stop at the first try
PAID = ("active", "trialing")
RENEWING = ("active", "trialing", "past_due")  # A live Stripe subscription: no renewal request by hand
PERIOD_DAYS = {"day": 1, "week": 7, "month": 30, "year": 365}
MIN_TRIAL = datetime.timedelta(hours=49)  # Stripe takes a trial_end only 48 h ahead or more
TERMS_SECONDS = 600  # How long the hosting price read from Stripe is reused


class PaymentError(Exception):
    """Something to tell the user, in Portuguese, with the HTTP status to answer."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def enabled() -> bool:
    return bool(os.getenv("STRIPE_SECRET_KEY"))


def _client() -> stripe.StripeClient:
    return stripe.StripeClient(os.environ["STRIPE_SECRET_KEY"])


def _utc(ts: Optional[int]) -> Optional[datetime.datetime]:
    return None if ts is None else datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).replace(tzinfo=None)


def _unavailable(what: str, e: Exception) -> PaymentError:
    logger.warning(f"Stripe {what}: {e}")
    return PaymentError("A Stripe não respondeu. Tente de novo em instantes")


# --- Plans ---

def price_terms(price_id: str) -> dict:
    """What the plan shows comes from the Stripe price, so the page and the charge never disagree."""
    try:
        price = _client().v1.prices.retrieve(price_id).to_dict()
    except stripe.InvalidRequestError:
        raise PaymentError(f"O preço {price_id} não existe na Stripe", 422)
    except stripe.StripeError as e:
        raise _unavailable(f"price {price_id}", e)
    recurring = price.get("recurring") or {}
    currency = (price.get("currency") or "").upper()
    if not price.get("active"):
        raise PaymentError(f"O preço {price_id} está arquivado na Stripe", 422)
    if recurring.get("interval") not in PERIOD_DAYS or price.get("unit_amount") is None:
        raise PaymentError(f"O preço {price_id} precisa ser recorrente e com valor fixo", 422)
    if currency not in ("BRL", "USD"):
        raise PaymentError(f"O preço {price_id} precisa ser em BRL ou USD", 422)
    return {"price": price["unit_amount"] / 100, "currency": currency, "nickname": (price.get("nickname") or "").strip(),
            "days": PERIOD_DAYS[recurring["interval"]] * (recurring.get("interval_count") or 1)}


def lots_label(lots: float) -> str:
    n = f"{lots:g}".replace(".", ",")
    return f"Até {n} contrato{'' if lots == 1 else 's'}"


def save_plans(db: Session, listing: models.Listing, plans: List["marketplace.PlanIn"]):
    """Brings the listing's plans in line with the form. A plan left out is archived, not deleted: subscriptions on it
    keep renewing. A price belongs to one listing only. The listing's price becomes the cheapest plan's."""
    ids = [p.stripe_price_id for p in plans]
    if len(set(ids)) != len(ids):
        raise PaymentError("O mesmo preço aparece em dois planos", 422)
    if plans and not enabled():
        raise PaymentError("O pagamento pela Stripe ainda não foi configurado no servidor", 409)
    taken = ids and (db.query(models.ListingPlan.stripe_price_id)  # The listing is flushed: it has its id
                     .filter(models.ListingPlan.stripe_price_id.in_(ids), models.ListingPlan.listing_id != listing.id).first())
    if taken:
        raise PaymentError(f"O preço {taken[0]} já está em outro anúncio", 409)
    terms = [price_terms(p.stripe_price_id) for p in plans]
    if len({t["currency"] for t in terms}) > 1:
        raise PaymentError("Use preços na mesma moeda em todos os planos", 422)
    existing = {p.stripe_price_id: p for p in listing.plans}
    for position, (data, t) in enumerate(zip(plans, terms)):
        plan = existing.pop(data.stripe_price_id, None)
        if plan is None:
            plan = models.ListingPlan(stripe_price_id=data.stripe_price_id)
            listing.plans.append(plan)
        plan.name = t["nickname"][:80] or lots_label(data.max_lots)
        plan.max_lots, plan.price, plan.currency, plan.days = data.max_lots, t["price"], t["currency"], t["days"]
        plan.position, plan.archived = position, False
    for plan in existing.values():
        plan.archived = True
    if terms:
        cheapest = min(zip(plans, terms), key=lambda pt: pt[1]["price"])
        listing.price, listing.currency, listing.default_days = cheapest[1]["price"], cheapest[1]["currency"], cheapest[1]["days"]
        listing.default_max_lots = cheapest[0].max_lots


# --- Checkout and portal ---

def _license_of(db: Session, sub: models.Subscription) -> Optional[models.License]:
    if sub.mt5_login is None:
        return None
    return (db.query(models.License).filter(models.License.portfolio_id == sub.listing.portfolio_id,
                                            models.License.client_mt5_login == sub.mt5_login).first())


def expire_checkout(sub: models.Subscription):
    """The request was answered or replaced: its open Checkout must not take a payment anymore."""
    if not sub.stripe_session_id or not enabled():
        return
    try:
        session = _client().v1.checkout.sessions.retrieve(sub.stripe_session_id)
        if session.status == "open":
            _client().v1.checkout.sessions.expire(sub.stripe_session_id)
    except stripe.StripeError as e:
        logger.warning(f"Subscription {sub.id}: could not expire Checkout {sub.stripe_session_id}: {e}")


def checkout(db: Session, sub: models.Subscription, now: datetime.datetime) -> str:
    """A Checkout for a pending request. A renewal of a license with time left starts charging when it ends."""
    listing, user = sub.listing, sub.client
    expire_checkout(sub)
    data = {"subscription_id": str(sub.id), "listing_id": str(listing.id)}
    subscription_data: dict = {"metadata": data}
    lic = _license_of(db, sub) if sub.kind == "renewal" else None
    if lic is not None and lic.expires_at is not None and lic.expires_at > now + MIN_TRIAL:
        subscription_data["trial_end"] = int(lic.expires_at.replace(tzinfo=datetime.timezone.utc).timestamp())
    params = {
        "mode": "subscription", "line_items": [{"price": sub.plan.stripe_price_id, "quantity": 1}],
        "client_reference_id": str(sub.id), "metadata": data, "subscription_data": subscription_data,
        "locale": "pt-BR", "allow_promotion_codes": True,
        "success_url": f"{mailer.public_url()}/client/licenses?pagamento=ok",
        "cancel_url": f"{mailer.public_url()}/marketplace/{listing.slug}",
    }
    if user.stripe_customer_id:
        params["customer"] = user.stripe_customer_id
    else:
        params["customer_email"] = user.email
    try:
        session = _client().v1.checkout.sessions.create(params)
    except stripe.StripeError as e:
        logger.error(f"Subscription {sub.id}: Checkout failed: {e}")
        raise PaymentError("Não foi possível abrir o pagamento. Tente de novo em instantes")
    sub.stripe_session_id = session.id
    return session.url


def portal(user: models.User) -> str:
    """Stripe's own page for the card and the invoices."""
    if not user.stripe_customer_id:
        raise PaymentError("Você ainda não tem assinaturas pagas pela Stripe", 409)
    try:
        session = _client().v1.billing_portal.sessions.create(
            {"customer": user.stripe_customer_id, "return_url": f"{mailer.public_url()}/client/licenses"})
    except stripe.StripeError as e:
        logger.error(f"User {user.id}: billing portal failed: {e}")
        raise PaymentError("Não foi possível abrir a página de pagamentos. Tente de novo em instantes")
    return session.url


# --- Managing a paid subscription from the Mirror ---

def _subscription(stripe_id: str) -> dict:
    return _client().v1.subscriptions.retrieve(stripe_id).to_dict()


def _update(sub: models.Subscription, params: dict) -> dict:
    try:
        return _client().v1.subscriptions.update(sub.stripe_subscription_id, params).to_dict()
    except stripe.CardError as e:
        raise PaymentError(f"O cartão recusou a cobrança: {e.user_message or 'atualize o cartão em Pagamentos'}", 402)
    except stripe.StripeError as e:
        raise _unavailable(f"update of {sub.stripe_subscription_id}", e)


def change_plan(db: Session, sub: models.Subscription, plan: models.ListingPlan, now: datetime.datetime) -> models.Subscription:
    """The client's new plan. The difference is charged (or credited) now, prorated; the plan, and the lot limit with
    it, only change once the charge goes through."""
    s = _subscription(sub.stripe_subscription_id)
    items = (s.get("items") or {}).get("data") or []
    if not items:
        raise PaymentError("Assinatura sem item na Stripe: fale com o suporte")
    updated = _update(sub, {"items": [{"id": items[0]["id"], "price": plan.stripe_price_id}],
                            "proration_behavior": "always_invoice", "payment_behavior": "pending_if_incomplete"})
    sync(db, updated, now)
    if updated.get("pending_update"):
        raise PaymentError("A cobrança da diferença não passou. Atualize o cartão em Pagamentos e tente de novo", 402)
    return sub


def set_renewal(db: Session, sub: models.Subscription, renew: bool, now: datetime.datetime) -> models.Subscription:
    """Cancelling ends the subscription with the paid period: the license stays valid until then."""
    sync(db, _update(sub, {"cancel_at_period_end": not renew}), now)
    return sub


# --- Webhook ---

def paid_until(s: dict) -> Optional[datetime.datetime]:
    if s.get("status") == "trialing" and s.get("trial_end"):
        return _utc(s["trial_end"])
    # Newer API versions keep the period on each item
    ends = [s.get("current_period_end")] + [i.get("current_period_end") for i in (s.get("items") or {}).get("data", [])]
    ends = [e for e in ends if e]
    return _utc(max(ends)) if ends else None


def _plan_of(db: Session, sub: models.Subscription, s: dict) -> Optional[models.ListingPlan]:
    items = (s.get("items") or {}).get("data") or []
    price = (items[0].get("price") or {}) if items else {}
    price_id = price.get("id") if isinstance(price, dict) else price
    if not price_id:
        return None
    return (db.query(models.ListingPlan).filter(models.ListingPlan.listing_id == sub.listing_id,
                                                models.ListingPlan.stripe_price_id == price_id).first())


def sync(db: Session, s: dict, now: datetime.datetime) -> Tuple[Optional[models.Subscription], bool]:
    """Brings the request and its license in line with a Stripe subscription. Idempotent: Stripe sends an event more
    than once and in any order. Returns the request and whether this call approved it."""
    terminal = _terminal_of(db, s)
    if terminal is not None:
        sync_hosting(db, terminal, s, now)
        return None, False
    ours = (s.get("metadata") or {}).get("subscription_id")
    sub = db.get(models.Subscription, int(ours)) if ours and str(ours).isdigit() else None
    if sub is None:
        sub = db.query(models.Subscription).filter(models.Subscription.stripe_subscription_id == s["id"]).first()
    if sub is None:
        logger.warning(f"Stripe subscription {s['id']}: no request of ours")
        return None, False
    if sub.stripe_subscription_id not in (None, s["id"]):
        logger.error(f"Subscription {sub.id}: paid twice in Stripe ({sub.stripe_subscription_id} and {s['id']}): refund one")
        return sub, False
    sub.stripe_subscription_id, sub.stripe_status = s["id"], s.get("status")
    sub.stripe_cancel_at_period_end = bool(s.get("cancel_at_period_end") or s.get("cancel_at"))
    customer = s.get("customer")
    if isinstance(customer, str) and not sub.client.stripe_customer_id:
        sub.client.stripe_customer_id = customer
    until = paid_until(s) if s.get("status") in PAID else None
    if until is None:
        return sub, False
    sub.stripe_period_end = until
    plan = _plan_of(db, sub, s)
    if plan is not None and plan.id != sub.plan_id:
        logger.info(f"Subscription {sub.id}: plan {sub.plan_id} -> {plan.id} ({plan.max_lots} lots)")
        sub.plan = plan
        if sub.license is not None:
            sub.license.max_lots = plan.max_lots
    target = until + GRACE
    if sub.status in ("pending", "cancelled"):  # Cancelled here after paying there: the money decides
        lic = marketplace.approve(db, sub, marketplace.Decision(), now)
        lic.expires_at = target  # The period Stripe charged, not the listing's days
        logger.info(f"Subscription {sub.id} paid in Stripe ({s['id']}): license {lic.id} until {target}")
        return sub, True
    if sub.status == "approved" and sub.license is not None:
        if sub.license.expires_at is None or sub.license.expires_at < target:
            sub.license.expires_at = target
            logger.info(f"Subscription {sub.id} renewed in Stripe: license {sub.license_id} until {target}")
        return sub, False
    logger.error(f"Subscription {sub.id} is {sub.status} but paid in Stripe ({s['id']}): refund it")
    return sub, False


def handle(db: Session, payload: bytes, signature: str, now: datetime.datetime) -> Tuple[Optional[models.Subscription], bool]:
    """A webhook call. Raises stripe.SignatureVerificationError when it did not come from Stripe."""
    stripe.WebhookSignature.verify_header(payload.decode("utf-8"), signature, os.environ["STRIPE_WEBHOOK_SECRET"],
                                          stripe.Webhook.DEFAULT_TOLERANCE)
    event = json.loads(payload)
    kind, obj = event.get("type"), event.get("data", {}).get("object", {})
    if kind in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
        if obj.get("mode") != "subscription" or not obj.get("subscription"):
            return None, False
        s = _subscription(obj["subscription"])
        s.setdefault("metadata", {}).setdefault("subscription_id", obj.get("client_reference_id"))
        return sync(db, s, now)
    if kind in ("customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"):
        return sync(db, obj, now)
    if kind == "invoice.paid":
        stripe_id = (((obj.get("parent") or {}).get("subscription_details") or {}).get("subscription")
                     or obj.get("subscription"))
        return sync(db, _subscription(stripe_id), now) if stripe_id else (None, False)
    return None, False


# --- Hosting ---

def hosting_price() -> Optional[str]:
    """The platform's hosting price: without it (or without Stripe), hosting is not charged."""
    price = os.getenv("STRIPE_HOSTING_PRICE_ID", "").strip()
    return price if price and enabled() else None


_terms_cache: dict = {}


def hosting_terms() -> Optional[dict]:
    """The hosting price as the client sees it (price, currency, days), read from Stripe and reused for a while.
    None when hosting is not charged or Stripe does not answer."""
    price_id = hosting_price()
    if price_id is None:
        return None
    cached = _terms_cache.get(price_id)
    if cached is not None and time.monotonic() - cached[0] < TERMS_SECONDS:
        return cached[1]
    try:
        terms = price_terms(price_id)
    except PaymentError as e:
        logger.error(f"STRIPE_HOSTING_PRICE_ID: {e}")
        return None
    terms.pop("nickname", None)
    _terms_cache[price_id] = (time.monotonic(), terms)
    return terms


def _terminal_of(db: Session, s: dict) -> Optional[models.HostedTerminal]:
    ours = (s.get("metadata") or {}).get("hosted_terminal_id")
    if ours and str(ours).isdigit():
        return db.get(models.HostedTerminal, int(ours))
    return db.query(models.HostedTerminal).filter(models.HostedTerminal.stripe_subscription_id == s["id"]).first()


def hosting_checkout(t: models.HostedTerminal, user: models.User) -> str:
    """A Checkout for the terminal's hosting; the previous one, if still open, is closed so it is never paid twice."""
    price_id = hosting_price()
    if price_id is None:
        raise PaymentError("A cobrança da hospedagem não está configurada no servidor", 409)
    if t.stripe_session_id:
        try:
            session = _client().v1.checkout.sessions.retrieve(t.stripe_session_id)
            if session.status == "open":
                _client().v1.checkout.sessions.expire(t.stripe_session_id)
        except stripe.StripeError as e:
            logger.warning(f"Hosted terminal {t.id}: could not expire Checkout {t.stripe_session_id}: {e}")
    data = {"hosted_terminal_id": str(t.id), "license_id": str(t.license_id)}
    page = f"{mailer.public_url()}/client/licenses/{t.license_id}"
    params = {
        "mode": "subscription", "line_items": [{"price": price_id, "quantity": 1}],
        "client_reference_id": f"hosting-{t.id}", "metadata": data, "subscription_data": {"metadata": data},
        "locale": "pt-BR", "allow_promotion_codes": True,
        "success_url": f"{page}?hospedagem=ok", "cancel_url": page,
    }
    if user.stripe_customer_id:
        params["customer"] = user.stripe_customer_id
    else:
        params["customer_email"] = user.email
    try:
        session = _client().v1.checkout.sessions.create(params)
    except stripe.StripeError as e:
        logger.error(f"Hosted terminal {t.id}: Checkout failed: {e}")
        raise PaymentError("Não foi possível abrir o pagamento. Tente de novo em instantes")
    t.stripe_session_id = session.id
    return session.url


def set_hosting_renewal(db: Session, t: models.HostedTerminal, renew: bool, now: datetime.datetime):
    """Cancelling ends the hosting with the paid period: the terminal runs until then."""
    try:
        s = _client().v1.subscriptions.update(t.stripe_subscription_id, {"cancel_at_period_end": not renew}).to_dict()
    except stripe.StripeError as e:
        raise _unavailable(f"update of {t.stripe_subscription_id}", e)
    sync_hosting(db, t, s, now)


def end_hosting(t: models.HostedTerminal):
    """The hosting was removed: its subscription ends now, so nothing else is charged."""
    if t.stripe_subscription_id is None or t.stripe_status not in RENEWING:
        return
    try:
        _client().v1.subscriptions.cancel(t.stripe_subscription_id)
    except stripe.StripeError as e:
        raise _unavailable(f"cancel of {t.stripe_subscription_id}", e)
    logger.info(f"Hosted terminal {t.id}: Stripe subscription {t.stripe_subscription_id} cancelled with the hosting")


def sync_hosting(db: Session, t: models.HostedTerminal, s: dict, now: datetime.datetime):
    """Brings the terminal in line with its Stripe subscription. Idempotent, like sync. A terminal that starts
    running again after stopping for lack of payment gets a new configuration version: the pod restarts it."""
    if t.stripe_subscription_id not in (None, s["id"]):
        if s.get("status") not in RENEWING:
            return  # An earlier subscription of this terminal, ended
        if t.stripe_status in RENEWING:
            logger.error(f"Hosted terminal {t.id}: paid twice in Stripe ({t.stripe_subscription_id} and {s['id']}): refund one")
            return
    was_paid = hosting.paid(t, now)
    t.stripe_subscription_id, t.stripe_status = s["id"], s.get("status")
    t.stripe_cancel_at_period_end = bool(s.get("cancel_at_period_end") or s.get("cancel_at"))
    customer, user = s.get("customer"), t.license.client
    if isinstance(customer, str) and user is not None and not user.stripe_customer_id:
        user.stripe_customer_id = customer
    until = paid_until(s) if s.get("status") in PAID else None
    if until is not None and (t.stripe_period_end is None or t.stripe_period_end < until):
        t.stripe_period_end = until
        logger.info(f"Hosted terminal {t.id} paid in Stripe ({s['id']}) until {until}")
    if hosting.paid(t, now) and not was_paid:
        t.config_version += 1
        t.updated_at = now
