"""Add is_paused and paused_at to licenses for subscriber On/Off copy toggle

Revision ID: 0020_license_pause
Revises: 0019_license_account_later
Create Date: 2026-10-21
"""
from alembic import op
import sqlalchemy as sa

revision = "0020_license_pause"
down_revision = "0019_license_account_later"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("licenses") as batch:
        batch.add_column(sa.Column("is_paused", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("paused_at", sa.DateTime(), nullable=True))


def downgrade():
    with op.batch_alter_table("licenses") as batch:
        batch.drop_column("paused_at")
        batch.drop_column("is_paused")
