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


def _write_legacy_db_with_orphaned_allocations(db_path):
    """A pre-migration-15 database whose asset_allocations rows point at rows
    that no longer exist (an asset/employee deleted without cleanup — ordinary
    in a real old install)."""
    legacy = sqlite3.connect(db_path)
    legacy.executescript(
        "CREATE TABLE employees (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);"
        "CREATE TABLE assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1);"
        "CREATE TABLE movements (id TEXT PRIMARY KEY, type TEXT NOT NULL, asset_id TEXT NOT NULL, "
        "quantity INTEGER NOT NULL DEFAULT 0, date TEXT NOT NULL);"
        # OLD asset_allocations shape: no `department`, employee_id NOT NULL,
        # and FKs on both columns.
        "CREATE TABLE asset_allocations ("
        "  asset_id TEXT NOT NULL,"
        "  employee_id TEXT NOT NULL,"
        "  quantity INTEGER NOT NULL DEFAULT 0,"
        "  FOREIGN KEY (asset_id) REFERENCES assets(id),"
        "  FOREIGN KEY (employee_id) REFERENCES employees(id)"
        ");"
        "INSERT INTO employees (id, full_name) VALUES ('emp_1', 'Иванов');"
        "INSERT INTO assets (id, name, quantity) VALUES ('ast_1', 'Ноутбук', 3);"
        "INSERT INTO asset_allocations (asset_id, employee_id, quantity) VALUES ('ast_1', 'emp_1', 1);"
        # Orphans: neither 'emp_gone' nor 'ast_gone' exists any more.
        "INSERT INTO asset_allocations (asset_id, employee_id, quantity) VALUES ('ast_1', 'emp_gone', 2);"
        "INSERT INTO asset_allocations (asset_id, employee_id, quantity) VALUES ('ast_gone', 'emp_1', 4);"
    )
    legacy.commit()
    legacy.close()


def test_init_db_migrates_a_legacy_database_with_orphaned_allocation_rows(tmp_path, monkeypatch):
    # Regression guard for the migration-15 rebuild. It does
    # `PRAGMA foreign_keys = OFF` before copying asset_allocations into its new
    # shape, but SQLite ignores that pragma while a transaction is open — and
    # migrations 1-14 leave one open via their schema_version INSERTs. With the
    # pragma silently a no-op, an orphaned row aborted the rebuild with
    # IntegrityError, which propagated out of init_db() and stopped the server
    # from starting at all. Drive the REAL init_db() here, not a bare connection.
    db_path = tmp_path / "warehouse.db"
    _write_legacy_db_with_orphaned_allocations(db_path)
    monkeypatch.setattr(server, "DB_PATH", db_path)
    monkeypatch.setattr(server, "BACKUP_DIR", tmp_path / "backups")

    server.init_db()  # must not raise

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(asset_allocations)")}
    assert "department" in columns
    rows = {
        (r["asset_id"], r["employee_id"]): r
        for r in conn.execute("SELECT asset_id, employee_id, department, quantity FROM asset_allocations")
    }
    assert len(rows) == 3, "миграция потеряла строки"
    # Orphans survive as dangling references with an empty department — the
    # rebuild preserves rows as-is, it does not clean up.
    assert rows[("ast_1", "emp_gone")]["quantity"] == 2
    assert rows[("ast_gone", "emp_1")]["quantity"] == 4
    assert all(r["department"] == "" for r in rows.values())
    conn.close()


def test_init_db_does_not_create_a_backup_for_a_brand_new_database(tmp_path, monkeypatch):
    db_path = tmp_path / "warehouse.db"
    backup_dir = tmp_path / "backups"
    monkeypatch.setattr(server, "DB_PATH", db_path)
    monkeypatch.setattr(server, "BACKUP_DIR", backup_dir)
    server.init_db()
    assert not backup_dir.exists() or not list(backup_dir.glob("pre_migration_*.db"))


def test_get_connection_enables_wal_mode(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "warehouse.db")
    server.init_db()
    connection = server.get_connection()
    mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode.lower() == "wal"


def test_list_backups_returns_files_sorted_newest_first(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BACKUP_DIR", tmp_path)
    (tmp_path / "warehouse_20260101_000000.db").write_bytes(b"a")
    (tmp_path / "pre_migration_20260102_000000.db").write_bytes(b"b")
    backups = server.list_backups()
    assert [b["filename"] for b in backups] == ["pre_migration_20260102_000000.db", "warehouse_20260101_000000.db"]
    assert backups[0]["sizeBytes"] == 1


def test_init_db_refuses_to_start_on_corrupt_database(tmp_path, monkeypatch):
    db_path = tmp_path / "warehouse.db"
    db_path.write_bytes(b"not a real sqlite file")
    monkeypatch.setattr(server, "DB_PATH", db_path)
    monkeypatch.setattr(server, "BACKUP_DIR", tmp_path / "backups")
    with pytest.raises(SystemExit):
        server.init_db()


def test_init_db_does_not_mask_a_real_migration_bug_as_corruption(tmp_path, monkeypatch):
    # init_db() catches sqlite3.DatabaseError to turn raw "file is not a
    # database" errors (file corruption) into a clean SystemExit — but
    # it must NOT swallow subclasses like IntegrityError/OperationalError,
    # which mean a real bug (e.g. in a migration), not a corrupt file. If the
    # `except sqlite3.DatabaseError` in init_db() is ever loosened to catch
    # subclasses too (e.g. by removing the `type(exc) is not
    # sqlite3.DatabaseError: raise` guard), this test starts failing instead
    # of the bug being mislabeled as "database corrupted, restore from
    # backup".
    db_path = tmp_path / "warehouse.db"  # does not exist yet -> fresh install, valid/connectable DB
    monkeypatch.setattr(server, "DB_PATH", db_path)
    monkeypatch.setattr(server, "BACKUP_DIR", tmp_path / "backups")

    def boom(connection):
        raise sqlite3.IntegrityError("simulated migration bug")

    monkeypatch.setattr(migrations, "run_migrations", boom)

    with pytest.raises(sqlite3.IntegrityError):
        server.init_db()
