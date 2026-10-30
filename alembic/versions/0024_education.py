"""The educational area: modules of video lessons and FAQ, Trademetric's own and each manager's, and the lessons each
user finished.

Revision ID: 0024_education
Revises: 0023_hosting_queue_alert
Create Date: 2026-10-30
"""
from alembic import op
import sqlalchemy as sa

revision = "0024_education"
down_revision = "0023_hosting_queue_alert"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "edu_modules",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("manager_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),  # NULL: Trademetric's own
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("description", sa.String(500)),
        sa.Column("audience", sa.String(16), nullable=False, server_default="clients"),
        sa.Column("published", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
    )
    op.create_index("ix_edu_modules_manager_id", "edu_modules", ["manager_id"])
    op.create_table(
        "edu_lessons",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("module_id", sa.Integer(), sa.ForeignKey("edu_modules.id"), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("summary", sa.String(300)),
        sa.Column("video_url", sa.String(500)),
        sa.Column("body", sa.Text()),
        sa.Column("minutes", sa.Integer()),
        sa.Column("published", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
    )
    op.create_index("ix_edu_lessons_module_id", "edu_lessons", ["module_id"])
    op.create_table(
        "edu_faqs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("manager_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),  # NULL: Trademetric's own
        sa.Column("question", sa.String(300), nullable=False),
        sa.Column("answer", sa.Text(), nullable=False),
        sa.Column("audience", sa.String(16), nullable=False, server_default="clients"),
        sa.Column("published", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
    )
    op.create_index("ix_edu_faqs_manager_id", "edu_faqs", ["manager_id"])
    op.create_table(
        "edu_progress",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("lesson_id", sa.Integer(), sa.ForeignKey("edu_lessons.id"), nullable=False),
        sa.Column("completed_at", sa.DateTime()),
        sa.UniqueConstraint("user_id", "lesson_id", name="uq_edu_progress_identity"),
    )
    op.create_index("ix_edu_progress_user_id", "edu_progress", ["user_id"])
    op.create_index("ix_edu_progress_lesson_id", "edu_progress", ["lesson_id"])


def downgrade():
    op.drop_table("edu_progress")
    op.drop_table("edu_faqs")
    op.drop_table("edu_lessons")
    op.drop_table("edu_modules")
