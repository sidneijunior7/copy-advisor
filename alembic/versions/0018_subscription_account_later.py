"""A subscription may come without the MT5 account: the client connects it on the license after paying

Revision ID: 0018_subscription_account_later
Revises: 0017_profile_links
Create Date: 2026-10-20
"""
from alembic import op
import sqlalchemy as sa

revision = "0018_subscription_account_later"
down_revision = "0017_profile_links"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("subscriptions") as batch:
        batch.alter_column("mt5_login", existing_type=sa.BigInteger(), nullable=True)


def downgrade():
    op.execute("DELETE FROM subscriptions WHERE mt5_login IS NULL")
    with op.batch_alter_table("subscriptions") as batch:
        batch.alter_column("mt5_login", existing_type=sa.BigInteger(), nullable=False)
