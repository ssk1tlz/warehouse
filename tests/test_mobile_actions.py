import sqlite3
from pathlib import Path

import pytest

import mobile_actions

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS mobile_action_log (
            client_action_id TEXT PRIMARY KEY,
            response_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        INSERT INTO employees (id, full_name, department, site, position, email, phone)
            VALUES ('emp_1', 'Иванов Иван', 'IT', '', 'Инженер', '', '');
        INSERT INTO assets (id, name, category, inventory_number, serial_number, purchase_date,
            status, notes, quantity, repair_quantity, retired_quantity, min_quantity,
            warranty_end, price, repair_date, location, photo_url)
            VALUES ('ast_1', 'Ноутбук Dell', 'Ноутбуки', 'INV-001', 'SN-001', '2026-01-01',
            'in_stock', '', 5, 0, 0, 0, '', 0, '', '', '');
        """
    )
    connection.commit()
    yield connection
    connection.close()


def test_get_allocated_quantity_sums_all_allocations(conn):
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
        "VALUES ('ast_1', 'emp_1', '', '', 2)"
    )
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
        "VALUES ('ast_1', NULL, 'IT', '', 1)"
    )
    allocations = list(conn.execute("SELECT * FROM asset_allocations WHERE asset_id = 'ast_1'"))
    assert mobile_actions.get_allocated_quantity(allocations) == 3


def test_get_available_quantity_subtracts_allocated_and_repair(conn):
    conn.execute(
        "UPDATE assets SET repair_quantity = 1 WHERE id = 'ast_1'"
    )
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
        "VALUES ('ast_1', 'emp_1', '', '', 2)"
    )
    asset_row = conn.execute("SELECT * FROM assets WHERE id = 'ast_1'").fetchone()
    allocations = list(conn.execute("SELECT * FROM asset_allocations WHERE asset_id = 'ast_1'"))
    # quantity=5, allocated=2, repair=1 -> available=2
    assert mobile_actions.get_available_quantity(asset_row, allocations) == 2


def test_find_employee_allocation_ignores_department_rows(conn):
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
        "VALUES ('ast_1', NULL, 'IT', '', 4)"
    )
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
        "VALUES ('ast_1', 'emp_1', '', '', 1)"
    )
    allocations = list(conn.execute("SELECT * FROM asset_allocations WHERE asset_id = 'ast_1'"))
    found = mobile_actions.find_employee_allocation(allocations, "emp_1")
    assert found is not None
    assert found["quantity"] == 1
