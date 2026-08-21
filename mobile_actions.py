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
