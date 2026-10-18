"""Client accounts: licenses linked to a client user by an access code, Slave settings on the license, limits a
portfolio puts on what its clients may set, user name and email verification

The Slave inputs a hosted terminal had (hosted_terminals.inputs) move to licenses.settings, which every Slave of
the license follows from now on.

Revision ID: 0009_client_accounts
Revises: 0008_hosting
Create Date: 2026-10-18
"""
from alembic import op
import sqlalchemy as sa

revision = "0009_client_accounts"
down_revision = "0008_hosting"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("name", sa.String(100), nullable=True))
    op.add_column("users", sa.Column("email_verified_at", sa.DateTime(), nullable=True))
    op.add_column("portfolios", sa.Column("client_limits", sa.Text(), nullable=True))
    # Batch mode: SQLite cannot add a foreign key in place
    with op.batch_alter_table("licenses") as batch:
        batch.add_column(sa.Column("client_user_id", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("claim_hash", sa.String(64), nullable=True))
        batch.add_column(sa.Column("claim_expires_at", sa.DateTime(), nullable=True))
        batch.add_column(sa.Column("settings", sa.Text(), nullable=True))
        batch.create_foreign_key("fk_licenses_client_user_id", "users", ["client_user_id"], ["id"])
    op.create_index("ix_licenses_client_user_id", "licenses", ["client_user_id"])
    op.create_index("ix_licenses_claim_hash", "licenses", ["claim_hash"], unique=True)

    bind = op.get_bind()
    # Accounts that exist were created by an administrator: their email counts as checked
    bind.execute(sa.text("UPDATE users SET email_verified_at = COALESCE(created_at, CURRENT_TIMESTAMP)"))
    rows = bind.execute(sa.text("SELECT license_id, inputs FROM hosted_terminals "
                                "WHERE inputs IS NOT NULL AND inputs <> '{}'")).fetchall()
    for license_id, inputs in rows:
        bind.execute(sa.text("UPDATE licenses SET settings = :s WHERE id = :id"), {"s": inputs, "id": license_id})


def downgrade():
    op.drop_index("ix_licenses_claim_hash", table_name="licenses")
    op.drop_index("ix_licenses_client_user_id", table_name="licenses")
    with op.batch_alter_table("licenses") as batch:
        batch.drop_constraint("fk_licenses_client_user_id", type_="foreignkey")
        batch.drop_column("settings")
        batch.drop_column("claim_expires_at")
        batch.drop_column("claim_hash")
        batch.drop_column("client_user_id")
    with op.batch_alter_table("portfolios") as batch:
        batch.drop_column("client_limits")
    with op.batch_alter_table("users") as batch:
        batch.drop_column("email_verified_at")
        batch.drop_column("name")
