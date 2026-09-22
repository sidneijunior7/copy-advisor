import os
import sys
from logging.config import fileConfig

from alembic import context

# Make the project root importable (database.py, models.py)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import database  # noqa: E402
import models  # noqa: E402

config = context.config
if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name)

target_metadata = models.Base.metadata


def run_migrations(connection):
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=True,  # SQLite needs table rebuilds for ALTER
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online():
    # migrate.py passes its own connection (it holds the advisory lock)
    connection = config.attributes.get("connection")
    if connection is not None:
        run_migrations(connection)
        return
    with database.engine.connect() as connection:
        run_migrations(connection)
        connection.commit()


if context.is_offline_mode():
    context.configure(url=database.SQLALCHEMY_DATABASE_URL, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    run_migrations_online()
