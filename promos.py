"""
Launch codes: a manager gives a portfolio free for some days to whoever has one of its listing's codes.

- A code belongs to one listing. The campaign announces it, so it is no secret: what holds it are a deadline
  (valid_until), a number of uses (max_uses), and that each client gets a portfolio free once, ever. Each MT5
  account too: an account has one license per portfolio, and licenses are never deleted.
- Using a code (redeem) needs a confirmed email, so a throwaway address cannot use up a campaign's uses. It gives
  the client a license with no account yet, at the listing's default lots.
- The free days start when the client connects the MT5 account (start), so setting the EA up costs none of them.
- Before they end the client is emailed (reminders_due) to subscribe. Subscribing in Stripe with free days left
  charges only when they end (payments.checkout); without it the license expires as any other: the copy stops
  opening positions and keeps managing the open ones.
"""
import datetime
import re
import secrets
from typing import Dict, List, Optional, Tuple

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

import clients
import hosting
import models

MAX_CODES = 50  # Per listing
GENERATED_LENGTH = 8  # When the manager leaves the code blank
CODE = re.compile(r"^[A-Z0-9]{4,20}$")
REMIND_BEFORE = (datetime.timedelta(days=5), datetime.timedelta(days=1))  # Each one email, if the free days are longer
WATCH_SECONDS = 3600


class PromoError(Exception):
    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


def normalize(code: Optional[str]) -> str:
    """Case, spaces and dashes do not matter when the client types the code."""
    return re.sub(r"[\s-]", "", code or "").upper()


def generate() -> str:
    return "".join(secrets.choice(clients.CLAIM_ALPHABET) for _ in range(GENERATED_LENGTH))


def _utc_naive(dt: Optional[datetime.datetime]) -> Optional[datetime.datetime]:
    if dt is not None and dt.tzinfo is not None:
        dt = dt.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    return dt


class PromoUpdate(BaseModel):
    label: Optional[str] = Field(default=None, max_length=80, pattern=hosting.ONE_LINE)
    free_days: int = Field(default=30, ge=1, le=365)
    max_uses: Optional[int] = Field(default=None, ge=1, le=100_000)
    valid_until: Optional[datetime.datetime] = None
    active: bool = True


class PromoIn(PromoUpdate):
    code: Optional[str] = Field(default=None, max_length=40)  # Blank: one is generated. It never changes afterwards

    @field_validator("code")
    @classmethod
    def plain_code(cls, v: Optional[str]) -> Optional[str]:
        code = normalize(v)
        if not code:
            return None
        if not CODE.match(code):
            raise ValueError("Use de 4 a 20 letras sem acento ou números")
        return code


class RedeemIn(BaseModel):
    code: str = Field(min_length=1, max_length=40)


# --- The manager's side ---

def usable(promo: models.PromoCode, now: datetime.datetime) -> bool:
    return (bool(promo.active) and (promo.valid_until is None or promo.valid_until > now)
            and (promo.max_uses is None or promo.uses < promo.max_uses))


def promo_out(promo: models.PromoCode, now: datetime.datetime, started: int = 0, subscribed: int = 0) -> dict:
    return {"id": promo.id, "code": promo.code, "label": promo.label, "free_days": promo.free_days,
            "max_uses": promo.max_uses, "uses": promo.uses, "valid_until": promo.valid_until,
            "active": bool(promo.active), "usable": usable(promo, now), "created_at": promo.created_at,
            "started": started, "subscribed": subscribed}


def codes_view(db: Session, listing: models.Listing, now: datetime.datetime) -> List[dict]:
    """The listing's codes, newest first, with how many clients connected an account and how many subscribed."""
    promos = (db.query(models.PromoCode).filter(models.PromoCode.listing_id == listing.id)
              .order_by(models.PromoCode.id.desc()).all())
    ids = [p.id for p in promos]
    R = models.PromoRedemption
    started = dict(db.query(R.promo_code_id, func.count(R.id))
                   .filter(R.promo_code_id.in_(ids), R.started_at.isnot(None)).group_by(R.promo_code_id).all()) if ids else {}
    subscribed = dict(db.query(R.promo_code_id, func.count(func.distinct(R.id)))
                      .join(models.Subscription, models.Subscription.license_id == R.license_id)
                      .filter(R.promo_code_id.in_(ids), models.Subscription.kind == "renewal",
                              models.Subscription.status == "approved")
                      .group_by(R.promo_code_id).all()) if ids else {}
    return [promo_out(p, now, started.get(p.id, 0), subscribed.get(p.id, 0)) for p in promos]


def apply(promo: models.PromoCode, data: PromoUpdate):
    if data.max_uses is not None and data.max_uses < (promo.uses or 0):
        raise PromoError(f"O código já foi usado {promo.uses} vezes: o limite não pode ser menor", 422)
    promo.label = (data.label or "").strip() or None
    promo.free_days = data.free_days
    promo.max_uses = data.max_uses
    promo.valid_until = _utc_naive(data.valid_until)
    promo.active = data.active


def create(db: Session, listing: models.Listing, data: PromoIn, now: datetime.datetime) -> models.PromoCode:
    if db.query(models.PromoCode).filter(models.PromoCode.listing_id == listing.id).count() >= MAX_CODES:
        raise PromoError(f"Até {MAX_CODES} códigos por portfólio: desative ou exclua os antigos")
    code = data.code
    if code is None:  # Generated: a draw that collides with this listing's other codes draws again
        taken = {c for (c,) in db.query(models.PromoCode.code).filter(models.PromoCode.listing_id == listing.id)}
        code = next(c for c in iter(generate, None) if c not in taken)
    promo = models.PromoCode(listing_id=listing.id, code=code, uses=0, created_at=now)
    apply(promo, data)
    db.add(promo)
    return promo


def has_usable(db: Session, listing: models.Listing, now: datetime.datetime) -> bool:
    """Whether the listing's page offers to type a code: says nothing about which."""
    return any(usable(p, now) for p in db.query(models.PromoCode).filter(models.PromoCode.listing_id == listing.id,
                                                                         models.PromoCode.active.is_(True)))


# --- The client's side ---

def redeem(db: Session, listing: models.Listing, user: models.User, code: str, now: datetime.datetime) -> models.License:
    """The license of a code, still without account. Raises PromoError: 404 for a code the listing does not have
    (the caller counts it as a failed guess), 409 for one the client cannot use. The caller commits; two uses at
    once by the same client hit the unique constraint (IntegrityError)."""
    promo = (db.query(models.PromoCode)
             .filter(models.PromoCode.listing_id == listing.id, models.PromoCode.code == normalize(code)).first())
    if promo is None or not promo.active:
        raise PromoError("Código inválido para este portfólio", 404)
    if promo.valid_until is not None and promo.valid_until <= now:
        raise PromoError("Este código já venceu")
    if promo.max_uses is not None and promo.uses >= promo.max_uses:
        raise PromoError("Este código já foi usado o número máximo de vezes")
    if db.query(models.License.id).filter(models.License.portfolio_id == listing.portfolio_id,
                                          models.License.client_user_id == user.id).first():
        raise PromoError("Você já tem uma licença deste portfólio: o código é para quem ainda não copia")
    if db.query(models.PromoRedemption.id).filter(models.PromoRedemption.portfolio_id == listing.portfolio_id,
                                                  models.PromoRedemption.user_id == user.id).first():
        raise PromoError("Você já usou um código deste portfólio")
    # One more use only while below the limit, in one statement: two clients at once cannot both take the last one
    taken = (db.query(models.PromoCode)
             .filter(models.PromoCode.id == promo.id,
                     or_(models.PromoCode.max_uses.is_(None), models.PromoCode.uses < models.PromoCode.max_uses))
             .update({models.PromoCode.uses: models.PromoCode.uses + 1}, synchronize_session=False))
    if not taken:
        raise PromoError("Este código já foi usado o número máximo de vezes")
    # Until the account is connected the days do not run: this expiry gives way to the real one then (start)
    lic = models.License(portfolio_id=listing.portfolio_id, client_mt5_login=None,
                         max_lots=listing.default_max_lots or 1.0, is_active=True, client_user_id=user.id,
                         expires_at=now + datetime.timedelta(days=promo.free_days))
    db.add(lic)
    db.flush()
    db.add(models.Subscription(listing_id=listing.id, client_user_id=user.id, kind="promo", status="approved",
                               license_id=lic.id, created_at=now, decided_at=now))
    db.add(models.PromoRedemption(promo_code_id=promo.id, portfolio_id=listing.portfolio_id, user_id=user.id,
                                  license_id=lic.id, free_days=promo.free_days, created_at=now))
    return lic


def start(db: Session, lic: models.License, now: datetime.datetime) -> bool:
    """The account was just connected: the free days count from now."""
    r = db.query(models.PromoRedemption).filter(models.PromoRedemption.license_id == lic.id).first()
    if r is None or r.started_at is not None:
        return False
    r.started_at = now
    lic.expires_at = now + datetime.timedelta(days=r.free_days)
    return True


def of_licenses(db: Session, license_ids: List[int]) -> Dict[int, dict]:
    """The free days behind each license that came from a code."""
    if not license_ids:
        return {}
    rows = db.query(models.PromoRedemption).filter(models.PromoRedemption.license_id.in_(license_ids)).all()
    return {r.license_id: {"free_days": r.free_days, "started_at": r.started_at,
                           "ends_at": r.started_at + datetime.timedelta(days=r.free_days) if r.started_at else None}
            for r in rows}


def reminders_due(db: Session, now: datetime.datetime) -> List[Tuple[models.PromoRedemption, datetime.timedelta]]:
    """The free days ending soon whose client was not told yet at this distance from the end, and how long is left.
    Marks them told: the caller commits. A license renewed or extended past the free days is not ending."""
    R, L = models.PromoRedemption, models.License
    rows = (db.query(R).join(L, L.id == R.license_id)
            .filter(R.started_at.isnot(None), R.reminders < len(REMIND_BEFORE), L.is_active.is_(True),
                    L.expires_at > now, L.expires_at <= now + max(REMIND_BEFORE)).all())
    due = []
    for r in rows:
        lic = r.license
        if lic.expires_at > r.started_at + datetime.timedelta(days=r.free_days, minutes=1):
            continue
        # A 3-day code gets the last reminder only: one 5 days before would come before it started
        steps = [b for b in REMIND_BEFORE if b < datetime.timedelta(days=r.free_days)]
        reached = sum(1 for b in steps if lic.expires_at - now <= b)
        if reached > r.reminders:
            r.reminders = reached
            due.append((r, lic.expires_at - now))
    return due
