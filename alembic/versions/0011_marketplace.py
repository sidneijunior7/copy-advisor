"""Marketplace: listings, subscription requests, one-time email tokens, a manager's public bio, the time a
password changed (sessions begun before it end)

Revision ID: 0011_marketplace
Revises: 0010_results
Create Date: 2026-10-18
"""
from alembic import op
import sqlalchemy as sa

revision = "0011_marketplace"
down_revision = "0010_results"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("bio", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("password_changed_at", sa.DateTime(), nullable=True))
    op.create_table(
        "listings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("portfolio_id", sa.Integer(), sa.ForeignKey("portfolios.id"), nullable=False),
        sa.Column("slug", sa.String(80), nullable=False),
        sa.Column("title", sa.String(80), nullable=False),
        sa.Column("summary", sa.String(200)),
        sa.Column("description", sa.Text()),
        sa.Column("markets", sa.String(100)),
        sa.Column("price", sa.Float()),
        sa.Column("currency", sa.String(3)),
        sa.Column("checkout_url", sa.String(500)),
        sa.Column("default_days", sa.Integer()),
        sa.Column("default_max_lots", sa.Float()),
        sa.Column("min_capital", sa.Float()),
        sa.Column("hosting_allowed", sa.Boolean()),
        sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
        sa.Column("suspended_reason", sa.String(255)),
        sa.Column("published_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
        sa.UniqueConstraint("portfolio_id", name="uq_listings_portfolio"),
        sa.UniqueConstraint("slug", name="uq_listings_slug"),
    )
    op.create_table(
        "subscriptions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("listing_id", sa.Integer(), sa.ForeignKey("listings.id"), nullable=False),
        sa.Column("client_user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("mt5_login", sa.BigInteger(), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False, server_default="new"),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("note", sa.String(500)),
        sa.Column("decision_note", sa.String(500)),
        sa.Column("license_id", sa.Integer(), sa.ForeignKey("licenses.id"), nullable=True),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("decided_at", sa.DateTime()),
    )
    op.create_index("ix_subscriptions_listing_status", "subscriptions", ["listing_id", "status"])
    op.create_index("ix_subscriptions_client_user_id", "subscriptions", ["client_user_id"])
    op.create_table(
        "user_tokens",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("used_at", sa.DateTime()),
        sa.Column("created_at", sa.DateTime()),
        sa.UniqueConstraint("token_hash", name="uq_user_tokens_hash"),
    )
    op.create_index("ix_user_tokens_user_id", "user_tokens", ["user_id"])


def downgrade():
    op.drop_index("ix_user_tokens_user_id", table_name="user_tokens")
    op.drop_table("user_tokens")
    op.drop_index("ix_subscriptions_client_user_id", table_name="subscriptions")
    op.drop_index("ix_subscriptions_listing_status", table_name="subscriptions")
    op.drop_table("subscriptions")
    op.drop_table("listings")
    with op.batch_alter_table("users") as batch:
        batch.drop_column("password_changed_at")
        batch.drop_column("bio")
