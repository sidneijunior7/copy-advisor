"""Stripe: a listing sells plans, each a recurring Stripe price with its lot limit; a subscription keeps its plan and
Stripe ids, and the client its Stripe customer

Revision ID: 0021_stripe
Revises: 0020_license_pause
Create Date: 2026-10-23
"""
from alembic import op
import sqlalchemy as sa

revision = "0021_stripe"
down_revision = "0020_license_pause"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "listing_plans",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("listing_id", sa.Integer(), sa.ForeignKey("listings.id"), nullable=False, index=True),
        sa.Column("stripe_price_id", sa.String(64), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("max_lots", sa.Float(), nullable=False),
        sa.Column("price", sa.Float(), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("days", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.UniqueConstraint("stripe_price_id", name="uq_listing_plans_stripe_price"),
    )
    with op.batch_alter_table("subscriptions") as batch:
        batch.add_column(sa.Column("plan_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("stripe_session_id", sa.String(255), nullable=True))
        batch.add_column(sa.Column("stripe_subscription_id", sa.String(64), nullable=True))
        batch.add_column(sa.Column("stripe_status", sa.String(32), nullable=True))
        batch.add_column(sa.Column("stripe_period_end", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("stripe_cancel_at_period_end", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.create_foreign_key("fk_subscriptions_plan", "listing_plans", ["plan_id"], ["id"])
        batch.create_index("ix_subscriptions_stripe_subscription", ["stripe_subscription_id"])
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("stripe_customer_id", sa.String(64), nullable=True))


def downgrade():
    with op.batch_alter_table("users") as batch:
        batch.drop_column("stripe_customer_id")
    with op.batch_alter_table("subscriptions") as batch:
        batch.drop_index("ix_subscriptions_stripe_subscription")
        batch.drop_constraint("fk_subscriptions_plan", type_="foreignkey")
        for column in ("stripe_cancel_at_period_end", "stripe_period_end", "stripe_status", "stripe_subscription_id",
                       "stripe_session_id", "plan_id"):
            batch.drop_column(column)
    op.drop_table("listing_plans")
