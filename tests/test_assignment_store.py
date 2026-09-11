"""Выдачи в базе: проекция, сверка с asset_allocations, запись операций.

assignment_store — общий слой для сервера и мобильных действий. Мобильный
клиент пишет в базу напрямую, минуя POST /api/state, поэтому правило
«asset_allocations — проекция выдач» обязано соблюдаться и там, иначе
следующее сохранение с десктопа пересчитает проекцию из выдач и молча
сотрёт мобильную операцию.
"""

import sqlite3
from pathlib import Path

import pytest

import assignment_store as store

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    connection.executescript(
        """
        INSERT INTO employees (id, full_name, department) VALUES ('emp_1', 'Иванов Иван', 'IT');
        INSERT INTO employees (id, full_name, department) VALUES ('emp_2', 'Петров Пётр', 'IT');
        INSERT INTO workplaces (id, name, employee_id, department, code)
            VALUES ('wp_7', 'Стол №7', 'emp_1', 'IT', 'WP-0001');
        INSERT INTO assets (id, name, inventory_number, quantity) VALUES ('nb', 'Ноутбук', 'NB-0042', 1);
        INSERT INTO assets (id, name, inventory_number, quantity) VALUES ('mus', 'Мышь', 'MUS-0001', 5);
        """
    )
    yield connection
    connection.close()


def allocations(conn, asset_id):
    return sorted(
        (row["employee_id"], row["department"], row["site"], row["workplace_id"], row["quantity"])
        for row in conn.execute(
            "SELECT employee_id, department, site, workplace_id, quantity "
            "FROM asset_allocations WHERE asset_id = ?", (asset_id,)
        )
    )


def active(conn, asset_id):
    return conn.execute(
        "SELECT COALESCE(SUM(quantity - returned_quantity), 0) FROM assignment_items WHERE asset_id = ?",
        (asset_id,),
    ).fetchone()[0]


# ─── создание выдачи ─────────────────────────────────────────────

def test_create_assignment_gets_a_server_owned_code(conn):
    assignment_id = store.create_assignment(
        conn, employee_id="emp_1", issued_at="2026-09-11",
        items=[{"asset_id": "nb", "quantity": 1, "scope": "personal"}],
    )
    row = conn.execute("SELECT code, status FROM assignments WHERE id = ?", (assignment_id,)).fetchone()
    assert (row["code"], row["status"]) == ("ASSIGN-0001", "active")


def test_create_assignment_continues_the_numbering(conn):
    store.create_assignment(conn, employee_id="emp_1", items=[{"asset_id": "nb", "quantity": 1}])
    second = store.create_assignment(conn, employee_id="emp_2", items=[{"asset_id": "mus", "quantity": 1}])
    assert conn.execute("SELECT code FROM assignments WHERE id = ?", (second,)).fetchone()["code"] == "ASSIGN-0002"


def test_rebuild_writes_the_projection_of_active_items(conn):
    store.create_assignment(conn, employee_id="emp_1", items=[{"asset_id": "mus", "quantity": 3}])
    store.rebuild_asset_allocations(conn, "mus")
    assert allocations(conn, "mus") == [("emp_1", "", "", "", 3)]


def test_rebuild_replaces_whatever_was_there_before(conn):
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, quantity) VALUES ('mus', 'emp_2', 4)"
    )
    store.create_assignment(conn, employee_id="emp_1", items=[{"asset_id": "mus", "quantity": 1}])
    store.rebuild_asset_allocations(conn, "mus")
    assert allocations(conn, "mus") == [("emp_1", "", "", "", 1)]


# ─── закрытие позиций ────────────────────────────────────────────

def test_close_items_takes_the_oldest_issue_first(conn):
    older = store.create_assignment(conn, employee_id="emp_1", issued_at="2026-09-01",
                                    items=[{"asset_id": "mus", "quantity": 1}])
    newer = store.create_assignment(conn, employee_id="emp_1", issued_at="2026-09-05",
                                    items=[{"asset_id": "mus", "quantity": 2}])

    touched = store.close_items(conn, "mus", 2, "2026-09-11", recipient=("emp_1", "", "", ""))

    assert touched == [older, newer]
    status = {row["id"]: row["status"] for row in conn.execute("SELECT id, status FROM assignments")}
    assert status == {older: "returned", newer: "active"}
    assert active(conn, "mus") == 1


def test_close_items_keeps_the_rows_for_history(conn):
    # §12 ТЗ: возврат не удаляет выдачу, а закрывает её.
    assignment_id = store.create_assignment(conn, employee_id="emp_1",
                                            items=[{"asset_id": "nb", "quantity": 1}])
    store.close_items(conn, "nb", 1, "2026-09-11", recipient=("emp_1", "", "", ""))

    row = conn.execute("SELECT status, returned_at FROM assignments WHERE id = ?", (assignment_id,)).fetchone()
    item = conn.execute("SELECT returned_quantity, returned_at FROM assignment_items").fetchone()
    assert (row["status"], row["returned_at"]) == ("returned", "2026-09-11")
    assert (item["returned_quantity"], item["returned_at"]) == (1, "2026-09-11")


def test_close_items_ignores_other_recipients(conn):
    store.create_assignment(conn, employee_id="emp_2", items=[{"asset_id": "mus", "quantity": 2}])
    with pytest.raises(store.NotEnoughHeld):
        store.close_items(conn, "mus", 1, "2026-09-11", recipient=("emp_1", "", "", ""))
    assert active(conn, "mus") == 2, "чужая выдача не тронута"


def test_close_items_refuses_more_than_held_and_changes_nothing(conn):
    store.create_assignment(conn, employee_id="emp_1", items=[{"asset_id": "mus", "quantity": 1}])
    with pytest.raises(store.NotEnoughHeld):
        store.close_items(conn, "mus", 3, "2026-09-11", recipient=("emp_1", "", "", ""))
    assert active(conn, "mus") == 1


def test_held_quantity_counts_only_the_given_recipient(conn):
    store.create_assignment(conn, employee_id="emp_1", items=[{"asset_id": "mus", "quantity": 2}])
    store.create_assignment(conn, department="IT", items=[{"asset_id": "mus", "quantity": 1}])
    assert store.held_quantity(conn, "mus", ("emp_1", "", "", "")) == 2
    assert store.held_quantity(conn, "mus", (None, "IT", "", "")) == 1


# ─── сверка с asset_allocations: состояние главнее ───────────────

def test_reconcile_recovers_an_allocation_no_assignment_explains(conn):
    # Строка в asset_allocations без выдачи: старая база, тест, старая
    # вкладка браузера. Технику терять нельзя — заводим выдачу.
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, quantity) VALUES ('mus', 'emp_1', 2)"
    )
    store.reconcile_asset(conn, "mus", "2026-09-11")

    row = conn.execute("SELECT employee_id, code, issued_at, notes FROM assignments").fetchone()
    assert (row["employee_id"], row["code"], row["issued_at"]) == ("emp_1", "ASSIGN-0001", "")
    assert "неизвестна" in row["notes"]
    assert active(conn, "mus") == 2


def test_reconcile_closes_what_the_state_no_longer_holds(conn):
    # Выдача числит 3, а в состоянии осталось 1: две вернули в обход
    # выдачи. Закрываем лишнее, начиная со старых.
    store.create_assignment(conn, employee_id="emp_1", items=[{"asset_id": "mus", "quantity": 3}])
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, quantity) VALUES ('mus', 'emp_1', 1)"
    )
    store.reconcile_asset(conn, "mus", "2026-09-11")
    assert active(conn, "mus") == 1


def test_reconcile_is_a_noop_when_state_and_assignments_agree(conn):
    store.create_assignment(conn, employee_id="emp_1", items=[{"asset_id": "mus", "quantity": 2}])
    store.rebuild_asset_allocations(conn, "mus")
    store.reconcile_asset(conn, "mus", "2026-09-11")
    assert conn.execute("SELECT COUNT(*) FROM assignments").fetchone()[0] == 1
    assert active(conn, "mus") == 2


def test_reconcile_normalizes_a_legacy_employee_and_site_row(conn):
    # Старый мобильный клиент мог записать строку с сотрудником И
    # объектом. Выдачу с двумя хозяевами серверная валидация отвергнет,
    # и десктоп перестанет сохраняться — поэтому побеждает сотрудник.
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, site, quantity) "
        "VALUES ('mus', 'emp_1', 'SiteA', 2)"
    )
    store.reconcile_asset(conn, "mus", "2026-09-11")
    store.rebuild_asset_allocations(conn, "mus")

    row = conn.execute("SELECT employee_id, site FROM assignments").fetchone()
    assert (row["employee_id"], row["site"]) == ("emp_1", "")
    assert allocations(conn, "mus") == [("emp_1", "", "", "", 2)]


def test_reconcile_recovers_a_desk_allocation_with_workplace_scope(conn):
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, workplace_id, quantity) "
        "VALUES ('mus', NULL, 'wp_7', 1)"
    )
    store.reconcile_asset(conn, "mus", "2026-09-11")
    assert conn.execute("SELECT scope FROM assignment_items").fetchone()["scope"] == "workplace"
    store.rebuild_asset_allocations(conn, "mus")
    assert allocations(conn, "mus") == [(None, "", "", "wp_7", 1)]


# ─── правило проекции — то же, что в asset_ops.js ────────────────

def test_workplace_scope_projects_onto_the_desk():
    assignment = {"employeeId": "emp_1", "workplaceId": "wp_7", "department": "", "site": "",
                  "items": [{"assetId": "nb", "quantity": 1, "returnedQuantity": 0, "scope": "workplace"}]}
    assert store.project_allocations([assignment]) == {
        "nb": [{"employeeId": None, "department": "", "site": "", "workplaceId": "wp_7", "quantity": 1}],
    }
