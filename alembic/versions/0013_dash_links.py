"""Bridge to the Trademetric Dash: a portfolio's link to a Dash portfolio (dash_bridge.py)

Revision ID: 0013_dash_links
Revises: 0012_follower_stats
Create Date: 2026-10-18
"""
from alembic import op
import sqlalchemy as sa

revision = "0013_dash_links"
down_revision = "0012_follower_stats"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "dash_links",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("portfolio_id", sa.Integer(), sa.ForeignKey("portfolios.id"), nullable=False),
        sa.Column("token_encrypted", sa.Text(), nullable=False),
        sa.Column("token_hint", sa.String(8)),
        sa.Column("deal_cursor", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("send_since", sa.DateTime(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("last_error", sa.String(300)),
        sa.Column("last_attempt_at", sa.DateTime()),
        sa.Column("last_sent_at", sa.DateTime()),
        sa.Column("sent_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime()),
        sa.UniqueConstraint("portfolio_id", name="uq_dash_links_portfolio"),
    )


def downgrade():
    op.drop_table("dash_links")
