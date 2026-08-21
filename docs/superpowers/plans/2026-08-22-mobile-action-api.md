# Mobile Action API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-side `POST /api/mobile/action` endpoint that applies one discrete inventory action (issue / return / repair / repair_return / retire) atomically and idempotently, so the future mobile app can queue actions offline and replay them safely.

**Architecture:** New pure-logic module `mobile_actions.py` holds the business rules (ported from the equivalent handlers in `app.js`) and talks to SQLite directly. `server.py` gains one new route that parses the request body, calls into `mobile_actions.py` inside the existing `STATE_LOCK`, and returns the updated asset + state version — mirroring how `POST /api/state` already works, but for one action instead of a full state replace.

**Tech Stack:** Python 3.12, stdlib `sqlite3` (no new runtime dependency), `pytest` for tests (new dev dependency — first test suite in this project).

**Spec:** `docs/superpowers/specs/2026-08-22-mobile-scanner-app-design.md` (section B.2 — this plan implements that section only; sections C/D/E are the mobile app, covered by `docs/superpowers/plans/2026-08-22-mobile-scanner-app.md`)

## Global Constraints

- Business rules (available-quantity math, allocation matching, quantity bookkeeping) must match `app.js`'s `handleIssueSubmit`/`handleReturnSubmit`/`handleRepairSubmit`/`handleRepairReturnSubmit`/`handleRetireSubmit` **exactly** — the desktop app and the mobile API must agree on the same numbers for the same DB.
- Every mutation happens inside a single SQLite transaction (`BEGIN` / commit on success / rollback on error) — never leave `assets`/`asset_allocations`/`movements` inconsistent.
- Every successful mutation bumps `app_meta.state_version` the same way `import_state()` already does, so desktop clients polling `GET /api/state` see the change.
- `clientActionId` (a UUID generated on the phone) must be idempotent: replaying the same id returns the previously-computed result without re-applying the mutation.
- No new runtime dependency besides `pytest` (dev-only, not shipped in the frozen `.exe` — it's not imported by `server.py`/`warehouse_tray.py`, so PyInstaller won't bundle it).

---

## File Structure

- Create: `D:\warehouse\mobile_actions.py` — business logic + idempotency store, framework-agnostic (no `http.server` imports), unit-testable in isolation.
- Modify: `D:\warehouse\schema.sql` — add `mobile_action_log` table (so a fresh install has it from the start).
- Modify: `D:\warehouse\server.py` — `init_db()` migration for `mobile_action_log`, import `mobile_actions`, new route in `do_POST`, new `handle_mobile_action()` method on `WarehouseHandler`.
- Create: `D:\warehouse\requirements-dev.txt` — `pytest`, kept separate from `requirements.txt` (which lists what the frozen app actually needs at runtime).
- Create: `D:\warehouse\tests\__init__.py` (empty) and `D:\warehouse\tests\test_mobile_actions.py`.

---

### Task 1: Test scaffolding + pure query helpers

**Files:**
- Create: `D:\warehouse\requirements-dev.txt`
- Create: `D:\warehouse\tests\__init__.py`
- Create: `D:\warehouse\tests\test_mobile_actions.py`
- Create: `D:\warehouse\mobile_actions.py`

**Interfaces:**
- Produces: `mobile_actions.get_allocated_quantity(asset_row: sqlite3.Row, allocations: list[sqlite3.Row]) -> int`, `mobile_actions.get_available_quantity(asset_row, allocations) -> int`, `mobile_actions.find_employee_allocation(allocations, employee_id: str) -> sqlite3.Row | None`, `mobile_actions.find_department_allocation(allocations, department: str) -> sqlite3.Row | None`, `mobile_actions.find_site_allocation(allocations, site: str) -> sqlite3.Row | None`

- [ ] **Step 1: Add the dev-only test dependency**

Create `D:\warehouse\requirements-dev.txt`:
```
pytest==8.3.3
```

Run: `python -m pip install -r requirements-dev.txt`

- [ ] **Step 2: Write a reusable in-memory DB fixture and the first failing test**

Create `D:\warehouse\tests\__init__.py` (empty file — makes `tests` a package so `pytest` can import fixtures across files).

Create `D:\warehouse\tests\test_mobile_actions.py`:
```python
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
```

- [ ] **Step 3: Run the tests, confirm they fail because `mobile_actions.py` doesn't exist yet**

Run: `python -m pytest tests/test_mobile_actions.py -v`
Expected: `ModuleNotFoundError: No module named 'mobile_actions'` (or import error) — fails, as expected before implementation.

- [ ] **Step 4: Implement the pure query helpers**

Create `D:\warehouse\mobile_actions.py`:
```python
"""Business logic for POST /api/mobile/action.

Ported from the equivalent handlers in app.js (handleIssueSubmit,
handleReturnSubmit, handleRepairSubmit, handleRepairReturnSubmit,
handleRetireSubmit) so the mobile app and the desktop app agree on the
same accounting rules against the same database. Keep this file free of
http.server imports so it stays independently testable.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import time
from datetime import datetime, timezone


class MobileActionError(Exception):
    """Raised for any rejected action; `message` is safe to show the user."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def get_allocated_quantity(allocations: list[sqlite3.Row]) -> int:
    return sum(int(row["quantity"] or 0) for row in allocations)


def get_available_quantity(asset_row: sqlite3.Row, allocations: list[sqlite3.Row]) -> int:
    allocated = get_allocated_quantity(allocations)
    repair = int(asset_row["repair_quantity"] or 0)
    return max(0, int(asset_row["quantity"] or 0) - allocated - repair)


def find_employee_allocation(allocations: list[sqlite3.Row], employee_id: str) -> sqlite3.Row | None:
    for row in allocations:
        if row["employee_id"] == employee_id and not row["department"]:
            return row
    return None


def find_department_allocation(allocations: list[sqlite3.Row], department: str) -> sqlite3.Row | None:
    if not department:
        return None
    for row in allocations:
        if not row["employee_id"] and not row["site"] and row["department"] == department:
            return row
    return None


def find_site_allocation(allocations: list[sqlite3.Row], site: str) -> sqlite3.Row | None:
    if not site:
        return None
    for row in allocations:
        if not row["employee_id"] and not row["department"] and row["site"] == site:
            return row
    return None


def _new_movement_id() -> str:
    return f"mov_{int(time.time() * 1000)}_{secrets.token_hex(3)}"
```

- [ ] **Step 5: Run the tests again, confirm they pass**

Run: `python -m pytest tests/test_mobile_actions.py -v`
Expected: 3 passed

- [ ] **Step 6: Commit**

No git repo in this project — skip `git commit`. Just leave the working tree as-is; the next task builds on it directly.

---

### Task 2: `issue` action

**Files:**
- Modify: `D:\warehouse\tests\test_mobile_actions.py`
- Modify: `D:\warehouse\mobile_actions.py`

**Interfaces:**
- Consumes: `get_available_quantity`, `find_employee_allocation`, `find_department_allocation`, `find_site_allocation`, `MobileActionError`, `_new_movement_id` (Task 1)
- Produces: `mobile_actions.apply_issue(connection: sqlite3.Connection, action: dict) -> None` — `action` keys: `assetId`, `employeeId` (str | None), `department` (str), `site` (str), `quantity` (int), `date` (str, `YYYY-MM-DD`), `notes` (str). Raises `MobileActionError` on invalid input. Caller is responsible for the transaction (`BEGIN`/commit) and for bumping `state_version` — this function only does the `assets`/`asset_allocations`/`movements` writes for one action.

- [ ] **Step 1: Write the failing tests**

Append to `D:\warehouse\tests\test_mobile_actions.py`:
```python
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
    with pytest.raises(mobile_actions.MobileActionError, match="Доступно"):
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
```

- [ ] **Step 2: Run to confirm failure**

Run: `python -m pytest tests/test_mobile_actions.py -v -k apply_issue`
Expected: FAIL — `AttributeError: module 'mobile_actions' has no attribute 'apply_issue'`

- [ ] **Step 3: Implement `apply_issue`**

Append to `D:\warehouse\mobile_actions.py`:
```python
def _load_asset(connection: sqlite3.Connection, asset_id: str) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
    if row is None:
        raise MobileActionError(f"Актив {asset_id} не найден.")
    return row


def _load_allocations(connection: sqlite3.Connection, asset_id: str) -> list[sqlite3.Row]:
    return list(connection.execute(
        "SELECT * FROM asset_allocations WHERE asset_id = ?", (asset_id,)
    ))


def apply_issue(connection: sqlite3.Connection, action: dict) -> None:
    asset = _load_asset(connection, action["assetId"])
    employee_id = action.get("employeeId") or None
    department = action.get("department") or ""
    site = action.get("site") or ""
    quantity = max(1, int(action.get("quantity") or 1))

    allocations = _load_allocations(connection, asset["id"])
    available = get_available_quantity(asset, allocations)
    if quantity > available:
        raise MobileActionError(
            f'Нельзя выдать {quantity} шт. По позиции "{asset["name"]}" доступно: {available}.'
        )

    if employee_id:
        existing = find_employee_allocation(allocations, employee_id)
    elif site:
        existing = find_site_allocation(allocations, site)
    else:
        existing = find_department_allocation(allocations, department)

    if existing is not None:
        connection.execute(
            "UPDATE asset_allocations SET quantity = quantity + ? "
            "WHERE asset_id = ? AND employee_id IS ? AND department = ? AND site = ?",
            (quantity, asset["id"], existing["employee_id"], existing["department"], existing["site"]),
        )
    else:
        connection.execute(
            "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
            "VALUES (?, ?, ?, ?, ?)",
            (asset["id"], employee_id, department, site, quantity),
        )

    connection.execute(
        "INSERT INTO movements (id, type, asset_id, employee_id, department, site, act_number, "
        "quantity, date, notes) VALUES (?, 'issue', ?, ?, ?, ?, NULL, ?, ?, ?)",
        (_new_movement_id(), asset["id"], employee_id, department, site, quantity,
         action.get("date") or datetime.now(timezone.utc).date().isoformat(), action.get("notes") or ""),
    )
```

- [ ] **Step 4: Run to confirm the new tests pass (and old ones still do)**

Run: `python -m pytest tests/test_mobile_actions.py -v`
Expected: 7 passed

- [ ] **Step 5: Commit**

No git repo — skip.

---

### Task 3: `return` action

**Files:**
- Modify: `D:\warehouse\tests\test_mobile_actions.py`
- Modify: `D:\warehouse\mobile_actions.py`

**Interfaces:**
- Consumes: same helpers as Task 2
- Produces: `mobile_actions.apply_return(connection, action: dict) -> None` — same `action` shape as `apply_issue`.

- [ ] **Step 1: Write the failing tests**

Append to `D:\warehouse\tests\test_mobile_actions.py`:
```python
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
```

- [ ] **Step 2: Run to confirm failure**

Run: `python -m pytest tests/test_mobile_actions.py -v -k apply_return`
Expected: FAIL — `AttributeError: module 'mobile_actions' has no attribute 'apply_return'`

- [ ] **Step 3: Implement `apply_return`**

Append to `D:\warehouse\mobile_actions.py`:
```python
def apply_return(connection: sqlite3.Connection, action: dict) -> None:
    asset = _load_asset(connection, action["assetId"])
    employee_id = action.get("employeeId") or None
    department = action.get("department") or ""
    site = action.get("site") or ""
    quantity = max(1, int(action.get("quantity") or 1))

    allocations = _load_allocations(connection, asset["id"])
    if employee_id:
        existing = find_employee_allocation(allocations, employee_id)
        owner_label = "сотрудника"
    elif site:
        existing = find_site_allocation(allocations, site)
        owner_label = f'объекта «{site}»'
    else:
        existing = find_department_allocation(allocations, department)
        owner_label = f'отдела «{department}»'

    if existing is None:
        raise MobileActionError(f'У {owner_label} нет позиции "{asset["name"]}".')
    if quantity > existing["quantity"]:
        raise MobileActionError(
            f'Нельзя вернуть {quantity} шт. По позиции "{asset["name"]}" числится: {existing["quantity"]}.'
        )

    remaining = existing["quantity"] - quantity
    if remaining > 0:
        connection.execute(
            "UPDATE asset_allocations SET quantity = ? "
            "WHERE asset_id = ? AND employee_id IS ? AND department = ? AND site = ?",
            (remaining, asset["id"], existing["employee_id"], existing["department"], existing["site"]),
        )
    else:
        connection.execute(
            "DELETE FROM asset_allocations "
            "WHERE asset_id = ? AND employee_id IS ? AND department = ? AND site = ?",
            (asset["id"], existing["employee_id"], existing["department"], existing["site"]),
        )

    connection.execute(
        "INSERT INTO movements (id, type, asset_id, employee_id, department, site, act_number, "
        "quantity, date, notes) VALUES (?, 'return', ?, ?, ?, ?, NULL, ?, ?, ?)",
        (_new_movement_id(), asset["id"], employee_id, department, site, quantity,
         action.get("date") or datetime.now(timezone.utc).date().isoformat(), action.get("notes") or ""),
    )
```

- [ ] **Step 4: Run to confirm the new tests pass (and all previous ones still do)**

Run: `python -m pytest tests/test_mobile_actions.py -v`
Expected: 11 passed

- [ ] **Step 5: Commit**

No git repo — skip.

---

### Task 4: `repair` action

**Files:**
- Modify: `D:\warehouse\tests\test_mobile_actions.py`
- Modify: `D:\warehouse\mobile_actions.py`

**Interfaces:**
- Consumes: `mobile_actions._load_asset(connection, asset_id: str) -> sqlite3.Row`, `mobile_actions._load_allocations(connection, asset_id: str) -> list[sqlite3.Row]`, `get_available_quantity`, `find_employee_allocation`, `MobileActionError`, `_new_movement_id` (Task 2)
- Produces: `mobile_actions.apply_repair(connection, action: dict) -> None` — `action` keys: `assetId`, `sourceType` (`"warehouse"` | `"employee"`), `employeeId` (required when `sourceType == "employee"`), `quantity`, `date`, `notes`.

- [ ] **Step 1: Write the failing tests**

Append to `D:\warehouse\tests\test_mobile_actions.py`:
```python
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
```

- [ ] **Step 2: Run to confirm failure**

Run: `python -m pytest tests/test_mobile_actions.py -v -k apply_repair`
Expected: FAIL — `AttributeError: module 'mobile_actions' has no attribute 'apply_repair'`

- [ ] **Step 3: Implement `apply_repair`**

Append to `D:\warehouse\mobile_actions.py`:
```python
def apply_repair(connection: sqlite3.Connection, action: dict) -> None:
    asset = _load_asset(connection, action["assetId"])
    source_type = action.get("sourceType") or "warehouse"
    employee_id = action.get("employeeId") or None
    quantity = max(1, int(action.get("quantity") or 1))
    allocations = _load_allocations(connection, asset["id"])

    if source_type == "warehouse":
        available = get_available_quantity(asset, allocations)
        if quantity > available:
            raise MobileActionError(
                f'Нельзя отправить в ремонт {quantity} шт. Доступно на складе: {available}.'
            )
    else:
        existing = find_employee_allocation(allocations, employee_id)
        if existing is None:
            raise MobileActionError("У выбранного сотрудника нет этой техники.")
        if quantity > existing["quantity"]:
            raise MobileActionError(
                f'Нельзя отправить в ремонт {quantity} шт. У сотрудника числится: {existing["quantity"]}.'
            )
        remaining = existing["quantity"] - quantity
        if remaining > 0:
            connection.execute(
                "UPDATE asset_allocations SET quantity = ? "
                "WHERE asset_id = ? AND employee_id = ? AND department = '' AND site = ''",
                (remaining, asset["id"], employee_id),
            )
        else:
            connection.execute(
                "DELETE FROM asset_allocations "
                "WHERE asset_id = ? AND employee_id = ? AND department = '' AND site = ''",
                (asset["id"], employee_id),
            )

    repair_date = asset["repair_date"] or (action.get("date") or datetime.now(timezone.utc).date().isoformat())
    connection.execute(
        "UPDATE assets SET repair_quantity = repair_quantity + ?, repair_date = ? WHERE id = ?",
        (quantity, repair_date, asset["id"]),
    )
    connection.execute(
        "INSERT INTO movements (id, type, asset_id, employee_id, department, site, act_number, "
        "quantity, date, notes) VALUES (?, 'repair', ?, ?, '', '', NULL, ?, ?, ?)",
        (_new_movement_id(), asset["id"], employee_id if source_type == "employee" else None, quantity,
         action.get("date") or datetime.now(timezone.utc).date().isoformat(), action.get("notes") or ""),
    )
```

- [ ] **Step 4: Run to confirm the new tests pass (and all previous ones still do)**

Run: `python -m pytest tests/test_mobile_actions.py -v`
Expected: 15 passed

- [ ] **Step 5: Commit**

No git repo — skip.

---

### Task 5: `repair_return` action

**Files:**
- Modify: `D:\warehouse\tests\test_mobile_actions.py`
- Modify: `D:\warehouse\mobile_actions.py`

**Interfaces:**
- Consumes: `mobile_actions._load_asset`, `mobile_actions._load_allocations`, `find_employee_allocation`, `MobileActionError`, `_new_movement_id` (Task 2)
- Produces: `mobile_actions.apply_repair_return(connection, action: dict) -> None` — `action` keys: `assetId`, `targetType` (`"warehouse"` | `"employee"`), `employeeId` (required when `targetType == "employee"`), `quantity`, `date`, `notes`.

- [ ] **Step 1: Write the failing tests**

Append to `D:\warehouse\tests\test_mobile_actions.py`:
```python
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
```

- [ ] **Step 2: Run to confirm failure**

Run: `python -m pytest tests/test_mobile_actions.py -v -k apply_repair_return`
Expected: FAIL — `AttributeError: module 'mobile_actions' has no attribute 'apply_repair_return'`

- [ ] **Step 3: Implement `apply_repair_return`**

Append to `D:\warehouse\mobile_actions.py`:
```python
def apply_repair_return(connection: sqlite3.Connection, action: dict) -> None:
    asset = _load_asset(connection, action["assetId"])
    target_type = action.get("targetType") or "warehouse"
    employee_id = action.get("employeeId") or None
    quantity = max(1, int(action.get("quantity") or 1))

    in_repair = int(asset["repair_quantity"] or 0)
    if quantity > in_repair:
        raise MobileActionError(
            f'Нельзя вернуть из ремонта {quantity} шт. В ремонте числится: {in_repair}.'
        )
    if target_type == "employee" and not employee_id:
        raise MobileActionError("Выберите сотрудника, куда вернуть технику.")

    remaining_in_repair = in_repair - quantity
    new_repair_date = asset["repair_date"] if remaining_in_repair > 0 else ""
    connection.execute(
        "UPDATE assets SET repair_quantity = ?, repair_date = ? WHERE id = ?",
        (remaining_in_repair, new_repair_date, asset["id"]),
    )

    if target_type == "employee":
        allocations = _load_allocations(connection, asset["id"])
        existing = find_employee_allocation(allocations, employee_id)
        if existing is not None:
            connection.execute(
                "UPDATE asset_allocations SET quantity = quantity + ? "
                "WHERE asset_id = ? AND employee_id = ? AND department = '' AND site = ''",
                (quantity, asset["id"], employee_id),
            )
        else:
            connection.execute(
                "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
                "VALUES (?, ?, '', '', ?)",
                (asset["id"], employee_id, quantity),
            )

    connection.execute(
        "INSERT INTO movements (id, type, asset_id, employee_id, department, site, act_number, "
        "quantity, date, notes) VALUES (?, 'repair_return', ?, ?, '', '', NULL, ?, ?, ?)",
        (_new_movement_id(), asset["id"], employee_id if target_type == "employee" else None, quantity,
         action.get("date") or datetime.now(timezone.utc).date().isoformat(), action.get("notes") or ""),
    )
```

- [ ] **Step 4: Run to confirm the new tests pass (and all previous ones still do)**

Run: `python -m pytest tests/test_mobile_actions.py -v`
Expected: 20 passed

- [ ] **Step 5: Commit**

No git repo — skip.

---

### Task 6: `retire` action

**Files:**
- Modify: `D:\warehouse\tests\test_mobile_actions.py`
- Modify: `D:\warehouse\mobile_actions.py`

**Interfaces:**
- Consumes: `mobile_actions._load_asset`, `mobile_actions._load_allocations`, `get_available_quantity`, `MobileActionError`, `_new_movement_id` (Task 2)
- Produces: `mobile_actions.apply_retire(connection, action: dict) -> None` — `action` keys: `assetId`, `quantity`, `date`, `notes`.

- [ ] **Step 1: Write the failing tests**

Append to `D:\warehouse\tests\test_mobile_actions.py`:
```python
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
```

- [ ] **Step 2: Run to confirm failure**

Run: `python -m pytest tests/test_mobile_actions.py -v -k apply_retire`
Expected: FAIL — `AttributeError: module 'mobile_actions' has no attribute 'apply_retire'`

- [ ] **Step 3: Implement `apply_retire`**

Append to `D:\warehouse\mobile_actions.py`:
```python
def apply_retire(connection: sqlite3.Connection, action: dict) -> None:
    asset = _load_asset(connection, action["assetId"])
    quantity = max(1, int(action.get("quantity") or 1))
    allocations = _load_allocations(connection, asset["id"])
    available = get_available_quantity(asset, allocations)
    if quantity > available:
        raise MobileActionError(
            f'Нельзя списать {quantity} шт. Доступно на складе: {available}.'
        )

    connection.execute(
        "UPDATE assets SET quantity = quantity - ?, retired_quantity = retired_quantity + ? WHERE id = ?",
        (quantity, quantity, asset["id"]),
    )
    connection.execute(
        "INSERT INTO movements (id, type, asset_id, employee_id, department, site, act_number, "
        "quantity, date, notes) VALUES (?, 'retire', ?, NULL, '', '', NULL, ?, ?, ?)",
        (_new_movement_id(), asset["id"], quantity,
         action.get("date") or datetime.now(timezone.utc).date().isoformat(), action.get("notes") or ""),
    )
```

- [ ] **Step 4: Run to confirm the new tests pass (and all previous ones still do)**

Run: `python -m pytest tests/test_mobile_actions.py -v`
Expected: 22 passed

- [ ] **Step 5: Commit**

No git repo — skip.

---

### Task 7: Dispatcher + idempotency

**Files:**
- Modify: `D:\warehouse\tests\test_mobile_actions.py`
- Modify: `D:\warehouse\mobile_actions.py`

**Interfaces:**
- Consumes: `apply_issue`, `apply_return`, `apply_repair`, `apply_repair_return`, `apply_retire` (Tasks 2-6)
- Produces: `mobile_actions.apply_action(connection: sqlite3.Connection, action: dict) -> dict` — validates `type`/`clientActionId`/`assetId` are present, checks the idempotency log, dispatches to the right `apply_*`, records the result, returns `{"assetId": ..., "replayed": bool}`. Raises `MobileActionError` for unknown `type` or a missing required field.

- [ ] **Step 1: Write the failing tests**

Append to `D:\warehouse\tests\test_mobile_actions.py`:
```python
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
```

- [ ] **Step 2: Run to confirm failure**

Run: `python -m pytest tests/test_mobile_actions.py -v -k apply_action`
Expected: FAIL — `AttributeError: module 'mobile_actions' has no attribute 'apply_action'`

- [ ] **Step 3: Implement `apply_action`**

Append to `D:\warehouse\mobile_actions.py`:
```python
_DISPATCH = {
    "issue": apply_issue,
    "return": apply_return,
    "repair": apply_repair,
    "repair_return": apply_repair_return,
    "retire": apply_retire,
}


def apply_action(connection: sqlite3.Connection, action: dict) -> dict:
    client_action_id = action.get("clientActionId")
    if not client_action_id:
        raise MobileActionError("clientActionId обязателен.")
    action_type = action.get("type")
    if action_type not in _DISPATCH:
        raise MobileActionError(f'Неизвестный тип действия: "{action_type}".')
    if not action.get("assetId"):
        raise MobileActionError("assetId обязателен.")

    cached = connection.execute(
        "SELECT response_json FROM mobile_action_log WHERE client_action_id = ?",
        (client_action_id,),
    ).fetchone()
    if cached is not None:
        result = json.loads(cached["response_json"])
        result["replayed"] = True
        return result

    _DISPATCH[action_type](connection, action)

    result = {"assetId": action["assetId"], "replayed": False}
    connection.execute(
        "INSERT INTO mobile_action_log (client_action_id, response_json, created_at) VALUES (?, ?, ?)",
        (client_action_id, json.dumps(result), datetime.now(timezone.utc).isoformat()),
    )
    return result
```

- [ ] **Step 4: Run to confirm the new tests pass (and all previous ones still do)**

Run: `python -m pytest tests/test_mobile_actions.py -v`
Expected: 26 passed

- [ ] **Step 5: Commit**

No git repo — skip.

---

### Task 8: Wire into `server.py`

**Files:**
- Modify: `D:\warehouse\schema.sql`
- Modify: `D:\warehouse\server.py`

**Interfaces:**
- Consumes: `mobile_actions.apply_action`, `mobile_actions.MobileActionError` (Task 7); `get_connection`, `STATE_LOCK`, `auto_backup`, `read_state_version`, `WarehouseHandler.check_auth`, `WarehouseHandler.send_json`, `WarehouseHandler.send_json_error` (existing `server.py`)
- Produces: `POST /api/mobile/action` — 200 `{"assetId": ..., "replayed": bool, "version": int}` on success, 400 `{"error": "..."}` on `MobileActionError`, 401 (via existing `check_auth`) when the LAN password is wrong/missing.

- [ ] **Step 1: Add `mobile_action_log` to `schema.sql`**

Open `D:\warehouse\schema.sql`, append at the end of the file (after the `kit_templates` table):
```sql

CREATE TABLE IF NOT EXISTS mobile_action_log (
  client_action_id TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

- [ ] **Step 2: Add the same table to `init_db()`'s migration path (for databases created before this change)**

In `D:\warehouse\server.py`, find the `init_db()` function (around line 131-213, right after the `kit_templates` table creation, before the function ends). Add:
```python
        # Mobile action idempotency log
        connection.execute("""
            CREATE TABLE IF NOT EXISTS mobile_action_log (
                client_action_id TEXT PRIMARY KEY,
                response_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
```

- [ ] **Step 3: Import `mobile_actions` and add the route**

In `D:\warehouse\server.py`, near the top with the other local imports (after the `act_generator` try/except block), add:
```python
import mobile_actions
```

Find `WarehouseHandler.do_POST` (currently dispatches on `parsed.path == "/api/act"` and `parsed.path == "/api/state"`). Add a branch for the new path, before the existing `/api/state` handling:
```python
    def do_POST(self) -> None:
        if not self.check_auth():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/act":
            self.handle_act_request()
            return
        if parsed.path == "/api/mobile/action":
            self.handle_mobile_action()
            return
        if parsed.path != "/api/state":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
```
(Only the new `if parsed.path == "/api/mobile/action":` block is new — the surrounding lines already exist; this shows where it goes.)

- [ ] **Step 4: Implement `handle_mobile_action`**

In `D:\warehouse\server.py`, add this method to `WarehouseHandler`, right after `do_POST` (before `handle_act_request`):
```python
    def handle_mobile_action(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as exc:
            self.send_json_error(HTTPStatus.BAD_REQUEST, f"invalid json: {exc}")
            return
        with STATE_LOCK:
            try:
                with get_connection() as connection:
                    connection.execute("BEGIN")
                    result = mobile_actions.apply_action(connection, payload)
                    if not result["replayed"]:
                        auto_backup()
                        new_version = read_state_version(connection) + 1
                        connection.execute(
                            "INSERT INTO app_meta (key, value) VALUES ('state_version', ?) "
                            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                            (str(new_version),),
                        )
                    else:
                        new_version = read_state_version(connection)
            except mobile_actions.MobileActionError as exc:
                self.send_json_error(HTTPStatus.BAD_REQUEST, exc.message)
                return
        result["version"] = new_version
        self.send_json(result)
```

- [ ] **Step 5: Verify the whole test suite still passes**

Run: `python -m pytest tests/ -v`
Expected: 26 passed (server.py changes aren't unit-tested here — Task 9 verifies them end-to-end over HTTP)

- [ ] **Step 6: Verify `server.py` and `schema.sql` are syntactically valid**

Run: `python -m py_compile server.py mobile_actions.py`
Expected: no output, exit code 0

- [ ] **Step 7: Commit**

No git repo — skip.

---

### Task 9: End-to-end verification over HTTP

**Files:** none (manual verification task — confirms Task 8's wiring actually works when the server is running, not just that it imports)

- [ ] **Step 1: Start the server against a throwaway copy of the database, on an isolated port**

Port 8765 (the default) may already be occupied by a real running instance of `WarehouseApp.exe` from ordinary use — binding the throwaway server there would silently make your curl commands hit the REAL app and its REAL database instead of the throwaway one. Pin the throwaway server to a different port via `config.json`:

```bash
E2E_DIR=$(mktemp -d)
cp server.py mobile_actions.py act_generator.py schema.sql "$E2E_DIR/"
cd "$E2E_DIR"
python -c "import json; json.dump({'host':'127.0.0.1','port':8766}, open('config.json','w'))"
python server.py &
for i in 1 2 3 4 5 6 7 8; do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8766/)
  if [ "$code" != "000" ]; then break; fi
  sleep 1
done
```
(All commands below use port 8766 for this reason — adjust if 8766 is also taken; check with `netstat -ano | grep :8766` first.)

- [ ] **Step 2: Seed one employee and one asset via the existing full-state endpoint**

```bash
curl -s -X POST http://127.0.0.1:8766/api/state -H "Content-Type: application/json" -d '{
  "meta": {"updatedAt": "2026-08-22T00:00:00.000Z"},
  "employees": [{"id":"emp_1","fullName":"Иванов Иван","department":"IT","site":"","position":"","email":"","phone":""}],
  "departments": [{"id":"dep_1","name":"IT"}],
  "sites": [],
  "assets": [{"id":"ast_1","name":"Ноутбук Dell","category":"Ноутбуки","inventoryNumber":"INV-001","serialNumber":"SN-001","purchaseDate":"2026-01-01","status":"in_stock","notes":"","quantity":5,"repairQuantity":0,"retiredQuantity":0,"minQuantity":0,"warrantyEnd":"","price":0,"repairDate":"","location":"","photoUrl":"","allocations":[]}],
  "movements": [],
  "auditLog": [],
  "kitTemplates": []
}' | head -c 200
echo
```
Expected: JSON response echoing the saved state (no `"error"` key).

- [ ] **Step 3: Send an `issue` action and confirm it applies**

```bash
curl -s -X POST http://127.0.0.1:8766/api/mobile/action -H "Content-Type: application/json" -d '{
  "clientActionId": "e2e-test-1",
  "type": "issue", "assetId": "ast_1", "employeeId": "emp_1",
  "department": "", "site": "", "quantity": 2, "date": "2026-08-22", "notes": "e2e test"
}'
echo
```
Expected: `{"assetId": "ast_1", "replayed": false, "version": 2}`

- [ ] **Step 4: Confirm the state actually changed**

```bash
curl -s http://127.0.0.1:8766/api/state | python -c "
import json, sys
state = json.load(sys.stdin)
asset = next(a for a in state['assets'] if a['id'] == 'ast_1')
print('allocations:', asset['allocations'])
assert asset['allocations'] == [{'employeeId': 'emp_1', 'department': '', 'site': '', 'quantity': 2}], asset['allocations']
print('OK: allocation matches')
"
```
Expected: `OK: allocation matches`

- [ ] **Step 5: Replay the same `clientActionId` and confirm it does NOT double-apply**

```bash
curl -s -X POST http://127.0.0.1:8766/api/mobile/action -H "Content-Type: application/json" -d '{
  "clientActionId": "e2e-test-1",
  "type": "issue", "assetId": "ast_1", "employeeId": "emp_1",
  "department": "", "site": "", "quantity": 2, "date": "2026-08-22", "notes": "e2e test"
}'
echo
curl -s http://127.0.0.1:8766/api/state | python -c "
import json, sys
state = json.load(sys.stdin)
asset = next(a for a in state['assets'] if a['id'] == 'ast_1')
assert asset['allocations'][0]['quantity'] == 2, asset['allocations']
print('OK: replay did not double-apply')
"
```
Expected: first curl returns `{"assetId": "ast_1", "replayed": true, "version": 2}` (same version — no new bump on replay), second prints `OK: replay did not double-apply`.

- [ ] **Step 6: Confirm a rejected action returns 400 with a readable message**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8766/api/mobile/action -H "Content-Type: application/json" -d '{
  "clientActionId": "e2e-test-2",
  "type": "issue", "assetId": "ast_1", "employeeId": "emp_1",
  "department": "", "site": "", "quantity": 999, "date": "2026-08-22", "notes": ""
}'
```
Expected: `400`

- [ ] **Step 7: Stop the server and clean up**

```bash
kill %1 2>/dev/null
cd "$OLDPWD"
rm -rf "$E2E_DIR"
```

- [ ] **Step 8: Commit**

No git repo — skip. This plan is done; `docs/superpowers/plans/2026-08-22-mobile-scanner-app.md` depends on the endpoint built here.
