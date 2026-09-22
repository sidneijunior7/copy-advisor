"""Signal history tables, UNIQUE(user_id, magic_number), 64-bit MT5 identifiers

Revision ID: 0002_signals
Revises: 0001_baseline
Create Date: 2026-09-15
"""
from alembic import op
import sqlalchemy as sa

revision = "0002_signals"
down_revision = "0001_baseline"
branch_labels = None
depends_on = None

BigIntPK = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def _has_unique(insp, table, columns):
    """Match by columns, not name: supabase_schema.sql created it as strategies_user_id_magic_number_key."""
    columns = set(columns)
    for uc in insp.get_unique_constraints(table):
        if set(uc["column_names"]) == columns:
            return True
    for ix in insp.get_indexes(table):
        if ix.get("unique") and set(ix["column_names"]) == columns:
            return True
    return False


def upgrade():
    bind = op.get_bind()
    insp = sa.inspect(bind)

    duplicates = bind.execute(sa.text(
        "SELECT user_id, magic_number, COUNT(*) FROM strategies "
        "GROUP BY user_id, magic_number HAVING COUNT(*) > 1"
    )).fetchall()
    if duplicates:
        listed = ", ".join(f"user_id={u} magic={m} ({n}x)" for u, m, n in duplicates)
        raise RuntimeError(
            "Estratégias duplicadas para o mesmo (user_id, magic_number): "
            f"{listed}. Remova ou renumere antes de migrar."
        )

    with op.batch_alter_table("strategies") as batch:
        batch.alter_column("magic_number", existing_type=sa.Integer(), type_=sa.BigInteger())
        if not _has_unique(insp, "strategies", ["user_id", "magic_number"]):
            batch.create_unique_constraint("uq_strategies_user_magic", ["user_id", "magic_number"])

    with op.batch_alter_table("licenses") as batch:
        batch.alter_column("client_mt5_login", existing_type=sa.Integer(), type_=sa.BigInteger())

    op.create_table(
        "master_positions",
        sa.Column("id", BigIntPK, primary_key=True),
        sa.Column("manager_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("strategy_id", sa.Integer(), sa.ForeignKey("strategies.id"), nullable=False),
        sa.Column("master_login", sa.BigInteger(), nullable=False),
        sa.Column("pos_id", sa.BigInteger(), nullable=False),
        sa.Column("symbol", sa.String(64), nullable=False),
        sa.Column("type", sa.Integer(), nullable=False),
        sa.Column("volume", sa.Float(), nullable=False),
        sa.Column("price_open", sa.Float()),
        sa.Column("sl", sa.Float()),
        sa.Column("tp", sa.Float()),
        sa.Column("magic", sa.BigInteger()),
        sa.Column("opened_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
        sa.Column("closed_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("manager_id", "master_login", "pos_id", name="uq_master_positions_identity"),
    )
    op.create_index("ix_master_positions_strategy_open", "master_positions", ["strategy_id", "closed_at"])

    op.create_table(
        "signals",
        sa.Column("id", BigIntPK, primary_key=True),
        sa.Column("master_position_id", sa.BigInteger(), sa.ForeignKey("master_positions.id"), nullable=False),
        sa.Column("reason", sa.String(16), nullable=False),
        sa.Column("type", sa.Integer()),
        sa.Column("volume", sa.Float()),
        sa.Column("price_open", sa.Float()),
        sa.Column("sl", sa.Float()),
        sa.Column("tp", sa.Float()),
        sa.Column("raw", sa.Text()),
        sa.Column("received_at", sa.DateTime()),
    )
    op.create_index("ix_signals_master_position_id", "signals", ["master_position_id"])
    op.create_index("ix_signals_received_at", "signals", ["received_at"])

    op.create_table(
        "executions",
        sa.Column("id", BigIntPK, primary_key=True),
        sa.Column("uid", sa.String(64), nullable=False),
        sa.Column("portfolio_id", sa.Integer(), sa.ForeignKey("portfolios.id"), nullable=True),
        sa.Column("mt5_login", sa.BigInteger(), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("position_id", sa.BigInteger()),
        sa.Column("volume", sa.Float()),
        sa.Column("price", sa.Float()),
        sa.Column("retcode", sa.Integer()),
        sa.Column("seq", sa.BigInteger()),
        sa.Column("created_at", sa.DateTime()),
    )
    op.create_index("ix_executions_uid", "executions", ["uid"])
    op.create_index("ix_executions_created_at", "executions", ["created_at"])


def downgrade():
    op.drop_table("executions")
    op.drop_table("signals")
    op.drop_table("master_positions")
    with op.batch_alter_table("licenses") as batch:
        batch.alter_column("client_mt5_login", existing_type=sa.BigInteger(), type_=sa.Integer())
    with op.batch_alter_table("strategies") as batch:
        batch.drop_constraint("uq_strategies_user_magic", type_="unique")
        batch.alter_column("magic_number", existing_type=sa.BigInteger(), type_=sa.Integer())
