"""Credential check: the platform checks a trader's analyst credential before it publishes a portfolio.

Revision ID: 0031_credential
Revises: 0030_seller
Create Date: 2026-11-13
"""
from alembic import op
import sqlalchemy as sa

revision = "0031_credential"
down_revision = "0030_seller"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("credential_status", sa.String(16), nullable=True))
        batch.add_column(sa.Column("credential_checked_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("credential_checked_by", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("credential_note", sa.String(255), nullable=True))


def downgrade():
    with op.batch_alter_table("users") as batch:
        for column in ("credential_note", "credential_checked_by", "credential_checked_at", "credential_status"):
            batch.drop_column(column)
