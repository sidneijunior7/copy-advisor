"""A license may exist without the MT5 account until the client connects it (0018). The legacy Supabase schema
created licenses.client_mt5_login NOT NULL; Alembic's baseline never had it

Revision ID: 0019_license_account_later
Revises: 0018_subscription_account_later
Create Date: 2026-10-20
"""
from alembic import op
import sqlalchemy as sa

revision = "0019_license_account_later"
down_revision = "0018_subscription_account_later"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("licenses") as batch:
        batch.alter_column("client_mt5_login", existing_type=sa.BigInteger(), nullable=True)


def downgrade():
    pass  # Only the legacy schema had NOT NULL, and licenses without an account may exist by now
