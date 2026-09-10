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


EMPLOYEES_SCHEMA = """
CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT ''
);
"""


def departments(connection):
    return {row["id"]: row["department"] for row in connection.execute("SELECT id, department FROM workplaces")}


def names(connection):
    return {row["id"]: row["name"] for row in connection.execute("SELECT id, name FROM workplaces")}


def test_033_adds_department_column(conn):
    migrations._migrate_029_workplaces_table(conn)
    migrations._migrate_033_workplaces_department(conn)
    assert "department" in columns(conn, "workplaces")


def test_033_backfills_department_from_the_occupant(conn):
    # Отдел хозяина стола — лучшая догадка, которая у нас есть.
    conn.executescript(EMPLOYEES_SCHEMA)
    migrations._migrate_029_workplaces_table(conn)
    conn.execute("INSERT INTO employees (id, full_name, department) VALUES ('emp_1', 'Цой', 'Бухгалтерия')")
    conn.execute("INSERT INTO workplaces (id, name, employee_id) VALUES ('w1', 'Стол 2', 'emp_1')")
    migrations._migrate_033_workplaces_department(conn)
    assert departments(conn) == {"w1": "Бухгалтерия"}


def test_033_backfills_free_and_ownerless_workplaces_with_the_literal(conn):
    # Свободный стол и стол сотрудника без отдела угадать не по чему —
    # но пустым отдел остаться не может, иначе validate_state заблокирует
    # первое же сохранение после обновления.
    conn.executescript(EMPLOYEES_SCHEMA)
    migrations._migrate_029_workplaces_table(conn)
    conn.execute("INSERT INTO employees (id, full_name, department) VALUES ('emp_1', 'Цой', '')")
    conn.execute("INSERT INTO workplaces (id, name, employee_id) VALUES ('w1', 'Стол 1', NULL)")
    conn.execute("INSERT INTO workplaces (id, name, employee_id) VALUES ('w2', 'Стол 2', 'emp_1')")
    migrations._migrate_033_workplaces_department(conn)
    assert departments(conn) == {"w1": "Без отдела", "w2": "Без отдела"}


def test_033_survives_a_database_without_employees_table(conn):
    # Самая старая база: таблицы сотрудников ещё нет (её создаёт schema.sql).
    # Подзапрос по employees в такой базе не должен ронять миграцию.
    migrations._migrate_029_workplaces_table(conn)
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w1', 'Стол 1')")
    migrations._migrate_033_workplaces_department(conn)
    assert departments(conn) == {"w1": "Без отдела"}


def test_033_separates_same_named_workplaces_landing_in_one_department(conn):
    # Два одноимённых стола без отдела обречены попасть в «Без отдела»
    # вместе — и стать дублем, который сервер откажется сохранять.
    migrations._migrate_029_workplaces_table(conn)
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w1', 'Стол 1')")
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w2', 'Стол 1')")
    migrations._migrate_033_workplaces_department(conn)
    rows = list(conn.execute("SELECT name, department FROM workplaces"))
    keys = [(row["name"].strip().lower(), row["department"]) for row in rows]
    assert len(set(keys)) == 2, keys
    assert names(conn) == {"w1": "Стол 1", "w2": "Стол 1 (2)"}


def test_033_picks_a_free_suffix_when_the_obvious_one_is_taken(conn):
    migrations._migrate_029_workplaces_table(conn)
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w1', 'Стол 1')")
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w2', 'Стол 1')")
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w3', 'Стол 1 (2)')")
    migrations._migrate_033_workplaces_department(conn)
    rows = list(conn.execute("SELECT name, department FROM workplaces"))
    keys = [(row["name"].strip().lower(), row["department"]) for row in rows]
    assert len(set(keys)) == 3, keys


def test_033_is_idempotent(conn):
    # Миграция теперь не только добавляет колонку, но и заполняет её, поэтому
    # «идемпотентна» значит в том числе: второй прогон не навешивает
    # «(2) (2)» на уже разведённые названия и не перетирает отделы.
    conn.executescript(EMPLOYEES_SCHEMA)
    migrations._migrate_029_workplaces_table(conn)
    conn.execute("INSERT INTO employees (id, full_name, department) VALUES ('emp_1', 'Цой', 'Бухгалтерия')")
    conn.execute("INSERT INTO workplaces (id, name, employee_id) VALUES ('w1', 'Стол 1', 'emp_1')")
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w2', 'Стол 1')")
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w3', 'Стол 1')")
    migrations._migrate_033_workplaces_department(conn)
    first = (names(conn), departments(conn))
    migrations._migrate_033_workplaces_department(conn)
    assert (names(conn), departments(conn)) == first
    assert "department" in columns(conn, "workplaces")


def test_034_adds_code_column(conn):
    migrations._migrate_029_workplaces_table(conn)
    migrations._migrate_034_workplaces_code(conn)
    assert "code" in columns(conn, "workplaces")


def test_034_backfills_existing_rows_sequentially(conn):
    migrations._migrate_029_workplaces_table(conn)
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w1', 'Стол 2')")
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w2', 'Стол 1')")
    migrations._migrate_034_workplaces_code(conn)
    rows = {row["id"]: row["code"] for row in conn.execute("SELECT id, code FROM workplaces")}
    # Бэкофилл идёт в порядке "name, id" — "Стол 1" (w2) раньше "Стол 2" (w1).
    assert rows == {"w2": "WP-0001", "w1": "WP-0002"}


def test_034_does_not_touch_rows_with_existing_code(conn):
    migrations._migrate_029_workplaces_table(conn)
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w1', 'Стол 2')")
    migrations._migrate_034_workplaces_code(conn)
    conn.execute("UPDATE workplaces SET code = 'WP-0009' WHERE id = 'w1'")
    migrations._migrate_034_workplaces_code(conn)
    assert conn.execute("SELECT code FROM workplaces WHERE id='w1'").fetchone()["code"] == "WP-0009"


def test_034_is_idempotent(conn):
    migrations._migrate_029_workplaces_table(conn)
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w1', 'Стол 2')")
    migrations._migrate_034_workplaces_code(conn)
    first = conn.execute("SELECT code FROM workplaces WHERE id='w1'").fetchone()["code"]
    migrations._migrate_034_workplaces_code(conn)
    second = conn.execute("SELECT code FROM workplaces WHERE id='w1'").fetchone()["code"]
    assert first == second


def test_033_and_034_registered_in_order():
    versions = [version for version, _name, _func in migrations.MIGRATIONS]
    assert {33, 34} <= set(versions)
    assert versions == sorted(versions)
