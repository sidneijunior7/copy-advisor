"""Checkout trust and recovery: another broker by name, the terms and the risk accepted, and the checkout leads.

Revision ID: 0028_checkout_trust
Revises: 0027_checkout_flow
Create Date: 2026-11-13
"""
from alembic import op
import sqlalchemy as sa

revision = "0028_checkout_trust"
down_revision = "0027_checkout_flow"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("broker_other", sa.String(60), nullable=True))
        batch.add_column(sa.Column("terms_accepted_at", sa.DateTime(), nullable=True))
    with op.batch_alter_table("subscriptions") as batch:
        batch.add_column(sa.Column("risk_ack_at", sa.DateTime(), nullable=True))
    op.create_table(
        "checkout_leads",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("listing_id", sa.Integer(), sa.ForeignKey("listings.id"), nullable=False),
        sa.Column("lots", sa.Float(), nullable=True),
        sa.Column("wants_hosting", sa.Boolean(), nullable=True),
        sa.Column("step", sa.String(32), nullable=True),
        sa.Column("token", sa.String(64), nullable=False),
        sa.Column("reminders", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.Column("converted_at", sa.DateTime(), nullable=True),
        sa.Column("stopped_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("email", "listing_id", name="uq_checkout_leads_email_listing"),
        sa.UniqueConstraint("token", name="uq_checkout_leads_token"),
    )
    op.create_index("ix_checkout_leads_email", "checkout_leads", ["email"])


def downgrade():
    op.drop_index("ix_checkout_leads_email", table_name="checkout_leads")
    op.drop_table("checkout_leads")
    with op.batch_alter_table("subscriptions") as batch:
        batch.drop_column("risk_ack_at")
    with op.batch_alter_table("users") as batch:
        batch.drop_column("terms_accepted_at")
        batch.drop_column("broker_other")
