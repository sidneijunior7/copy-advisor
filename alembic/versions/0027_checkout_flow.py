"""Checkout wizard: client CPF, homologated broker and advisor on users; hosting choice on subscriptions.

Revision ID: 0027_checkout_flow
Revises: 0026_promo_codes
Create Date: 2026-11-12
"""
from alembic import op
import sqlalchemy as sa

revision = "0027_checkout_flow"
down_revision = "0026_promo_codes"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("users") as batch:
        batch.add_column(sa.Column("cpf", sa.String(11), nullable=True))
        batch.add_column(sa.Column("broker", sa.String(32), nullable=True))
        batch.add_column(sa.Column("advisor", sa.String(120), nullable=True))
        batch.add_column(sa.Column("advisor_unknown", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.create_index("ix_users_cpf", ["cpf"], unique=True)
    with op.batch_alter_table("subscriptions") as batch:
        batch.add_column(sa.Column("wants_hosting", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade():
    with op.batch_alter_table("subscriptions") as batch:
        batch.drop_column("wants_hosting")
    with op.batch_alter_table("users") as batch:
        batch.drop_index("ix_users_cpf")
        for column in ("advisor_unknown", "advisor", "broker", "cpf"):
            batch.drop_column(column)

