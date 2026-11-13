"""Privacy: the version and origin of the accepted terms, closing an account, and the access records.

Revision ID: 0029_privacy
Revises: 0028_checkout_trust
Create Date: 2026-11-13
"""
from alembic import op
import sqlalchemy as sa

revision = "0029_privacy"
down_revision = "0028_checkout_trust"
branch_labels = None
depends_on = None

BigIntPK = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade():
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("terms_version", sa.String(16), nullable=True))
        batch.add_column(sa.Column("terms_ip", sa.String(45), nullable=True))
        batch.add_column(sa.Column("closure_requested_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("closed_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("closed_identity", sa.Text(), nullable=True))
    op.create_table(
        "access_logs",
        sa.Column("id", BigIntPK, primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("event", sa.String(16), nullable=False),
        sa.Column("ip", sa.String(45), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_access_logs_user_id", "access_logs", ["user_id"])
    op.create_index("ix_access_logs_created_at", "access_logs", ["created_at"])


def downgrade():
    op.drop_index("ix_access_logs_created_at", table_name="access_logs")
    op.drop_index("ix_access_logs_user_id", table_name="access_logs")
    op.drop_table("access_logs")
    with op.batch_alter_table("users") as batch:
        for column in ("closed_identity", "closed_at", "closure_requested_at", "terms_ip", "terms_version"):
            batch.drop_column(column)
