"""Disable the admin passwords that were committed to Git (seed_superuser and create_admin.py)

Removing them from the code does not revoke them: any account still using one is locked
until a new password is set with `python create_admin.py <email>`.

Revision ID: 0003_revoke_leaked_passwords
Revises: 0002_signals
Create Date: 2026-09-22
"""
from alembic import op
import sqlalchemy as sa
from passlib.context import CryptContext

revision = "0003_revoke_leaked_passwords"
down_revision = "0002_signals"
branch_labels = None
depends_on = None

LEAKED_PASSWORDS = ["tdmdev123", "Trademetric2026!"]
SEEDED_EMAILS = ["dev@trademetric.com", "trademetric@trademetric.com.br"]
DISABLED_HASH = "!disabled:leaked-credential"


def upgrade():
    conn = op.get_bind()
    users = sa.table("users", sa.column("id"), sa.column("email"), sa.column("role"), sa.column("password_hash"))
    # Every hash in this database so far is sha256_crypt (~0.3 s per check): only look at admin accounts
    rows = conn.execute(
        sa.select(users.c.id, users.c.password_hash)
        .where(sa.or_(users.c.role == "TDM_DEV", users.c.email.in_(SEEDED_EMAILS)))
    ).all()
    legacy = CryptContext(schemes=["sha256_crypt"])
    for user_id, password_hash in rows:
        if not password_hash or not legacy.identify(password_hash):
            continue
        if any(legacy.verify(p, password_hash) for p in LEAKED_PASSWORDS):
            conn.execute(users.update().where(users.c.id == user_id).values(password_hash=DISABLED_HASH))


def downgrade():
    pass  # The old passwords are public; they are never restored
