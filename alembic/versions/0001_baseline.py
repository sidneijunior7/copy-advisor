"""Baseline: schema as created by models.py before Alembic (Base.metadata.create_all)

Existing databases are stamped at this revision by migrate.py instead of running it.

Revision ID: 0001_baseline
Revises:
Create Date: 2026-09-15
"""
from alembic import op
import sqlalchemy as sa

revision = "0001_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(255)),
        sa.Column("password_hash", sa.String(255)),
        sa.Column("role", sa.String(50)),
        sa.Column("status", sa.String(20)),
        sa.Column("master_key", sa.String(100), unique=True),
        sa.Column("created_at", sa.DateTime()),
    )
    op.create_index("ix_users_id", "users", ["id"])
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "strategies",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("name", sa.String(100)),
        sa.Column("magic_number", sa.Integer()),
        sa.Column("is_active", sa.Boolean()),
    )
    op.create_index("ix_strategies_id", "strategies", ["id"])

    op.create_table(
        "portfolios",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("name", sa.String(100)),
        sa.Column("public_key", sa.String(100), unique=True),
    )
    op.create_index("ix_portfolios_id", "portfolios", ["id"])

    op.create_table(
        "portfolio_items",
        sa.Column("portfolio_id", sa.Integer(), sa.ForeignKey("portfolios.id"), primary_key=True),
        sa.Column("strategy_id", sa.Integer(), sa.ForeignKey("strategies.id"), primary_key=True),
    )

    op.create_table(
        "licenses",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("portfolio_id", sa.Integer(), sa.ForeignKey("portfolios.id"), nullable=True),
        sa.Column("strategy_id", sa.Integer(), sa.ForeignKey("strategies.id"), nullable=True),
        sa.Column("client_mt5_login", sa.Integer()),
        sa.Column("max_lots", sa.Float()),
        sa.Column("is_active", sa.Boolean()),
        sa.Column("created_at", sa.DateTime()),
    )
    op.create_index("ix_licenses_id", "licenses", ["id"])


def downgrade():
    op.drop_table("licenses")
    op.drop_table("portfolio_items")
    op.drop_table("portfolios")
    op.drop_table("strategies")
    op.drop_table("users")
