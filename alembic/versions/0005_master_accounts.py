"""master_accounts: trade mode, server and broker of each Master account (V2HELLO)

Revision ID: 0005_master_accounts
Revises: 0004_execution_latency
Create Date: 2026-10-14
"""
from alembic import op
import sqlalchemy as sa

revision = "0005_master_accounts"
down_revision = "0004_execution_latency"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "master_accounts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("manager_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("master_login", sa.BigInteger(), nullable=False),
        sa.Column("trade_mode", sa.String(16), nullable=False),
        sa.Column("server", sa.String(64)),
        sa.Column("company", sa.String(128)),
        sa.Column("first_seen_at", sa.DateTime()),
        sa.Column("last_seen_at", sa.DateTime()),
        sa.UniqueConstraint("manager_id", "master_login", name="uq_master_accounts_identity"),
    )


def downgrade():
    op.drop_table("master_accounts")
