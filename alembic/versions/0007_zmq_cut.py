"""ZMQ cut: drop the legacy keys and revoke every Master key created before it

users.master_key (the plain-text Master key that 0006 adopted into master_keys) and
portfolios.public_key (the key of the v3 Slave) are no longer read by anything. A Master key that
existed before the cut may have crossed the open ZMQ port in clear, so all of them are revoked:
each manager creates new ones in the dashboard.

Revision ID: 0007_zmq_cut
Revises: 0006_access_keys
Create Date: 2026-10-17
"""
import datetime

from alembic import op
import sqlalchemy as sa

revision = "0007_zmq_cut"
down_revision = "0006_access_keys"
branch_labels = None
depends_on = None


def upgrade():
    op.get_bind().execute(sa.text("UPDATE master_keys SET revoked_at = :now WHERE revoked_at IS NULL"),
                          {"now": datetime.datetime.utcnow()})
    with op.batch_alter_table("users") as batch:
        batch.drop_column("master_key")
    with op.batch_alter_table("portfolios") as batch:
        batch.drop_column("public_key")


def downgrade():
    # The columns come back empty, and the revoked keys stay revoked
    with op.batch_alter_table("portfolios") as batch:
        batch.add_column(sa.Column("public_key", sa.String(100), nullable=True))
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("master_key", sa.String(100), nullable=True))
