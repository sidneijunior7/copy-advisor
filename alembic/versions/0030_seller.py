"""Seller: who sells a trader's portfolios, shown on the portfolio's page and in the checkout.

Revision ID: 0030_seller
Revises: 0029_privacy
Create Date: 2026-11-13
"""
from alembic import op
import sqlalchemy as sa

revision = "0030_seller"
down_revision = "0029_privacy"
branch_labels = None
depends_on = None

COLUMNS = (("seller_name", 120), ("seller_document", 14), ("seller_address", 200), ("seller_email", 255),
           ("analyst_credential", 60))


def upgrade():
    with op.batch_alter_table("users") as batch:
        for name, size in COLUMNS:
            batch.add_column(sa.Column(name, sa.String(size), nullable=True))


def downgrade():
    with op.batch_alter_table("users") as batch:
        for name, _ in reversed(COLUMNS):
            batch.drop_column(name)
