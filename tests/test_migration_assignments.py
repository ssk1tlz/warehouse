"""Тесты миграций слоя выдач (035 — таблицы, 036 — бэкофилл)."""

import sqlite3
from datetime import datetime, timezone

import pytest

import migrations


MOVEMENTS_SCHEMA = """
CREATE TABLE movements (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  employee_id TEXT,
  department TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  workplace_id TEXT NOT NULL DEFAULT '',
  act_number INTEGER,
  quantity INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  notes TEXT
);
"""


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(MOVEMENTS_SCHEMA)
    yield connection
    connection.close()


def columns(connection, table):
    return {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}


def test_035_creates_assignments_table(conn):
    migrations._migrate_035_assignments_tables(conn)
    assert columns(conn, "assignments") == {
        "id", "code", "employee_id", "workplace_id", "department", "site",
        "status", "issued_at", "returned_at", "act_number", "notes", "created_by",
    }


def test_035_creates_assignment_items_table(conn):
    migrations._migrate_035_assignments_tables(conn)
    assert columns(conn, "assignment_items") == {
        "id", "assignment_id", "asset_id", "quantity", "returned_quantity",
        "scope", "returned_at",
    }


def test_035_adds_assignment_id_to_movements(conn):
    migrations._migrate_035_assignments_tables(conn)
    assert "assignment_id" in columns(conn, "movements")


def test_035_defaults_existing_movements_to_empty_assignment(conn):
    # Пустая строка, а не NULL — как workplace_id в миграции 030: код
    # чтения везде сравнивает с '' и не обязан различать два «ничего».
    conn.execute(
        "INSERT INTO movements (id, type, asset_id, quantity, date) "
        "VALUES ('mov_1', 'issue', 'a1', 1, '2026-09-01')"
    )
    migrations._migrate_035_assignments_tables(conn)
    assert conn.execute("SELECT assignment_id FROM movements").fetchone()["assignment_id"] == ""


def test_035_adds_employee_id_to_a_legacy_movements_table(conn):
    # В самых старых базах у движений нет колонки employee_id, и ни одна
    # прежняя миграция её не добавляла — бэкофиллу 036 читать было бы
    # нечего, и приложение не стартовало бы на такой базе вообще.
    legacy = sqlite3.connect(":memory:")
    legacy.row_factory = sqlite3.Row
    legacy.execute(
        "CREATE TABLE movements (id TEXT PRIMARY KEY, type TEXT NOT NULL, "
        "asset_id TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 0, date TEXT NOT NULL)"
    )
    try:
        migrations._migrate_035_assignments_tables(legacy)
        assert "employee_id" in columns(legacy, "movements")
    finally:
        legacy.close()


def test_035_is_idempotent(conn):
    migrations._migrate_035_assignments_tables(conn)
    conn.execute(
        "INSERT INTO assignments (id, code, status, issued_at) "
        "VALUES ('asg_1', 'ASSIGN-0001', 'active', '2026-09-01')"
    )
    migrations._migrate_035_assignments_tables(conn)
    assert conn.execute("SELECT COUNT(*) FROM assignments").fetchone()[0] == 1


# ─── Миграция 036: бэкофилл выдач из движений ──────────────────────

FULL_SCHEMA = """
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  inventory_number TEXT,
  status TEXT NOT NULL DEFAULT 'in_stock',
  quantity INTEGER NOT NULL DEFAULT 1,
  repair_quantity INTEGER NOT NULL DEFAULT 0,
  retired_quantity INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  department TEXT
);
CREATE TABLE workplaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  employee_id TEXT,
  department TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT ''
);
CREATE TABLE asset_allocations (
  asset_id TEXT NOT NULL,
  employee_id TEXT,
  department TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  workplace_id TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 0
);
"""


@pytest.fixture
def db():
    """База накануне миграции 036: схема есть, таблицы выдач созданы 035-й."""
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(MOVEMENTS_SCHEMA)
    connection.executescript(FULL_SCHEMA)
    migrations._migrate_035_assignments_tables(connection)
    yield connection
    connection.close()


def add_asset(connection, asset_id, inventory_number, quantity=1):
    connection.execute(
        "INSERT INTO assets (id, name, inventory_number, quantity) VALUES (?, ?, ?, ?)",
        (asset_id, f"Техника {inventory_number}", inventory_number, quantity),
    )


def add_employee(connection, employee_id, name="Иванов Иван"):
    connection.execute(
        "INSERT INTO employees (id, full_name, department) VALUES (?, ?, 'Бухгалтерия')",
        (employee_id, name),
    )


def add_movement(connection, movement_id, asset_id, act_number, date,
                 kind="issue", employee_id=None, department="", site="",
                 workplace_id="", quantity=1):
    connection.execute(
        "INSERT INTO movements (id, type, asset_id, employee_id, department, site, "
        "workplace_id, act_number, quantity, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (movement_id, kind, asset_id, employee_id, department, site,
         workplace_id, act_number, quantity, date),
    )


def add_allocation(connection, asset_id, quantity, employee_id=None,
                   department="", site="", workplace_id=""):
    connection.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, department, site, "
        "workplace_id, quantity) VALUES (?, ?, ?, ?, ?, ?)",
        (asset_id, employee_id, department, site, workplace_id, quantity),
    )


def test_036_creates_one_assignment_per_act(db):
    add_asset(db, "a1", "NB-0042")
    add_employee(db, "emp_1")
    add_movement(db, "mov_1", "a1", 1, "2026-09-01", employee_id="emp_1")
    add_allocation(db, "a1", 1, employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)

    rows = list(db.execute("SELECT code, employee_id, status FROM assignments"))
    assert len(rows) == 1
    assert (rows[0]["code"], rows[0]["employee_id"], rows[0]["status"]) == (
        "ASSIGN-0001", "emp_1", "active",
    )


def test_036_groups_several_items_under_one_act(db):
    # §5 ТЗ: одна операция выдачи несёт несколько единиц техники.
    add_employee(db, "emp_1")
    for index, inventory in enumerate(["NB-0042", "MON-0018", "KB-0025"], start=1):
        add_asset(db, f"a{index}", inventory)
        add_movement(db, f"mov_{index}", f"a{index}", 7, "2026-09-01", employee_id="emp_1")
        add_allocation(db, f"a{index}", 1, employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)

    assert db.execute("SELECT COUNT(*) FROM assignments").fetchone()[0] == 1
    assert db.execute("SELECT COUNT(*) FROM assignment_items").fetchone()[0] == 3


def test_036_splits_one_act_between_different_recipients(db):
    # Один номер акта на двух получателей — в боевой базе не встречается,
    # но ручная правка или старый импорт могли такое оставить. Слить их
    # в одну выдачу значило бы приписать технику чужому человеку.
    add_asset(db, "a1", "NB-0042")
    add_asset(db, "a2", "MON-0018")
    add_employee(db, "emp_1")
    add_employee(db, "emp_2", "Петров Пётр")
    add_movement(db, "mov_1", "a1", 5, "2026-09-01", employee_id="emp_1")
    add_movement(db, "mov_2", "a2", 5, "2026-09-01", employee_id="emp_2")
    add_allocation(db, "a1", 1, employee_id="emp_1")
    add_allocation(db, "a2", 1, employee_id="emp_2")

    migrations._migrate_036_assignments_backfill(db)

    assert db.execute("SELECT COUNT(*) FROM assignments").fetchone()[0] == 2


def test_036_numbers_assignments_chronologically(db):
    add_asset(db, "a1", "NB-0042")
    add_asset(db, "a2", "MON-0018")
    add_employee(db, "emp_1")
    add_movement(db, "mov_1", "a1", 9, "2026-09-05", employee_id="emp_1")
    add_movement(db, "mov_2", "a2", 2, "2026-09-01", employee_id="emp_1")
    add_allocation(db, "a1", 1, employee_id="emp_1")
    add_allocation(db, "a2", 1, employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)

    codes = {
        row["act_number"]: row["code"]
        for row in db.execute("SELECT act_number, code FROM assignments")
    }
    assert codes == {2: "ASSIGN-0001", 9: "ASSIGN-0002"}


def test_036_orders_undated_issues_by_the_timestamp_in_the_movement_id(db):
    # Дата выдачи часто пустая: «Выдать сразу» в app.js не проставляет
    # её, потому что технику заводят задним числом. Сортировать такие
    # движения по пустой строке — значит свалить их все в начало
    # нумерации. Порядок берём оттуда же, откуда его берёт журнал
    # приложения (AssetOps.movementSortValue) — из метки времени в id.
    add_asset(db, "a1", "NB-0042")
    add_asset(db, "a2", "MON-0018")
    add_employee(db, "emp_1")
    add_movement(db, "mov_1700000000000_aaa", "a1", 1, "", employee_id="emp_1")
    add_movement(db, "mov_1600000000000_bbb", "a2", 2, "", employee_id="emp_1")
    add_allocation(db, "a1", 1, employee_id="emp_1")
    add_allocation(db, "a2", 1, employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)

    codes = {
        row["act_number"]: row["code"]
        for row in db.execute("SELECT act_number, code FROM assignments")
    }
    assert codes == {2: "ASSIGN-0001", 1: "ASSIGN-0002"}


def test_036_puts_dated_and_undated_issues_on_one_timeline(db):
    # Датированные и недатированные выдачи выстраиваются в общий ряд, а
    # не двумя отдельными кучами.
    add_asset(db, "a1", "NB-0042")
    add_asset(db, "a2", "MON-0018")
    add_employee(db, "emp_1")
    late = int(datetime(2026, 9, 5, tzinfo=timezone.utc).timestamp() * 1000)
    add_movement(db, "mov_1_aaa", "a1", 1, "2026-09-01", employee_id="emp_1")
    add_movement(db, f"mov_{late}_bbb", "a2", 2, "", employee_id="emp_1")
    add_allocation(db, "a1", 1, employee_id="emp_1")
    add_allocation(db, "a2", 1, employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)

    codes = {
        row["act_number"]: row["code"]
        for row in db.execute("SELECT act_number, code FROM assignments")
    }
    assert codes == {1: "ASSIGN-0001", 2: "ASSIGN-0002"}


def test_036_keeps_issued_at_empty_when_the_movement_has_no_date(db):
    # Метка времени из id — это когда ЗАПИСЬ создали, а не когда технику
    # выдали. Она годится для порядка, но выдавать её за дату выдачи
    # нельзя: приложение специально оставляет дату пустой, когда её не
    # знают.
    add_asset(db, "a1", "NB-0042")
    add_employee(db, "emp_1")
    add_movement(db, "mov_1700000000000_aaa", "a1", 1, "", employee_id="emp_1")
    add_allocation(db, "a1", 1, employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)

    assert db.execute("SELECT issued_at FROM assignments").fetchone()["issued_at"] == ""


def test_036_takes_the_earliest_real_date_of_a_mixed_act(db):
    # В одном акте часть движений с датой, часть без. issued_at — самая
    # ранняя настоящая дата, а не пустая строка от недатированного.
    add_asset(db, "a1", "NB-0042")
    add_asset(db, "a2", "MON-0018")
    add_employee(db, "emp_1")
    add_movement(db, "mov_1700000000000_aaa", "a1", 4, "", employee_id="emp_1")
    add_movement(db, "mov_1700000000001_bbb", "a2", 4, "2026-09-03", employee_id="emp_1")
    add_allocation(db, "a1", 1, employee_id="emp_1")
    add_allocation(db, "a2", 1, employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)

    assert db.execute("SELECT issued_at FROM assignments").fetchone()["issued_at"] == "2026-09-03"


def test_036_links_movements_to_their_assignment(db):
    add_asset(db, "a1", "NB-0042")
    add_employee(db, "emp_1")
    add_movement(db, "mov_1", "a1", 1, "2026-09-01", employee_id="emp_1")
    add_allocation(db, "a1", 1, employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)

    assignment_id = db.execute("SELECT id FROM assignments").fetchone()["id"]
    assert db.execute("SELECT assignment_id FROM movements").fetchone()["assignment_id"] == assignment_id


def test_036_closes_assignments_whose_equipment_came_back(db):
    # Движение о выдаче есть, а в текущем состоянии техники за
    # сотрудником нет — значит, её вернули. История остаётся (§12),
    # но выдача закрыта.
    add_asset(db, "a1", "NB-0042")
    add_employee(db, "emp_1")
    add_movement(db, "mov_1", "a1", 1, "2026-09-01", employee_id="emp_1")
    add_movement(db, "mov_2", "a1", 2, "2026-09-08", kind="return", employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)

    assignment = db.execute("SELECT status, returned_at FROM assignments").fetchone()
    item = db.execute("SELECT quantity, returned_quantity FROM assignment_items").fetchone()
    assert assignment["status"] == "returned"
    assert assignment["returned_at"] == "2026-09-08"
    assert (item["quantity"], item["returned_quantity"]) == (1, 1)


def test_036_keeps_the_newest_issue_active_when_equipment_was_reissued(db):
    # Ноутбук выдали Иванову, вернули, выдали снова. Активной должна
    # остаться свежая выдача, а не первая (§14 ТЗ).
    add_asset(db, "a1", "NB-0042")
    add_employee(db, "emp_1")
    add_movement(db, "mov_1", "a1", 1, "2026-09-01", employee_id="emp_1")
    add_movement(db, "mov_2", "a1", 2, "2026-09-05", kind="return", employee_id="emp_1")
    add_movement(db, "mov_3", "a1", 3, "2026-09-08", employee_id="emp_1")
    add_allocation(db, "a1", 1, employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)

    statuses = {
        row["act_number"]: row["status"]
        for row in db.execute("SELECT act_number, status FROM assignments")
    }
    assert statuses == {1: "returned", 3: "active"}


def test_036_marks_workplace_issues_with_workplace_scope(db):
    # Техника, выданная на стол, остаётся столу при смене сотрудника —
    # scope отличает её от личной.
    add_asset(db, "a1", "MON-0018")
    db.execute("INSERT INTO workplaces (id, name) VALUES ('wp_1', 'Стол №7')")
    add_movement(db, "mov_1", "a1", 1, "2026-09-01", workplace_id="wp_1")
    add_allocation(db, "a1", 1, workplace_id="wp_1")

    migrations._migrate_036_assignments_backfill(db)

    assignment = db.execute("SELECT employee_id, workplace_id FROM assignments").fetchone()
    assert (assignment["employee_id"], assignment["workplace_id"]) == (None, "wp_1")
    assert db.execute("SELECT scope FROM assignment_items").fetchone()["scope"] == "workplace"


def test_036_marks_employee_issues_with_personal_scope(db):
    add_asset(db, "a1", "NB-0042")
    add_employee(db, "emp_1")
    add_movement(db, "mov_1", "a1", 1, "2026-09-01", employee_id="emp_1")
    add_allocation(db, "a1", 1, employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)

    assert db.execute("SELECT scope FROM assignment_items").fetchone()["scope"] == "personal"


def test_036_splits_a_partially_returned_quantity(db):
    # Выдали 5 мышей, вернули 2 — в состоянии осталось 3. Позиция не
    # закрывается целиком и не остаётся целиком активной.
    add_asset(db, "a1", "MUS-0020", quantity=5)
    add_employee(db, "emp_1")
    add_movement(db, "mov_1", "a1", 1, "2026-09-01", employee_id="emp_1", quantity=5)
    add_allocation(db, "a1", 3, employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)

    item = db.execute("SELECT quantity, returned_quantity FROM assignment_items").fetchone()
    assert (item["quantity"], item["returned_quantity"]) == (5, 2)
    assert db.execute("SELECT status FROM assignments").fetchone()["status"] == "active"


def test_036_preserves_every_allocated_unit(db):
    # §22 ТЗ: после миграции проекция обязана совпасть с исходным
    # состоянием единица в единицу — иначе техника «потерялась».
    add_asset(db, "a1", "NB-0042")
    add_asset(db, "a2", "MUS-0020", quantity=4)
    add_employee(db, "emp_1")
    add_movement(db, "mov_1", "a1", 1, "2026-09-01", employee_id="emp_1")
    add_movement(db, "mov_2", "a2", 1, "2026-09-01", employee_id="emp_1", quantity=4)
    add_movement(db, "mov_3", "a2", 2, "2026-09-02", department="Склад", quantity=2)
    add_allocation(db, "a1", 1, employee_id="emp_1")
    add_allocation(db, "a2", 4, employee_id="emp_1")
    add_allocation(db, "a2", 2, department="Склад")

    migrations._migrate_036_assignments_backfill(db)

    projected = sorted(
        (row["asset_id"], row["employee_id"] or "", row["department"], row["quantity"])
        for row in db.execute(
            "SELECT ai.asset_id, a.employee_id, a.department, "
            "SUM(ai.quantity - ai.returned_quantity) AS quantity "
            "FROM assignment_items ai JOIN assignments a ON a.id = ai.assignment_id "
            "WHERE ai.quantity > ai.returned_quantity "
            "GROUP BY ai.asset_id, a.employee_id, a.department"
        )
    )
    assert projected == [("a1", "emp_1", "", 1), ("a2", "", "Склад", 2), ("a2", "emp_1", "", 4)]


def test_036_recovers_an_allocation_that_no_movement_explains(db):
    # Легаси-база и восстановленный бэкап регулярно содержат выдачу без
    # парного движения. Уронить миграцию нельзя — приложение не
    # стартует; выбросить строку нельзя — потеряется техника. Заводим
    # выдачу без даты и с пометкой, что исходная операция неизвестна.
    add_asset(db, "a1", "NB-0042")
    add_employee(db, "emp_1")
    add_allocation(db, "a1", 2, employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)

    assignment = db.execute(
        "SELECT employee_id, status, issued_at, act_number, notes FROM assignments"
    ).fetchone()
    assert (assignment["employee_id"], assignment["status"]) == ("emp_1", "active")
    # Дата не выдумывается: пустая строка честнее правдоподобной даты.
    assert (assignment["issued_at"], assignment["act_number"]) == ("", None)
    assert "неизвестна" in assignment["notes"]
    item = db.execute("SELECT quantity, returned_quantity FROM assignment_items").fetchone()
    assert (item["quantity"], item["returned_quantity"]) == (2, 0)


def test_036_recovers_only_the_part_movements_do_not_cover(db):
    # Движение объясняет 1 шт., а за сотрудником числится 3. Одна
    # позиция остаётся исторической, недостача восстанавливается
    # отдельной выдачей — итог обязан сойтись на 3.
    add_asset(db, "a1", "MUS-0020", quantity=5)
    add_employee(db, "emp_1")
    add_movement(db, "mov_1", "a1", 1, "2026-09-01", employee_id="emp_1", quantity=1)
    add_allocation(db, "a1", 3, employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)

    assert db.execute("SELECT COUNT(*) FROM assignments").fetchone()[0] == 2
    active = db.execute(
        "SELECT SUM(quantity - returned_quantity) AS n FROM assignment_items"
    ).fetchone()["n"]
    assert active == 3


def test_036_groups_recovered_allocations_of_one_recipient_together(db):
    # Две позиции одного сотрудника — одна восстановленная выдача, а не
    # две: это одна и та же неизвестная операция.
    add_asset(db, "a1", "NB-0042")
    add_asset(db, "a2", "MON-0018")
    add_employee(db, "emp_1")
    add_allocation(db, "a1", 1, employee_id="emp_1")
    add_allocation(db, "a2", 1, employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)

    assert db.execute("SELECT COUNT(*) FROM assignments").fetchone()[0] == 1
    assert db.execute("SELECT COUNT(*) FROM assignment_items").fetchone()[0] == 2


def test_036_numbers_recovered_assignments_after_the_historical_ones(db):
    # Восстановленные выдачи не втискиваются в середину нумерации:
    # у них нет даты, и место в хронологии определить нечем.
    add_asset(db, "a1", "NB-0042")
    add_asset(db, "a2", "MON-0018")
    add_employee(db, "emp_1")
    add_employee(db, "emp_2", "Петров Пётр")
    add_movement(db, "mov_1", "a1", 1, "2026-09-01", employee_id="emp_1")
    add_allocation(db, "a1", 1, employee_id="emp_1")
    add_allocation(db, "a2", 1, employee_id="emp_2")

    migrations._migrate_036_assignments_backfill(db)

    codes = {
        row["employee_id"]: row["code"]
        for row in db.execute("SELECT employee_id, code FROM assignments")
    }
    assert codes == {"emp_1": "ASSIGN-0001", "emp_2": "ASSIGN-0002"}


def test_036_is_idempotent(db):
    add_asset(db, "a1", "NB-0042")
    add_employee(db, "emp_1")
    add_movement(db, "mov_1", "a1", 1, "2026-09-01", employee_id="emp_1")
    add_allocation(db, "a1", 1, employee_id="emp_1")

    migrations._migrate_036_assignments_backfill(db)
    migrations._migrate_036_assignments_backfill(db)

    assert db.execute("SELECT COUNT(*) FROM assignments").fetchone()[0] == 1
    assert db.execute("SELECT COUNT(*) FROM assignment_items").fetchone()[0] == 1
