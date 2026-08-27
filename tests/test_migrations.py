import sqlite3

import pytest

import migrations


LEGACY_SCHEMA = """
CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  department TEXT,
  position TEXT,
  email TEXT
);
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  inventory_number TEXT,
  serial_number TEXT,
  purchase_date TEXT,
  status TEXT NOT NULL DEFAULT 'in_stock',
  notes TEXT,
  quantity INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE movements (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  employee_id TEXT,
  quantity INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  notes TEXT
);
"""


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    yield connection
    connection.close()


@pytest.fixture
def legacy_conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(LEGACY_SCHEMA)
    connection.execute(
        "INSERT INTO assets (id, name, quantity) VALUES ('ast_1', 'Ноутбук', 5)"
    )
    connection.commit()
    yield connection
    connection.close()


def test_current_version_is_zero_on_fresh_connection(conn):
    assert migrations.current_version(conn) == 0


def test_pending_migrations_returns_everything_when_nothing_applied(conn, monkeypatch):
    monkeypatch.setattr(migrations, "MIGRATIONS", [(1, "a", lambda c: None), (2, "b", lambda c: None)])
    assert [m[0] for m in migrations.pending_migrations(conn)] == [1, 2]


def test_run_migrations_applies_pending_and_records_version(conn, monkeypatch):
    calls = []
    monkeypatch.setattr(migrations, "MIGRATIONS", [(1, "test", lambda c: calls.append(c))])
    applied = migrations.run_migrations(conn)
    assert applied == [1]
    assert len(calls) == 1
    assert migrations.current_version(conn) == 1


def test_run_migrations_is_idempotent(conn, monkeypatch):
    monkeypatch.setattr(migrations, "MIGRATIONS", [(1, "test", lambda c: None)])
    migrations.run_migrations(conn)
    assert migrations.run_migrations(conn) == []


def test_run_migrations_applies_only_versions_above_current(conn, monkeypatch):
    monkeypatch.setattr(migrations, "MIGRATIONS", [(1, "a", lambda c: None)])
    migrations.run_migrations(conn)
    monkeypatch.setattr(migrations, "MIGRATIONS", [(1, "a", lambda c: None), (2, "b", lambda c: None)])
    assert migrations.run_migrations(conn) == [2]


@pytest.mark.parametrize("table,column", [
    ("assets", "repair_quantity"), ("assets", "retired_quantity"), ("assets", "min_quantity"),
    ("assets", "warranty_end"), ("assets", "price"), ("assets", "repair_date"),
    ("assets", "location"), ("assets", "photo_url"),
    ("employees", "phone"), ("employees", "site"), ("employees", "status"),
    ("movements", "act_number"), ("movements", "department"), ("movements", "site"),
])
def test_column_migrations_add_missing_columns(legacy_conn, table, column):
    migrations.run_migrations(legacy_conn)
    columns = {row["name"] for row in legacy_conn.execute(f"PRAGMA table_info({table})")}
    assert column in columns


def test_column_migrations_preserve_existing_rows(legacy_conn):
    migrations.run_migrations(legacy_conn)
    row = legacy_conn.execute("SELECT name, quantity, repair_quantity FROM assets WHERE id='ast_1'").fetchone()
    assert row["name"] == "Ноутбук"
    assert row["quantity"] == 5
    assert row["repair_quantity"] == 0


def test_column_migrations_are_noop_on_already_current_schema(legacy_conn):
    migrations.run_migrations(legacy_conn)
    applied_twice = migrations.run_migrations(legacy_conn)
    assert applied_twice == []
