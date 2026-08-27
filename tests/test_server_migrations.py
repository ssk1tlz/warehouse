import sqlite3
from pathlib import Path

import pytest

import migrations
import server

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"


def _table_shapes(connection: sqlite3.Connection) -> dict:
    tables = [r["name"] for r in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
        "AND name != 'schema_version' ORDER BY name"
    )]
    shapes = {}
    for table in tables:
        columns = [(r["name"], r["type"], r["notnull"], r["dflt_value"])
                   for r in connection.execute(f"PRAGMA table_info({table})")]
        shapes[table] = columns
    return shapes


def test_migrations_are_a_noop_on_top_of_current_schema_sql():
    # schema.sql already mirrors the current head schema (every column/table
    # migrations 1-20 would add already exists there) — so running all
    # migrations on top of a schema.sql-only database must change nothing
    # structurally. This is a regression guard, not a TDD-red test: it
    # already passes today since migrations.py and schema.sql are both
    # complete as of Task A4. It's here so a future migration that breaks
    # this invariant fails loudly.
    before = sqlite3.connect(":memory:")
    before.row_factory = sqlite3.Row
    before.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))

    after = sqlite3.connect(":memory:")
    after.row_factory = sqlite3.Row
    after.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    migrations.run_migrations(after)

    assert _table_shapes(before) == _table_shapes(after)


def test_init_db_creates_pre_migration_backup_for_a_legacy_database(tmp_path, monkeypatch):
    db_path = tmp_path / "warehouse.db"
    backup_dir = tmp_path / "backups"
    legacy = sqlite3.connect(db_path)
    legacy.executescript(
        "CREATE TABLE employees (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);"
        "CREATE TABLE assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1);"
        "CREATE TABLE movements (id TEXT PRIMARY KEY, type TEXT NOT NULL, asset_id TEXT NOT NULL, "
        "quantity INTEGER NOT NULL DEFAULT 0, date TEXT NOT NULL);"
        "INSERT INTO assets (id, name, quantity) VALUES ('ast_1', 'Ноутбук', 3);"
    )
    legacy.commit()
    legacy.close()

    monkeypatch.setattr(server, "DB_PATH", db_path)
    monkeypatch.setattr(server, "BACKUP_DIR", backup_dir)
    server.init_db()

    assert list(backup_dir.glob("pre_migration_*.db")), "не создан бэкап перед миграцией"
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(assets)")}
    assert "repair_quantity" in columns
    row = conn.execute("SELECT name, quantity FROM assets WHERE id='ast_1'").fetchone()
    assert row["name"] == "Ноутбук"
    assert row["quantity"] == 3


def test_init_db_does_not_create_a_backup_for_a_brand_new_database(tmp_path, monkeypatch):
    db_path = tmp_path / "warehouse.db"
    backup_dir = tmp_path / "backups"
    monkeypatch.setattr(server, "DB_PATH", db_path)
    monkeypatch.setattr(server, "BACKUP_DIR", backup_dir)
    server.init_db()
    assert not backup_dir.exists() or not list(backup_dir.glob("pre_migration_*.db"))
