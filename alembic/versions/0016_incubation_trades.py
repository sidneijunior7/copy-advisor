"""The Dash live tracking frozen as each portfolio's homologation, and the portfolio's cursor on it (dash_bridge.py)

Revision ID: 0016_incubation_trades
Revises: 0015_portfolio_track
Create Date: 2026-10-19
"""
from alembic import op
import sqlalchemy as sa

revision = "0016_incubation_trades"
down_revision = "0015_portfolio_track"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("portfolios", sa.Column("incubation_cursor", sa.String(40), nullable=True))
    op.create_table(
        "incubation_trades",
        sa.Column("id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), primary_key=True),
        sa.Column("portfolio_id", sa.Integer(), sa.ForeignKey("portfolios.id"), nullable=False),
        sa.Column("dash_id", sa.String(64), nullable=False),
        sa.Column("strategy", sa.String(64)),
        sa.Column("account_login", sa.String(20)),
        sa.Column("traded_at", sa.DateTime(), nullable=False),
        sa.Column("recorded_at", sa.DateTime()),
        sa.Column("pnl", sa.Float(), nullable=False),
        sa.Column("lots", sa.Float()),
        sa.Column("verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("received_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("portfolio_id", "dash_id", name="uq_incubation_trades_identity"),
    )
    op.create_index("ix_incubation_trades_portfolio_id", "incubation_trades", ["portfolio_id"])


def downgrade():
    op.drop_index("ix_incubation_trades_portfolio_id", "incubation_trades")
    op.drop_table("incubation_trades")
    op.drop_column("portfolios", "incubation_cursor")
