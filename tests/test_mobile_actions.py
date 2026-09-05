import sqlite3
from pathlib import Path

import pytest

import mobile_actions

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
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


def test_apply_repair_employee_source_without_employee_id_raises(conn):
    # Regression for review Finding 1a: a site-only allocation row
    # (employee_id IS NULL, department == '') satisfies
    # find_employee_allocation(allocations, None), so calling apply_repair
    # with sourceType="employee" and no employeeId used to silently match
    # this unrelated site allocation instead of being rejected outright.
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
        "VALUES ('ast_1', NULL, '', 'SiteA', 3)"
    )
    with pytest.raises(mobile_actions.MobileActionError, match="сотрудника"):
        mobile_actions.apply_repair(conn, {
            "assetId": "ast_1", "sourceType": "employee", "employeeId": None,
            "quantity": 1, "date": "2026-08-22", "notes": "",
        })
    # The guard must fire before any mutation — the site allocation and
    # repair_quantity must be completely untouched.
    alloc = conn.execute(
        "SELECT quantity FROM asset_allocations WHERE asset_id='ast_1' AND site='SiteA'"
    ).fetchone()
    assert alloc["quantity"] == 3
    asset = conn.execute("SELECT repair_quantity FROM assets WHERE id='ast_1'").fetchone()
    assert asset["repair_quantity"] == 0


def test_apply_repair_from_employee_with_site_allocation_reduces_it(conn):
    # Regression for review Finding 1b: an allocation can have both
    # employeeId and site set at once — find_employee_allocation() ignores
    # site entirely, so apply_issue can (and does, below) create such a row.
    # apply_repair's employee branch used to filter its UPDATE/DELETE with a
    # hardcoded "department = '' AND site = ''" instead of the matched row's
    # own site, so it matched zero rows and silently failed to reduce it.
    mobile_actions.apply_issue(conn, {
        "assetId": "ast_1", "employeeId": "emp_1", "department": "", "site": "SiteA",
        "quantity": 3, "date": "2026-08-22", "notes": "",
    })
    alloc = conn.execute(
        "SELECT employee_id, site, quantity FROM asset_allocations WHERE asset_id='ast_1'"
    ).fetchone()
    assert alloc["employee_id"] == "emp_1" and alloc["site"] == "SiteA" and alloc["quantity"] == 3

    mobile_actions.apply_repair(conn, {
        "assetId": "ast_1", "sourceType": "employee", "employeeId": "emp_1",
        "quantity": 1, "date": "2026-08-22", "notes": "",
    })
    alloc = conn.execute(
        "SELECT quantity FROM asset_allocations WHERE asset_id='ast_1' AND employee_id='emp_1' AND site='SiteA'"
    ).fetchone()
    assert alloc["quantity"] == 2  # correctly reduced, not silently left at 3
    asset = conn.execute("SELECT repair_quantity FROM assets WHERE id='ast_1'").fetchone()
    assert asset["repair_quantity"] == 1


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


def test_apply_repair_return_credits_employee_with_site_allocation(conn):
    # Regression for review Finding 2: same root cause as Finding 1b, but in
    # apply_repair_return's employee credit-back branch. An existing
    # allocation with both employeeId and site set used to be credited via a
    # hardcoded "department = '' AND site = ''" filter, matching zero rows
    # and silently losing the units from tracking entirely (repair_quantity
    # still decremented, but the employee's allocation was never credited).
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
        "VALUES ('ast_1', 'emp_1', '', 'SiteA', 2)"
    )
    conn.execute("UPDATE assets SET repair_quantity = 1 WHERE id = 'ast_1'")
    mobile_actions.apply_repair_return(conn, {
        "assetId": "ast_1", "targetType": "employee", "employeeId": "emp_1",
        "quantity": 1, "date": "2026-08-22", "notes": "",
    })
    alloc = conn.execute(
        "SELECT quantity FROM asset_allocations WHERE asset_id='ast_1' AND employee_id='emp_1' AND site='SiteA'"
    ).fetchone()
    assert alloc["quantity"] == 3  # correctly credited back, not left at 2
    asset = conn.execute("SELECT repair_quantity FROM assets WHERE id='ast_1'").fetchone()
    assert asset["repair_quantity"] == 0


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


def test_apply_retire_reduces_quantity_and_increases_retired(conn):
    mobile_actions.apply_retire(conn, {
        "assetId": "ast_1", "quantity": 2, "date": "2026-08-22", "notes": "сломан",
    })
    asset = conn.execute("SELECT quantity, retired_quantity FROM assets WHERE id='ast_1'").fetchone()
    assert asset["quantity"] == 3
    assert asset["retired_quantity"] == 2
    movement = conn.execute("SELECT type, quantity, notes FROM movements WHERE asset_id='ast_1'").fetchone()
    assert movement["type"] == "retire"
    assert movement["quantity"] == 2
    assert movement["notes"] == "сломан"


def test_apply_retire_rejects_insufficient_available(conn):
    with pytest.raises(mobile_actions.MobileActionError, match="Доступно"):
        mobile_actions.apply_retire(conn, {
            "assetId": "ast_1", "quantity": 99, "date": "2026-08-22", "notes": "",
        })


def test_apply_edit_updates_editable_fields_and_logs_movement(conn):
    mobile_actions.apply_edit(conn, {
        "assetId": "ast_1", "baseRev": 0, "name": "Ноутбук Dell XPS", "category": "Ноутбуки премиум",
        "inventoryNumber": "INV-002", "serialNumber": "SN-002", "location": "Каб. 305",
        "purchaseDate": "2026-02-01", "warrantyEnd": "2028-02-01",
    })
    asset = conn.execute(
        "SELECT name, category, inventory_number, serial_number, location, purchase_date, warranty_end "
        "FROM assets WHERE id='ast_1'"
    ).fetchone()
    assert asset["name"] == "Ноутбук Dell XPS"
    assert asset["category"] == "Ноутбуки премиум"
    assert asset["inventory_number"] == "INV-002"
    assert asset["serial_number"] == "SN-002"
    assert asset["location"] == "Каб. 305"
    assert asset["purchase_date"] == "2026-02-01"
    assert asset["warranty_end"] == "2028-02-01"
    movement = conn.execute("SELECT type, quantity FROM movements WHERE asset_id='ast_1'").fetchone()
    assert movement["type"] == "edit"
    assert movement["quantity"] == 5  # asset's quantity at edit time, unchanged by editing


def test_apply_edit_does_not_touch_quantity_or_allocations(conn):
    conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
        "VALUES ('ast_1', 'emp_1', '', '', 2)"
    )
    mobile_actions.apply_edit(conn, {
        "assetId": "ast_1", "baseRev": 0, "name": "Ноутбук Dell", "category": "Ноутбуки",
        "inventoryNumber": "INV-001", "serialNumber": "SN-001", "location": "",
        "purchaseDate": "2026-01-01", "warrantyEnd": "",
    })
    asset = conn.execute("SELECT quantity FROM assets WHERE id='ast_1'").fetchone()
    assert asset["quantity"] == 5
    alloc = conn.execute(
        "SELECT quantity FROM asset_allocations WHERE asset_id='ast_1' AND employee_id='emp_1'"
    ).fetchone()
    assert alloc["quantity"] == 2


def test_apply_edit_rejects_blank_name(conn):
    with pytest.raises(mobile_actions.MobileActionError, match="Название"):
        mobile_actions.apply_edit(conn, {
            "assetId": "ast_1", "name": "   ", "category": "Ноутбуки",
            "inventoryNumber": "INV-001", "serialNumber": "SN-001",
        })


def test_apply_edit_rejects_unknown_asset(conn):
    with pytest.raises(mobile_actions.MobileActionError, match="не найден"):
        mobile_actions.apply_edit(conn, {"assetId": "ast_missing", "name": "X"})


def test_apply_action_dispatches_edit(conn):
    result = mobile_actions.apply_action(conn, {
        "clientActionId": "44444444-4444-4444-4444-444444444444",
        "type": "edit", "assetId": "ast_1", "baseRev": 0, "name": "Ноутбук Dell Renamed",
        "category": "Ноутбуки", "inventoryNumber": "INV-001", "serialNumber": "SN-001",
        "location": "", "purchaseDate": "2026-01-01", "warrantyEnd": "",
    })
    assert result["assetId"] == "ast_1"
    assert result["replayed"] is False
    assert result["rev"] == 1
    asset = conn.execute("SELECT name FROM assets WHERE id='ast_1'").fetchone()
    assert asset["name"] == "Ноутбук Dell Renamed"


def test_apply_action_dispatches_issue(conn):
    result = mobile_actions.apply_action(conn, {
        "clientActionId": "11111111-1111-1111-1111-111111111111",
        "type": "issue", "assetId": "ast_1", "employeeId": "emp_1",
        "department": "", "site": "", "quantity": 1, "date": "2026-08-22", "notes": "",
    })
    assert result["assetId"] == "ast_1"
    assert result["replayed"] is False
    alloc = conn.execute(
        "SELECT quantity FROM asset_allocations WHERE asset_id='ast_1' AND employee_id='emp_1'"
    ).fetchone()
    assert alloc["quantity"] == 1


def test_apply_action_rejects_unknown_type(conn):
    with pytest.raises(mobile_actions.MobileActionError, match="Неизвестный тип"):
        mobile_actions.apply_action(conn, {
            "clientActionId": "22222222-2222-2222-2222-222222222222",
            "type": "teleport", "assetId": "ast_1", "quantity": 1, "date": "2026-08-22",
        })


def test_apply_action_rejects_missing_client_action_id(conn):
    with pytest.raises(mobile_actions.MobileActionError, match="clientActionId"):
        mobile_actions.apply_action(conn, {
            "type": "issue", "assetId": "ast_1", "employeeId": "emp_1", "quantity": 1, "date": "2026-08-22",
        })


def test_apply_issue_raises_integrity_error_for_unknown_employee(conn):
    # Regression for review Finding 3/4: server.py's get_connection() always
    # runs PRAGMA foreign_keys = ON (see Finding 4 — this fixture now matches
    # that). A stale employeeId (e.g. an employee deleted after an offline
    # mobile action was queued) violates the FK on movements.employee_id ->
    # employees.id. mobile_actions.py intentionally does NOT catch this —
    # it's server.py's job (handle_mobile_action's broader except clause) to
    # turn it into an HTTP 400 instead of letting the connection just close.
    with pytest.raises(sqlite3.IntegrityError):
        mobile_actions.apply_issue(conn, {
            "assetId": "ast_1", "employeeId": "emp_ghost", "department": "", "site": "",
            "quantity": 1, "date": "2026-08-22", "notes": "",
        })


def test_apply_edit_succeeds_with_matching_base_rev_and_bumps_rev(conn):
    action = {
        "clientActionId": "c1", "type": "edit", "assetId": "ast_1",
        "baseRev": 0, "name": "Новое имя", "category": "", "inventoryNumber": "",
        "serialNumber": "", "location": "", "purchaseDate": "", "warrantyEnd": "",
    }
    result = mobile_actions.apply_action(conn, action)
    assert result["rev"] == 1
    row = conn.execute("SELECT name, rev FROM assets WHERE id='ast_1'").fetchone()
    assert row["name"] == "Новое имя"
    assert row["rev"] == 1


def test_apply_edit_rejects_stale_base_rev(conn):
    action = {
        "clientActionId": "c1", "type": "edit", "assetId": "ast_1",
        "baseRev": 5, "name": "Новое имя", "category": "", "inventoryNumber": "",
        "serialNumber": "", "location": "", "purchaseDate": "", "warrantyEnd": "",
    }
    with pytest.raises(mobile_actions.EditConflictError) as excinfo:
        mobile_actions.apply_action(conn, action)
    assert excinfo.value.current_asset["rev"] == 0
    assert excinfo.value.current_asset["name"] == "Ноутбук Dell"  # seeded name, unchanged


def test_apply_edit_requires_base_rev(conn):
    action = {
        "clientActionId": "c1", "type": "edit", "assetId": "ast_1",
        "name": "Новое имя", "category": "", "inventoryNumber": "",
        "serialNumber": "", "location": "", "purchaseDate": "", "warrantyEnd": "",
    }
    with pytest.raises(mobile_actions.MobileActionError):
        mobile_actions.apply_action(conn, action)


def test_apply_issue_does_not_change_rev(conn):
    action = {
        "clientActionId": "c1", "type": "issue", "assetId": "ast_1",
        "employeeId": "emp_1", "quantity": 1,
    }
    mobile_actions.apply_action(conn, action)
    row = conn.execute("SELECT rev FROM assets WHERE id='ast_1'").fetchone()
    assert row["rev"] == 0


def test_apply_action_replay_does_not_double_apply(conn):
    action = {
        "clientActionId": "33333333-3333-3333-3333-333333333333",
        "type": "issue", "assetId": "ast_1", "employeeId": "emp_1",
        "department": "", "site": "", "quantity": 1, "date": "2026-08-22", "notes": "",
    }
    first = mobile_actions.apply_action(conn, action)
    second = mobile_actions.apply_action(conn, action)
    assert first["replayed"] is False
    assert second["replayed"] is True
    alloc = conn.execute(
        "SELECT quantity FROM asset_allocations WHERE asset_id='ast_1' AND employee_id='emp_1'"
    ).fetchone()
    assert alloc["quantity"] == 1  # still 1, not 2 — the replay did not re-apply


# ─── Техника общего пользования ────────────────────────────────────────────

@pytest.fixture
def shared_conn(conn):
    """Один ЮПС, которым пользуются двое: quantity = 1, is_shared = 1."""
    conn.execute(
        "INSERT INTO employees (id, full_name, department, site, position, email, phone) "
        "VALUES ('emp_2', 'Петрова Анна', 'IT', '', 'Бухгалтер', '', '')"
    )
    conn.execute(
        "INSERT INTO assets (id, name, category, inventory_number, serial_number, purchase_date, "
        "status, notes, quantity, repair_quantity, retired_quantity, min_quantity, "
        "warranty_end, price, repair_date, location, photo_url, is_shared) "
        "VALUES ('ast_ups', 'ЮПС APC', 'ИБП', 'INV-UPS', 'SN-UPS', '2026-01-01', "
        "'in_stock', '', 1, 0, 0, 0, '', 0, '', '', '', 1)"
    )
    conn.commit()
    return conn


def _allocations(conn, asset_id):
    return list(conn.execute("SELECT * FROM asset_allocations WHERE asset_id = ?", (asset_id,)))


def test_shared_asset_can_be_issued_to_two_employees(shared_conn):
    for employee_id in ("emp_1", "emp_2"):
        mobile_actions.apply_issue(
            shared_conn, {"assetId": "ast_ups", "employeeId": employee_id, "quantity": 1}
        )
    holders = _allocations(shared_conn, "ast_ups")
    assert sorted(row["employee_id"] for row in holders) == ["emp_1", "emp_2"]
    assert all(row["quantity"] == 1 for row in holders)


def test_shared_allocated_quantity_is_the_max_not_the_sum(shared_conn):
    for employee_id in ("emp_1", "emp_2"):
        mobile_actions.apply_issue(
            shared_conn, {"assetId": "ast_ups", "employeeId": employee_id, "quantity": 1}
        )
    asset = shared_conn.execute("SELECT * FROM assets WHERE id = 'ast_ups'").fetchone()
    allocations = _allocations(shared_conn, "ast_ups")
    assert mobile_actions.get_allocated_quantity(allocations, shared=True) == 1
    assert mobile_actions.get_allocated_quantity(allocations) == 2  # обычная позиция считала бы 2
    assert mobile_actions.get_available_quantity(asset, allocations) == 0


def test_shared_asset_still_capped_per_holder(shared_conn):
    mobile_actions.apply_issue(
        shared_conn, {"assetId": "ast_ups", "employeeId": "emp_1", "quantity": 1}
    )
    with pytest.raises(mobile_actions.MobileActionError) as excinfo:
        mobile_actions.apply_issue(
            shared_conn, {"assetId": "ast_ups", "employeeId": "emp_1", "quantity": 1}
        )
    assert "доступно: 0" in str(excinfo.value)


def test_shared_asset_in_repair_cannot_be_issued(shared_conn):
    shared_conn.execute("UPDATE assets SET repair_quantity = 1 WHERE id = 'ast_ups'")
    with pytest.raises(mobile_actions.MobileActionError):
        mobile_actions.apply_issue(
            shared_conn, {"assetId": "ast_ups", "employeeId": "emp_1", "quantity": 1}
        )


def test_non_shared_asset_still_blocks_the_second_holder(shared_conn):
    """Контроль: без флага та же выдача двоим упирается в количество."""
    shared_conn.execute("UPDATE assets SET is_shared = 0 WHERE id = 'ast_ups'")
    mobile_actions.apply_issue(
        shared_conn, {"assetId": "ast_ups", "employeeId": "emp_1", "quantity": 1}
    )
    with pytest.raises(mobile_actions.MobileActionError):
        mobile_actions.apply_issue(
            shared_conn, {"assetId": "ast_ups", "employeeId": "emp_2", "quantity": 1}
        )


def test_shared_asset_return_frees_only_that_holder(shared_conn):
    for employee_id in ("emp_1", "emp_2"):
        mobile_actions.apply_issue(
            shared_conn, {"assetId": "ast_ups", "employeeId": employee_id, "quantity": 1}
        )
    mobile_actions.apply_return(
        shared_conn, {"assetId": "ast_ups", "employeeId": "emp_1", "quantity": 1}
    )
    holders = _allocations(shared_conn, "ast_ups")
    assert [row["employee_id"] for row in holders] == ["emp_2"]
    asset = shared_conn.execute("SELECT * FROM assets WHERE id = 'ast_ups'").fetchone()
    assert mobile_actions.get_available_quantity(asset, holders) == 0
