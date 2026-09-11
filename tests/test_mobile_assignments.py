"""Мобильные действия и слой выдач.

Мобильный клиент пишет в базу напрямую, минуя POST /api/state. Пока он
правил asset_allocations сам, следующее сохранение с десктопа
пересчитывало проекцию из выдач и молча стирало мобильную операцию.
Эти тесты фиксируют, что мобильные действия идут через выдачи.
"""

import sqlite3
from pathlib import Path

import pytest

import mobile_actions
import server

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    connection.executescript(
        """
        INSERT INTO employees (id, full_name, department) VALUES ('emp_1', 'Иванов Иван', 'IT');
        INSERT INTO employees (id, full_name, department) VALUES ('emp_2', 'Петров Пётр', 'IT');
        INSERT INTO workplaces (id, name, employee_id, department, code)
            VALUES ('wp_7', 'Стол №7', 'emp_1', 'IT', 'WP-0001');
        INSERT INTO assets (id, name, inventory_number, quantity) VALUES ('ast_1', 'Мышь', 'MUS-0001', 5);
        """
    )
    yield connection
    connection.close()


def issue(conn, quantity=2, employee_id="emp_1", **extra):
    mobile_actions.apply_issue(conn, dict({
        "assetId": "ast_1", "employeeId": employee_id, "department": "", "site": "",
        "quantity": quantity, "date": "2026-09-11", "notes": "",
    }, **extra))


def test_mobile_issue_creates_an_assignment(conn):
    issue(conn)

    row = conn.execute("SELECT id, code, employee_id, workplace_id, status FROM assignments").fetchone()
    # Стол подставляется сам, как в форме выдачи на десктопе (§6 ТЗ).
    assert (row["code"], row["employee_id"], row["workplace_id"], row["status"]) == (
        "ASSIGN-0001", "emp_1", "wp_7", "active",
    )
    item = conn.execute("SELECT quantity, scope FROM assignment_items").fetchone()
    assert (item["quantity"], item["scope"]) == (2, "personal")
    movement = conn.execute("SELECT assignment_id FROM movements WHERE type = 'issue'").fetchone()
    assert movement["assignment_id"] == row["id"]


def test_mobile_return_closes_the_assignment(conn):
    issue(conn)
    mobile_actions.apply_return(conn, {
        "assetId": "ast_1", "employeeId": "emp_1", "department": "", "site": "",
        "quantity": 2, "date": "2026-09-12", "notes": "",
    })

    row = conn.execute("SELECT status, returned_at FROM assignments").fetchone()
    assert (row["status"], row["returned_at"]) == ("returned", "2026-09-12")
    # История остаётся (§12 ТЗ), техника снята.
    assert conn.execute("SELECT returned_quantity FROM assignment_items").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM asset_allocations").fetchone()[0] == 0


def test_mobile_repair_from_an_employee_closes_their_assignment(conn):
    issue(conn, quantity=3)
    mobile_actions.apply_repair(conn, {
        "assetId": "ast_1", "sourceType": "employee", "employeeId": "emp_1",
        "quantity": 1, "date": "2026-09-12", "notes": "",
    })
    assert conn.execute("SELECT returned_quantity FROM assignment_items").fetchone()[0] == 1


def test_mobile_repair_return_to_an_employee_opens_a_new_assignment(conn):
    conn.execute("UPDATE assets SET repair_quantity = 1 WHERE id = 'ast_1'")
    mobile_actions.apply_repair_return(conn, {
        "assetId": "ast_1", "targetType": "employee", "employeeId": "emp_2",
        "quantity": 1, "date": "2026-09-12", "notes": "",
    })
    row = conn.execute("SELECT employee_id, status FROM assignments").fetchone()
    assert (row["employee_id"], row["status"]) == ("emp_2", "active")


def test_mobile_return_of_a_legacy_allocation_without_an_assignment(conn):
    # Строка в asset_allocations, которой не объясняет ни одна выдача
    # (старая база, ручная правка). Возврат обязан пройти, а не упасть на
    # «нет выдачи» — сначала сверка восстанавливает выдачу.
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, quantity) VALUES ('ast_1', 'emp_2', 2)"
    )
    mobile_actions.apply_return(conn, {
        "assetId": "ast_1", "employeeId": "emp_2", "department": "", "site": "",
        "quantity": 1, "date": "2026-09-12", "notes": "",
    })
    assert conn.execute(
        "SELECT quantity FROM asset_allocations WHERE employee_id = 'emp_2'"
    ).fetchone()["quantity"] == 1


# ─── Главный сценарий: мобильная операция переживает десктоп ───────

@pytest.fixture
def db(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setattr(server, "DB_PATH", db_path)
    server.init_db()
    with server.get_connection() as connection:
        connection.executescript(
            """
            INSERT INTO employees (id, full_name, department) VALUES ('emp_1', 'Иванов Иван', 'IT');
            INSERT INTO assets (id, name, inventory_number, quantity) VALUES ('ast_1', 'Мышь', 'MUS-0001', 5);
            """
        )
    yield db_path


def test_mobile_issue_survives_the_next_desktop_save(db):
    # Телефон выдаёт мышь. Десктоп получает 409 (мобильное действие
    # подняло state_version), перечитывает состояние и сохраняет его.
    # До перевода мобильных действий на выдачи здесь проекция
    # пересчитывалась из выдач, где мобильной выдачи не было, — и мышь
    # молча возвращалась на склад.
    with server.get_connection() as connection:
        mobile_actions.apply_action(connection, {
            "clientActionId": "phone-1", "type": "issue", "assetId": "ast_1",
            "employeeId": "emp_1", "department": "", "site": "",
            "quantity": 2, "date": "2026-09-11", "notes": "",
        })

    server.import_state(server.export_state(), actor="desktop")

    allocations = server.export_state()["assets"][0]["allocations"]
    assert allocations == [{"employeeId": "emp_1", "department": "", "site": "",
                            "workplaceId": "", "quantity": 2}]


def test_mobile_return_survives_the_next_desktop_save(db):
    with server.get_connection() as connection:
        mobile_actions.apply_action(connection, {
            "clientActionId": "phone-1", "type": "issue", "assetId": "ast_1",
            "employeeId": "emp_1", "department": "", "site": "",
            "quantity": 2, "date": "2026-09-11", "notes": "",
        })
        mobile_actions.apply_action(connection, {
            "clientActionId": "phone-2", "type": "return", "assetId": "ast_1",
            "employeeId": "emp_1", "department": "", "site": "",
            "quantity": 2, "date": "2026-09-12", "notes": "",
        })

    server.import_state(server.export_state(), actor="desktop")

    assert server.export_state()["assets"][0]["allocations"] == []
