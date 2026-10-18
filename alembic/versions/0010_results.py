"""Results: profit on the Slave's execution reports, the Master's deals, hourly balance and equity of both

Revision ID: 0010_results
Revises: 0009_client_accounts
Create Date: 2026-10-18
"""
from alembic import op
import sqlalchemy as sa

revision = "0010_results"
down_revision = "0009_client_accounts"
branch_labels = None
depends_on = None

BigIntPK = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade():
    op.add_column("executions", sa.Column("profit", sa.Float(), nullable=True))
    op.create_table(
        "master_deals",
        sa.Column("id", BigIntPK, primary_key=True),
        sa.Column("manager_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("master_login", sa.BigInteger(), nullable=False),
        sa.Column("deal_id", sa.BigInteger(), nullable=False),
        sa.Column("pos_id", sa.BigInteger(), nullable=False),
        sa.Column("entry", sa.Integer(), nullable=False),
        sa.Column("type", sa.Integer(), nullable=False),
        sa.Column("symbol", sa.String(64)),
        sa.Column("magic", sa.BigInteger()),
        sa.Column("volume", sa.Float()),
        sa.Column("price", sa.Float()),
        sa.Column("profit", sa.Float()),
        sa.Column("swap", sa.Float()),
        sa.Column("commission", sa.Float()),
        sa.Column("time", sa.DateTime(), nullable=False),
        sa.Column("received_at", sa.DateTime()),
        sa.UniqueConstraint("manager_id", "master_login", "deal_id", name="uq_master_deals_identity"),
    )
    op.create_index("ix_master_deals_position", "master_deals", ["manager_id", "master_login", "pos_id"])
    op.create_index("ix_master_deals_time", "master_deals", ["manager_id", "time"])
    op.create_table(
        "account_snapshots",
        sa.Column("id", BigIntPK, primary_key=True),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("owner_id", sa.Integer(), nullable=False),
        sa.Column("login", sa.BigInteger(), nullable=False),
        sa.Column("hour", sa.DateTime(), nullable=False),
        sa.Column("balance", sa.Float()),
        sa.Column("equity", sa.Float()),
        sa.Column("currency", sa.String(8)),
        sa.Column("updated_at", sa.DateTime()),
        sa.UniqueConstraint("kind", "owner_id", "login", "hour", name="uq_account_snapshots_hour"),
    )
    op.create_index("ix_account_snapshots_series", "account_snapshots", ["kind", "owner_id", "hour"])


def downgrade():
    op.drop_index("ix_account_snapshots_series", table_name="account_snapshots")
    op.drop_table("account_snapshots")
    op.drop_index("ix_master_deals_time", table_name="master_deals")
    op.drop_index("ix_master_deals_position", table_name="master_deals")
    op.drop_table("master_deals")
    with op.batch_alter_table("executions") as batch:
        batch.drop_column("profit")
