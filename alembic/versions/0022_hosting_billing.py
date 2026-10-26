"""Hosting paid in Stripe: a hosted terminal keeps its own Stripe subscription, apart from the portfolio's, or is
exempt. The terminals hosted before this are exempt, so the deploy turns none of them off.

Revision ID: 0022_hosting_billing
Revises: 0021_stripe
Create Date: 2026-10-26
"""
from alembic import op
import sqlalchemy as sa

revision = "0022_hosting_billing"
down_revision = "0021_stripe"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("hosted_terminals") as batch:
        batch.add_column(sa.Column("exempt", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column("stripe_session_id", sa.String(255), nullable=True))
        batch.add_column(sa.Column("stripe_subscription_id", sa.String(64), nullable=True))
        batch.add_column(sa.Column("stripe_status", sa.String(32), nullable=True))
        batch.add_column(sa.Column("stripe_period_end", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("stripe_cancel_at_period_end", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.create_index("ix_hosted_terminals_stripe_subscription_id", ["stripe_subscription_id"])
    with op.batch_alter_table("hosted_terminals") as batch:  # Only the existing rows are exempt by default
        batch.alter_column("exempt", server_default=sa.false())


def downgrade():
    with op.batch_alter_table("hosted_terminals") as batch:
        batch.drop_index("ix_hosted_terminals_stripe_subscription_id")
        for column in ("stripe_cancel_at_period_end", "stripe_period_end", "stripe_status", "stripe_subscription_id",
                       "stripe_session_id", "exempt"):
            batch.drop_column(column)
