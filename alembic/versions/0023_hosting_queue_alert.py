"""When the platform's admins were told a paid hosted terminal waits for a pod, so they are told once.

Revision ID: 0023_hosting_queue_alert
Revises: 0022_hosting_billing
Create Date: 2026-10-27
"""
from alembic import op
import sqlalchemy as sa

revision = "0023_hosting_queue_alert"
down_revision = "0022_hosting_billing"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("hosted_terminals") as batch:
        batch.add_column(sa.Column("queue_alerted_at", sa.DateTime(), nullable=True))


def downgrade():
    with op.batch_alter_table("hosted_terminals") as batch:
        batch.drop_column("queue_alerted_at")
