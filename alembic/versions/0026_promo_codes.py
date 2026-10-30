"""Launch codes: a listing's codes for some free days, and the free days each client got, once per portfolio.

Revision ID: 0026_promo_codes
Revises: 0025_education_images
Create Date: 2026-10-30
"""
from alembic import op
import sqlalchemy as sa

revision = "0026_promo_codes"
down_revision = "0025_education_images"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "promo_codes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("listing_id", sa.Integer(), sa.ForeignKey("listings.id"), nullable=False),
        sa.Column("code", sa.String(24), nullable=False),
        sa.Column("label", sa.String(80)),
        sa.Column("free_days", sa.Integer(), nullable=False),
        sa.Column("max_uses", sa.Integer()),
        sa.Column("uses", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("valid_until", sa.DateTime()),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime()),
        sa.UniqueConstraint("listing_id", "code", name="uq_promo_codes_listing_code"),
    )
    op.create_index("ix_promo_codes_listing_id", "promo_codes", ["listing_id"])
    op.create_table(
        "promo_redemptions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("promo_code_id", sa.Integer(), sa.ForeignKey("promo_codes.id"), nullable=False),
        sa.Column("portfolio_id", sa.Integer(), sa.ForeignKey("portfolios.id"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("license_id", sa.Integer(), sa.ForeignKey("licenses.id"), nullable=False),
        sa.Column("free_days", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime()),
        sa.Column("reminders", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime()),
        # Once per client and portfolio, ever: two clicks at once, or a script, still get one
        sa.UniqueConstraint("portfolio_id", "user_id", name="uq_promo_redemptions_portfolio_user"),
        sa.UniqueConstraint("license_id", name="uq_promo_redemptions_license"),
    )
    op.create_index("ix_promo_redemptions_promo_code_id", "promo_redemptions", ["promo_code_id"])
    op.create_index("ix_promo_redemptions_user_id", "promo_redemptions", ["user_id"])


def downgrade():
    op.drop_index("ix_promo_redemptions_user_id", table_name="promo_redemptions")
    op.drop_index("ix_promo_redemptions_promo_code_id", table_name="promo_redemptions")
    op.drop_table("promo_redemptions")
    op.drop_index("ix_promo_codes_listing_id", table_name="promo_codes")
    op.drop_table("promo_codes")
