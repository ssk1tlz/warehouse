"""Тесты миграций рабочих мест (029 и 030)."""

import sqlite3

import pytest

import migrations


ALLOC_SCHEMA = """
CREATE TABLE asset_allocations (
  asset_id TEXT NOT NULL,
  employee_id TEXT,
  department TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 0
);
"""


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    yield connection
    connection.close()


def columns(connection, table):
    return {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}


def test_029_creates_workplaces_table(conn):
    migrations._migrate_029_workplaces_table(conn)
    assert columns(conn, "workplaces") == {"id", "name", "employee_id", "site", "notes"}


def test_029_is_idempotent(conn):
    migrations._migrate_029_workplaces_table(conn)
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w1', 'Стол 2')")
    migrations._migrate_029_workplaces_table(conn)
    assert conn.execute("SELECT COUNT(*) FROM workplaces").fetchone()[0] == 1


def test_030_adds_workplace_id_column(conn):
    conn.executescript(ALLOC_SCHEMA)
    migrations._migrate_030_allocation_workplace(conn)
    assert "workplace_id" in columns(conn, "asset_allocations")


def test_030_defaults_existing_rows_to_empty_string(conn):
    # Пустая строка, а не NULL: правило «заполнено ровно одно поле»
    # проверяется у всех получателей единообразно.
    conn.executescript(ALLOC_SCHEMA)
    conn.execute("INSERT INTO asset_allocations (asset_id, employee_id, quantity) VALUES ('a1', 'emp_1', 2)")
    migrations._migrate_030_allocation_workplace(conn)
    row = conn.execute("SELECT employee_id, workplace_id FROM asset_allocations").fetchone()
    assert (row["employee_id"], row["workplace_id"]) == ("emp_1", "")


def test_030_is_idempotent(conn):
    conn.executescript(ALLOC_SCHEMA)
    migrations._migrate_030_allocation_workplace(conn)
    migrations._migrate_030_allocation_workplace(conn)
    assert "workplace_id" in columns(conn, "asset_allocations")


def test_030_skips_database_without_allocations_table(conn):
    # Самая старая база: таблицы выдач ещё нет. Миграция 015 создаёт её
    # позже, падать здесь нельзя.
    migrations._migrate_030_allocation_workplace(conn)
    assert "asset_allocations" not in {
        row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def test_031_adds_workplace_id_to_movements(conn):
    conn.executescript(
        "CREATE TABLE movements (id TEXT PRIMARY KEY, type TEXT NOT NULL, asset_id TEXT NOT NULL,"
        " employee_id TEXT, department TEXT NOT NULL DEFAULT '', site TEXT NOT NULL DEFAULT '',"
        " quantity INTEGER NOT NULL DEFAULT 0, date TEXT NOT NULL);"
    )
    migrations._migrate_031_movement_workplace(conn)
    assert "workplace_id" in columns(conn, "movements")


def test_all_three_registered_in_order():
    versions = [version for version, _name, _func in migrations.MIGRATIONS]
    assert {29, 30, 31} <= set(versions)
    assert versions == sorted(versions)
