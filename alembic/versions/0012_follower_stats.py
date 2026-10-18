"""Followers' figures in the marketplace: the executions of a portfolio by time (followers.py reads them per
portfolio and period)

Revision ID: 0012_follower_stats
Revises: 0011_marketplace
Create Date: 2026-10-18
"""
from alembic import op

revision = "0012_follower_stats"
down_revision = "0011_marketplace"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index("ix_executions_portfolio_created", "executions", ["portfolio_id", "created_at"])


def downgrade():
    op.drop_index("ix_executions_portfolio_created", table_name="executions")
