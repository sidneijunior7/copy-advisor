"""hosted_pods and hosted_terminals: client terminals run in our pods (hosting.py)

Revision ID: 0008_hosting
Revises: 0007_zmq_cut
Create Date: 2026-10-18
"""
from alembic import op
import sqlalchemy as sa

revision = "0008_hosting"
down_revision = "0007_zmq_cut"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "hosted_pods",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("key_hash", sa.String(64), nullable=False),
        sa.Column("key_prefix", sa.String(16), nullable=False),
        sa.Column("capacity", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("info", sa.Text()),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("last_seen_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("key_hash", name="uq_hosted_pods_key_hash"),
    )
    op.create_table(
        "hosted_terminals",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("license_id", sa.Integer(), sa.ForeignKey("licenses.id"), nullable=False),
        sa.Column("server", sa.String(64), nullable=False),
        sa.Column("password_enc", sa.Text(), nullable=False),
        sa.Column("license_key_enc", sa.Text(), nullable=False),
        sa.Column("inputs", sa.Text()),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("config_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("pod_id", sa.Integer(), sa.ForeignKey("hosted_pods.id"), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("status_detail", sa.String(255)),
        sa.Column("status_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
        sa.UniqueConstraint("license_id", name="uq_hosted_terminals_license_id"),
    )
    op.create_index("ix_hosted_terminals_pod_id", "hosted_terminals", ["pod_id"])


def downgrade():
    op.drop_index("ix_hosted_terminals_pod_id", table_name="hosted_terminals")
    op.drop_table("hosted_terminals")
    op.drop_table("hosted_pods")
