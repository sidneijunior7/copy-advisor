"""The educational area's images: a module's banner and a lesson's thumbnail, both by link, for the client's page.

Revision ID: 0025_education_images
Revises: 0024_education
Create Date: 2026-10-30
"""
from alembic import op
import sqlalchemy as sa

revision = "0025_education_images"
down_revision = "0024_education"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("edu_modules") as batch:
        batch.add_column(sa.Column("cover_url", sa.String(500), nullable=True))
    with op.batch_alter_table("edu_lessons") as batch:
        batch.add_column(sa.Column("thumbnail_url", sa.String(500), nullable=True))


def downgrade():
    with op.batch_alter_table("edu_lessons") as batch:
        batch.drop_column("thumbnail_url")
    with op.batch_alter_table("edu_modules") as batch:
        batch.drop_column("cover_url")
