"""The Master account a portfolio copies from, and the positions sent to each portfolio, its track record
(performance.py)

Revision ID: 0015_portfolio_track
Revises: 0014_dash_backtest
Create Date: 2026-10-19
"""
from alembic import op
import sqlalchemy as sa

revision = "0015_portfolio_track"
down_revision = "0014_dash_backtest"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("portfolios", sa.Column("master_login", sa.BigInteger(), nullable=True))
    op.create_table(
        "portfolio_trades",
        sa.Column("id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), primary_key=True),
        sa.Column("portfolio_id", sa.Integer(), sa.ForeignKey("portfolios.id"), nullable=False),
        sa.Column("manager_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("master_login", sa.BigInteger(), nullable=False),
        sa.Column("pos_id", sa.BigInteger(), nullable=False),
        sa.Column("strategy_id", sa.Integer(), sa.ForeignKey("strategies.id"), nullable=False),
        sa.Column("sent_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("portfolio_id", "master_login", "pos_id", name="uq_portfolio_trades_identity"),
    )
    op.create_index("ix_portfolio_trades_portfolio_id", "portfolio_trades", ["portfolio_id"])
    # The positions already sent: the hub sent each one to every portfolio holding its strategy
    op.execute("""
        INSERT INTO portfolio_trades (portfolio_id, manager_id, master_login, pos_id, strategy_id, sent_at)
        SELECT pi.portfolio_id, mp.manager_id, mp.master_login, mp.pos_id, mp.strategy_id, mp.opened_at
        FROM master_positions mp JOIN portfolio_items pi ON pi.strategy_id = mp.strategy_id
        WHERE mp.master_login <> 0 AND mp.opened_at IS NOT NULL
    """)


def downgrade():
    op.drop_index("ix_portfolio_trades_portfolio_id", "portfolio_trades")
    op.drop_table("portfolio_trades")
    op.drop_column("portfolios", "master_login")
