"""The declared backtest from the Trademetric Dash: kept on the link, shown on the listing when its manager wants
(backtest.py)

Revision ID: 0014_dash_backtest
Revises: 0013_dash_links
Create Date: 2026-10-18
"""
from alembic import op
import sqlalchemy as sa

revision = "0014_dash_backtest"
down_revision = "0013_dash_links"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("dash_links", sa.Column("backtest", sa.Text(), nullable=True))
    op.add_column("dash_links", sa.Column("backtest_fetched_at", sa.DateTime(), nullable=True))
    op.add_column("dash_links", sa.Column("backtest_error", sa.String(300), nullable=True))
    op.add_column("listings", sa.Column("show_backtest", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade():
    op.drop_column("listings", "show_backtest")
    op.drop_column("dash_links", "backtest_error")
    op.drop_column("dash_links", "backtest_fetched_at")
    op.drop_column("dash_links", "backtest")
