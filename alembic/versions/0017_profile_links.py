"""YouTube and Instagram links on a manager's public profile (marketplace.py)

Revision ID: 0017_profile_links
Revises: 0016_incubation_trades
Create Date: 2026-10-20
"""
from alembic import op
import sqlalchemy as sa

revision = "0017_profile_links"
down_revision = "0016_incubation_trades"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("youtube_url", sa.String(255), nullable=True))
    op.add_column("users", sa.Column("instagram_url", sa.String(255), nullable=True))


def downgrade():
    op.drop_column("users", "instagram_url")
    op.drop_column("users", "youtube_url")
