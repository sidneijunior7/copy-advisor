"""executions.latency_ms: hub publishing a position state -> slave reporting its execution

Revision ID: 0004_execution_latency
Revises: 0003_revoke_leaked_passwords
Create Date: 2026-09-30
"""
from alembic import op
import sqlalchemy as sa

revision = "0004_execution_latency"
down_revision = "0003_revoke_leaked_passwords"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("executions", sa.Column("latency_ms", sa.Integer(), nullable=True))


def downgrade():
    with op.batch_alter_table("executions") as batch:
        batch.drop_column("latency_ms")
