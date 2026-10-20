"""
Marketplace: a manager publishes a portfolio as a listing; anyone sees the published listings and their real
performance (the Master's deals, performance.py); a client asks for one with its MT5 account, and the manager
approves it, which creates the license already linked to the client, or extends the one it has.

Payment happens outside for now: the listing carries the manager's checkout link (Hotmart, Kiwify...) and the
manager approves once paid. A TDM_DEV can suspend a listing; its manager cannot publish it again.
"""
import datetime
import re
import threading
import time
import unicodedata
from typing import Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import backtest
import followers
import hosting
import models
import performance

MARKETS = ("B3", "Forex", "Cripto", "Índices", "Commodities")
PUBLIC_DAYS = 90  # The period the catalog shows
CACHE_SECONDS = 300  # Public performance is computed at most this often per listing and period
MAX_PENDING_PER_CLIENT = 10
CURVE_POINTS = 40  # Sparkline of a catalog card

SLUG = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"


class ListingIn(BaseModel):
    title: str = Field(min_length=3, max_length=80, pattern=hosting.ONE_LINE)
    slug: Optional[str] = Field(default=None, min_length=3, max_length=80, pattern=SLUG)
    summary: Optional[str] = Field(default=None, max_length=200, pattern=hosting.ONE_LINE)
    description: Optional[str] = Field(default=None, max_length=5000)
    markets: List[Literal["B3", "Forex", "Cripto", "Índices", "Commodities"]] = Field(default_factory=list, max_length=5)
    price: Optional[float] = Field(default=None, ge=0, le=1_000_000)
    currency: Literal["BRL", "USD"] = "BRL"
    checkout_url: Optional[str] = Field(default=None, max_length=500, pattern=r"^https://[^\s<>\"']+$")
    default_days: int = Field(default=30, ge=1, le=3650)
    default_max_lots: float = Field(default=1.0, gt=0, le=1000)
    min_capital: Optional[float] = Field(default=None, ge=0, le=1_000_000_000)
    hosting_allowed: bool = True
    show_backtest: bool = False  # The declared backtest from a linked Trademetric Dash portfolio


class SubscriptionIn(BaseModel):
    mt5_login: int = Field(gt=0, le=10**12)
    note: Optional[str] = Field(default=None, max_length=500)


class Decision(BaseModel):
    note: Optional[str] = Field(default=None, max_length=500)
    max_lots: Optional[float] = Field(default=None, gt=0, le=1000)  # Default: the listing's
    days: Optional[int] = Field(default=None, ge=1, le=3650)


# The profile links go only where their icon says
YOUTUBE_URL = r"^https://(www\.|m\.)?(youtube\.com|youtu\.be)/[^\s<>\"']+$"
INSTAGRAM_URL = r"^https://(www\.)?instagram\.com/[^\s<>\"']+$"


class Profile(BaseModel):
    name: str = Field(min_length=1, max_length=100, pattern=hosting.ONE_LINE)
    bio: Optional[str] = Field(default=None, max_length=2000)
    youtube_url: Optional[str] = Field(default=None, max_length=255, pattern=YOUTUBE_URL)
    instagram_url: Optional[str] = Field(default=None, max_length=255, pattern=INSTAGRAM_URL)


def slugify(text: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")
    return slug[:80].strip("-") or "portfolio"


def unique_slug(db: Session, wanted: str, listing_id: Optional[int]) -> str:
    slug, n = wanted, 1
    while True:
        other = db.query(models.Listing.id).filter(models.Listing.slug == slug).first()
        if other is None or other[0] == listing_id:
            return slug
        n += 1
        suffix = f"-{n}"
        slug = wanted[:80 - len(suffix)] + suffix


def apply(listing: models.Listing, data: ListingIn, slug: str, now: datetime.datetime):
    listing.title = data.title.strip()
    listing.slug = slug
    listing.summary = (data.summary or "").strip() or None
    listing.description = (data.description or "").replace("\x00", "").strip() or None
    listing.markets = ",".join(data.markets)
    listing.price = data.price
    listing.currency = data.currency
    listing.checkout_url = data.checkout_url
    listing.default_days = data.default_days
    listing.default_max_lots = data.default_max_lots
    listing.min_capital = data.min_capital
    listing.hosting_allowed = data.hosting_allowed
    listing.show_backtest = data.show_backtest
    listing.updated_at = now


def listing_out(listing: models.Listing) -> dict:
    """Everything about a listing: what its manager edits, and the public view starts from."""
    return {
        "id": listing.id, "portfolio_id": listing.portfolio_id, "slug": listing.slug, "title": listing.title,
        "summary": listing.summary, "description": listing.description,
        "markets": [m for m in (listing.markets or "").split(",") if m],
        "price": listing.price, "currency": listing.currency or "BRL", "checkout_url": listing.checkout_url,
        "default_days": listing.default_days, "default_max_lots": listing.default_max_lots,
        "min_capital": listing.min_capital, "hosting_allowed": bool(listing.hosting_allowed),
        "show_backtest": bool(listing.show_backtest), "status": listing.status, "suspended_reason": listing.suspended_reason,
        "published_at": listing.published_at, "updated_at": listing.updated_at,
    }


def manager_profile(listing: models.Listing) -> dict:
    owner = listing.portfolio.owner if listing.portfolio else None
    return {"name": (owner.name if owner else None) or "Gestor", "bio": owner.bio if owner else None,
            "youtube_url": owner.youtube_url if owner else None, "instagram_url": owner.instagram_url if owner else None}


# --- Public performance, cached: the catalog must not compute every listing on every visit ---

_cache: Dict[Tuple[str, int, int], Tuple[float, dict]] = {}
_cache_lock = threading.Lock()


def _cached(key: Tuple[str, int, int], compute) -> dict:
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
    value = compute()
    with _cache_lock:
        if len(_cache) > 2000:
            _cache.clear()
        _cache[key] = (time.monotonic() + CACHE_SECONDS, value)
    return value


def public_performance(db: Session, listing: models.Listing, days: int, now: datetime.datetime) -> dict:
    def compute():
        # Which account it copies from is the manager's business, and the trades from before the Mirror are unverified
        out = performance.portfolio(db, listing.portfolio, days, now)
        return {k: v for k, v in out.items() if k not in ("master_login", "before_mirror")}
    return _cached(("performance", listing.id, days), compute)


def public_backtest(db: Session, listing: models.Listing, days: int, now: datetime.datetime) -> dict:
    """The declared backtest and the cone, when the manager chose to show them."""
    def compute():
        if not listing.show_backtest:
            return {"available": False}
        link = db.query(models.DashLink).filter(models.DashLink.portfolio_id == listing.portfolio_id).first()
        return backtest.view(db, listing.portfolio, link, days, now, seed=listing.id)
    return _cached(("backtest", listing.id, days), compute)


def public_followers(db: Session, listing: models.Listing, days: int, now: datetime.datetime) -> dict:
    return _cached(("followers", listing.id, days),
                   lambda: followers.public(followers.portfolio(db, listing.portfolio, days, now)))


def clear_cache():
    with _cache_lock:
        _cache.clear()


def public_assets(db: Session, listing: models.Listing, now: datetime.datetime) -> List[str]:
    """The assets of the catalog card. The catalog compares the result per lot within an asset: a lot of WIN and one
    of WDO are not the same size."""
    start = performance.since(PUBLIC_DAYS, now)
    return _cached(("assets", listing.id, PUBLIC_DAYS), lambda: {"list": performance.assets(db, listing.portfolio, start)})["list"]


def summary(stats: dict) -> dict:
    """What a catalog card shows."""
    curve = stats["curve"]
    step = max(1, len(curve) // CURVE_POINTS)
    points = curve[::step]
    if curve and points[-1] is not curve[-1]:
        points.append(curve[-1])
    return {k: stats[k] for k in ("currency", "trades", "win_rate", "net", "return_pct", "max_drawdown_pct",
                                  "profit_factor", "per_lot")} | {"curve": [p["v"] for p in points]}


def public_listing(db: Session, listing: models.Listing, now: datetime.datetime) -> dict:
    out = {k: v for k, v in listing_out(listing).items()
           if k not in ("portfolio_id", "status", "suspended_reason", "default_max_lots")}
    out["manager"] = manager_profile(listing)
    out["strategies"] = [s.name for s in listing.portfolio.strategies] if listing.portfolio else []
    out["stats"] = summary(public_performance(db, listing, PUBLIC_DAYS, now))
    out["stats"]["assets"] = public_assets(db, listing, now)
    return out


# --- Subscriptions ---

def subscription_out(s: models.Subscription, for_manager: bool) -> dict:
    out = {
        "id": s.id, "listing": {"id": s.listing_id, "slug": s.listing.slug, "title": s.listing.title,
                                "checkout_url": s.listing.checkout_url, "price": s.listing.price,
                                "currency": s.listing.currency or "BRL", "default_days": s.listing.default_days},
        "mt5_login": s.mt5_login, "kind": s.kind, "status": s.status, "note": s.note,
        "decision_note": s.decision_note, "license_id": s.license_id, "created_at": s.created_at,
        "decided_at": s.decided_at,
    }
    if for_manager:
        out["client"] = {"name": s.client.name, "email": s.client.email}
    return out


def approve(db: Session, sub: models.Subscription, decision: Decision, now: datetime.datetime) -> models.License:
    """Creates the license for the client's account, or extends the one it has from its current expiry (or from
    now, if already expired). Either way it ends up active and linked to the client."""
    listing = sub.listing
    days = decision.days or listing.default_days or 30
    max_lots = decision.max_lots or listing.default_max_lots or 1.0
    lic = (db.query(models.License)
           .filter(models.License.portfolio_id == listing.portfolio_id,
                   models.License.client_mt5_login == sub.mt5_login).first())
    if lic is None:
        lic = models.License(portfolio_id=listing.portfolio_id, client_mt5_login=sub.mt5_login, max_lots=max_lots,
                             is_active=True, expires_at=now + datetime.timedelta(days=days),
                             client_user_id=sub.client_user_id)
        db.add(lic)
        db.flush()
    else:
        start = lic.expires_at if lic.expires_at and lic.expires_at > now else now
        lic.expires_at = start + datetime.timedelta(days=days)
        lic.is_active, lic.revoked_at = True, None
        lic.max_lots = max_lots
        lic.client_user_id = sub.client_user_id
    sub.status, sub.license_id, sub.decided_at = "approved", lic.id, now
    sub.decision_note = (decision.note or "").strip() or None
    return lic
