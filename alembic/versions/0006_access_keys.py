"""master_keys and per-license Slave keys (only hashes are stored), license expiry

Every existing users.master_key becomes the manager's first master key, so Masters already
configured keep working. users.master_key stays (no longer read) until the ZMQ cut. The copies of
those keys that signals.raw kept are stripped.

Revision ID: 0006_access_keys
Revises: 0005_master_accounts
Create Date: 2026-10-15
"""
import datetime
import hashlib

from alembic import op
import sqlalchemy as sa

revision = "0006_access_keys"
down_revision = "0005_master_accounts"
branch_labels = None
depends_on = None


def upgrade():
    master_keys = op.create_table(
        "master_keys",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("label", sa.String(64), nullable=False),
        sa.Column("key_hash", sa.String(64), nullable=False),
        sa.Column("key_prefix", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("key_hash", name="uq_master_keys_key_hash"),
    )
    op.create_index("ix_master_keys_user_id", "master_keys", ["user_id"])

    now = datetime.datetime.utcnow()
    users = op.get_bind().execute(sa.text("SELECT id, master_key FROM users WHERE master_key IS NOT NULL")).fetchall()
    rows = [{"user_id": uid, "label": "Chave anterior", "key_hash": hashlib.sha256(key.encode()).hexdigest(),
             "key_prefix": key[:8], "created_at": now} for uid, key in users if key]
    if rows:
        op.bulk_insert(master_keys, rows)

    # signals.raw kept the whole ZMQ message, Master key included: keep only what follows the key
    find = "strpos(raw, '|')" if op.get_bind().dialect.name == "postgresql" else "instr(raw, '|')"
    op.execute(f"UPDATE signals SET raw = substr(raw, {find} + 1) WHERE raw IS NOT NULL AND {find} > 0")

    op.add_column("licenses", sa.Column("key_hash", sa.String(64), nullable=True))
    op.add_column("licenses", sa.Column("key_prefix", sa.String(16), nullable=True))
    op.add_column("licenses", sa.Column("expires_at", sa.DateTime(), nullable=True))
    op.add_column("licenses", sa.Column("revoked_at", sa.DateTime(), nullable=True))
    op.get_bind().execute(sa.text("UPDATE licenses SET revoked_at = :now WHERE is_active = :no"), {"now": now, "no": False})
    # A unique index rather than a constraint: SQLite can't add a constrained column in place
    op.create_index("ix_licenses_key_hash", "licenses", ["key_hash"], unique=True)


def downgrade():
    op.drop_index("ix_licenses_key_hash", table_name="licenses")
    with op.batch_alter_table("licenses") as batch:
        batch.drop_column("revoked_at")
        batch.drop_column("expires_at")
        batch.drop_column("key_prefix")
        batch.drop_column("key_hash")
    op.drop_index("ix_master_keys_user_id", table_name="master_keys")
    op.drop_table("master_keys")
