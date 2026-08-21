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
