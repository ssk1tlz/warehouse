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


def test_apply_issue_creates_new_allocation_and_movement(conn):
    mobile_actions.apply_issue(conn, {
        "assetId": "ast_1", "employeeId": "emp_1", "department": "", "site": "",
        "quantity": 2, "date": "2026-08-22", "notes": "",
    })
    alloc = conn.execute(
        "SELECT quantity FROM asset_allocations WHERE asset_id='ast_1' AND employee_id='emp_1'"
    ).fetchone()
    assert alloc["quantity"] == 2
    movement = conn.execute(
        "SELECT type, employee_id, quantity FROM movements WHERE asset_id='ast_1'"
    ).fetchone()
    assert movement["type"] == "issue"
    assert movement["employee_id"] == "emp_1"
    assert movement["quantity"] == 2


def test_apply_issue_adds_to_existing_allocation(conn):
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
        "VALUES ('ast_1', 'emp_1', '', '', 1)"
    )
    mobile_actions.apply_issue(conn, {
        "assetId": "ast_1", "employeeId": "emp_1", "department": "", "site": "",
        "quantity": 1, "date": "2026-08-22", "notes": "",
    })
    alloc = conn.execute(
        "SELECT quantity FROM asset_allocations WHERE asset_id='ast_1' AND employee_id='emp_1'"
    ).fetchone()
    assert alloc["quantity"] == 2


def test_apply_issue_rejects_insufficient_stock(conn):
    with pytest.raises(mobile_actions.MobileActionError, match="доступно"):
        mobile_actions.apply_issue(conn, {
            "assetId": "ast_1", "employeeId": "emp_1", "department": "", "site": "",
            "quantity": 99, "date": "2026-08-22", "notes": "",
        })


def test_apply_issue_rejects_unknown_asset(conn):
    with pytest.raises(mobile_actions.MobileActionError, match="не найден"):
        mobile_actions.apply_issue(conn, {
            "assetId": "ast_missing", "employeeId": "emp_1", "department": "", "site": "",
            "quantity": 1, "date": "2026-08-22", "notes": "",
        })


def test_apply_issue_rejects_empty_target(conn):
    with pytest.raises(mobile_actions.MobileActionError, match="Выберите"):
        mobile_actions.apply_issue(conn, {
            "assetId": "ast_1", "employeeId": None, "department": "", "site": "",
            "quantity": 1, "date": "2026-08-22", "notes": "",
        })


def test_apply_return_reduces_allocation(conn):
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
        "VALUES ('ast_1', 'emp_1', '', '', 3)"
    )
    mobile_actions.apply_return(conn, {
        "assetId": "ast_1", "employeeId": "emp_1", "department": "", "site": "",
        "quantity": 2, "date": "2026-08-22", "notes": "",
    })
    alloc = conn.execute(
        "SELECT quantity FROM asset_allocations WHERE asset_id='ast_1' AND employee_id='emp_1'"
    ).fetchone()
    assert alloc["quantity"] == 1


def test_apply_return_deletes_allocation_row_when_it_hits_zero(conn):
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
        "VALUES ('ast_1', 'emp_1', '', '', 2)"
    )
    mobile_actions.apply_return(conn, {
        "assetId": "ast_1", "employeeId": "emp_1", "department": "", "site": "",
        "quantity": 2, "date": "2026-08-22", "notes": "",
    })
    alloc = conn.execute(
        "SELECT * FROM asset_allocations WHERE asset_id='ast_1' AND employee_id='emp_1'"
    ).fetchone()
    assert alloc is None


def test_apply_return_rejects_when_no_allocation(conn):
    with pytest.raises(mobile_actions.MobileActionError, match="нет позиции"):
        mobile_actions.apply_return(conn, {
            "assetId": "ast_1", "employeeId": "emp_1", "department": "", "site": "",
            "quantity": 1, "date": "2026-08-22", "notes": "",
        })


def test_apply_return_rejects_over_return(conn):
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
        "VALUES ('ast_1', 'emp_1', '', '', 1)"
    )
    with pytest.raises(mobile_actions.MobileActionError, match="числится"):
        mobile_actions.apply_return(conn, {
            "assetId": "ast_1", "employeeId": "emp_1", "department": "", "site": "",
            "quantity": 2, "date": "2026-08-22", "notes": "",
        })


def test_apply_return_rejects_empty_target(conn):
    with pytest.raises(mobile_actions.MobileActionError, match="Выберите"):
        mobile_actions.apply_return(conn, {
            "assetId": "ast_1", "employeeId": None, "department": "", "site": "",
            "quantity": 1, "date": "2026-08-22", "notes": "",
        })


def test_apply_repair_from_warehouse_stock(conn):
    mobile_actions.apply_repair(conn, {
        "assetId": "ast_1", "sourceType": "warehouse", "employeeId": None,
        "quantity": 2, "date": "2026-08-22", "notes": "",
    })
    asset = conn.execute("SELECT repair_quantity, repair_date FROM assets WHERE id='ast_1'").fetchone()
    assert asset["repair_quantity"] == 2
    assert asset["repair_date"] == "2026-08-22"
    movement = conn.execute("SELECT type, quantity FROM movements WHERE asset_id='ast_1'").fetchone()
    assert movement["type"] == "repair"
    assert movement["quantity"] == 2


def test_apply_repair_from_employee_reduces_their_allocation(conn):
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
        "VALUES ('ast_1', 'emp_1', '', '', 3)"
    )
    mobile_actions.apply_repair(conn, {
        "assetId": "ast_1", "sourceType": "employee", "employeeId": "emp_1",
        "quantity": 1, "date": "2026-08-22", "notes": "",
    })
    alloc = conn.execute(
        "SELECT quantity FROM asset_allocations WHERE asset_id='ast_1' AND employee_id='emp_1'"
    ).fetchone()
    assert alloc["quantity"] == 2
    asset = conn.execute("SELECT repair_quantity FROM assets WHERE id='ast_1'").fetchone()
    assert asset["repair_quantity"] == 1


def test_apply_repair_rejects_insufficient_warehouse_stock(conn):
    with pytest.raises(mobile_actions.MobileActionError, match="Доступно"):
        mobile_actions.apply_repair(conn, {
            "assetId": "ast_1", "sourceType": "warehouse", "employeeId": None,
            "quantity": 99, "date": "2026-08-22", "notes": "",
        })


def test_apply_repair_rejects_employee_without_allocation(conn):
    with pytest.raises(mobile_actions.MobileActionError, match="нет этой техники"):
        mobile_actions.apply_repair(conn, {
            "assetId": "ast_1", "sourceType": "employee", "employeeId": "emp_1",
            "quantity": 1, "date": "2026-08-22", "notes": "",
        })


def test_apply_repair_return_to_warehouse(conn):
    conn.execute("UPDATE assets SET repair_quantity = 3, repair_date = '2026-08-01' WHERE id = 'ast_1'")
    mobile_actions.apply_repair_return(conn, {
        "assetId": "ast_1", "targetType": "warehouse", "employeeId": None,
        "quantity": 2, "date": "2026-08-22", "notes": "",
    })
    asset = conn.execute("SELECT repair_quantity, repair_date FROM assets WHERE id='ast_1'").fetchone()
    assert asset["repair_quantity"] == 1
    assert asset["repair_date"] == "2026-08-01"  # still some in repair -> date stays


def test_apply_repair_return_clears_repair_date_when_none_left(conn):
    conn.execute("UPDATE assets SET repair_quantity = 2, repair_date = '2026-08-01' WHERE id = 'ast_1'")
    mobile_actions.apply_repair_return(conn, {
        "assetId": "ast_1", "targetType": "warehouse", "employeeId": None,
        "quantity": 2, "date": "2026-08-22", "notes": "",
    })
    asset = conn.execute("SELECT repair_quantity, repair_date FROM assets WHERE id='ast_1'").fetchone()
    assert asset["repair_quantity"] == 0
    assert asset["repair_date"] == ""


def test_apply_repair_return_to_employee_creates_allocation(conn):
    conn.execute("UPDATE assets SET repair_quantity = 1 WHERE id = 'ast_1'")
    mobile_actions.apply_repair_return(conn, {
        "assetId": "ast_1", "targetType": "employee", "employeeId": "emp_1",
        "quantity": 1, "date": "2026-08-22", "notes": "",
    })
    alloc = conn.execute(
        "SELECT quantity FROM asset_allocations WHERE asset_id='ast_1' AND employee_id='emp_1'"
    ).fetchone()
    assert alloc["quantity"] == 1


def test_apply_repair_return_rejects_over_return(conn):
    conn.execute("UPDATE assets SET repair_quantity = 1 WHERE id = 'ast_1'")
    with pytest.raises(mobile_actions.MobileActionError, match="В ремонте числится"):
        mobile_actions.apply_repair_return(conn, {
            "assetId": "ast_1", "targetType": "warehouse", "employeeId": None,
            "quantity": 2, "date": "2026-08-22", "notes": "",
        })


def test_apply_repair_return_requires_employee_when_target_is_employee(conn):
    conn.execute("UPDATE assets SET repair_quantity = 1 WHERE id = 'ast_1'")
    with pytest.raises(mobile_actions.MobileActionError, match="Выберите сотрудника"):
        mobile_actions.apply_repair_return(conn, {
            "assetId": "ast_1", "targetType": "employee", "employeeId": None,
            "quantity": 1, "date": "2026-08-22", "notes": "",
        })
