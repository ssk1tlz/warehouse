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


class EditConflictError(MobileActionError):
    """Raised when a mobile edit's baseRev no longer matches the server's.

    `current_asset` carries the fields the caller needs to either show the
    user what changed or blindly retry with a fresh baseRev ("retry on top").
    """

    def __init__(self, message: str, current_asset: dict):
        super().__init__(message)
        self.current_asset = current_asset


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


def _adjust_allocation(
    connection: sqlite3.Connection, asset_id: str, existing: sqlite3.Row, delta: int
) -> None:
    """Apply `delta` to an allocation row previously matched by
    find_employee_allocation/find_department_allocation/find_site_allocation.

    Always filters the UPDATE/DELETE by the matched row's OWN identity
    (employee_id/department/site) instead of re-deriving that identity from
    raw input — so this can never target the wrong row, even when an
    allocation has more than one identity field set at once (e.g. both
    employeeId and site). Deletes the row once the resulting quantity is
    <= 0; otherwise updates it in place. `delta` may be positive (credit)
    or negative (debit).
    """
    remaining = existing["quantity"] + delta
    if remaining > 0:
        connection.execute(
            "UPDATE asset_allocations SET quantity = ? "
            "WHERE asset_id = ? AND employee_id IS ? AND department = ? AND site = ?",
            (remaining, asset_id, existing["employee_id"], existing["department"], existing["site"]),
        )
    else:
        connection.execute(
            "DELETE FROM asset_allocations "
            "WHERE asset_id = ? AND employee_id IS ? AND department = ? AND site = ?",
            (asset_id, existing["employee_id"], existing["department"], existing["site"]),
        )


def apply_issue(connection: sqlite3.Connection, action: dict) -> None:
    asset = _load_asset(connection, action["assetId"])
    employee_id = action.get("employeeId") or None
    department = action.get("department") or ""
    site = action.get("site") or ""
    quantity = max(1, int(action.get("quantity") or 1))

    if not employee_id and not department and not site:
        raise MobileActionError("Выберите сотрудника, отдел или объект.")

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


def apply_return(connection: sqlite3.Connection, action: dict) -> None:
    asset = _load_asset(connection, action["assetId"])
    employee_id = action.get("employeeId") or None
    department = action.get("department") or ""
    site = action.get("site") or ""
    quantity = max(1, int(action.get("quantity") or 1))

    if not employee_id and not department and not site:
        raise MobileActionError("Выберите сотрудника, отдел или объект.")

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

    _adjust_allocation(connection, asset["id"], existing, -quantity)

    connection.execute(
        "INSERT INTO movements (id, type, asset_id, employee_id, department, site, act_number, "
        "quantity, date, notes) VALUES (?, 'return', ?, ?, ?, ?, NULL, ?, ?, ?)",
        (_new_movement_id(), asset["id"], employee_id, department, site, quantity,
         action.get("date") or datetime.now(timezone.utc).date().isoformat(), action.get("notes") or ""),
    )


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
        if not employee_id:
            raise MobileActionError("Выберите сотрудника, у которого забираете технику.")
        existing = find_employee_allocation(allocations, employee_id)
        if existing is None:
            raise MobileActionError("У выбранного сотрудника нет этой техники.")
        if quantity > existing["quantity"]:
            raise MobileActionError(
                f'Нельзя отправить в ремонт {quantity} шт. У сотрудника числится: {existing["quantity"]}.'
            )
        _adjust_allocation(connection, asset["id"], existing, -quantity)

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
            _adjust_allocation(connection, asset["id"], existing, quantity)
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


def apply_edit(connection: sqlite3.Connection, action: dict) -> int:
    """Edit an asset's identifying/descriptive fields from the mobile app.

    Deliberately narrower than the desktop's full edit form: only the fields
    that don't interact with the allocation/quantity accounting (issue/return/
    repair/retire own that math) are editable here, so a mobile edit can never
    desync quantity vs. asset_allocations the way changing quantity or status
    directly could. These are exactly the fields `rev` guards.
    """
    asset = _load_asset(connection, action["assetId"])
    name = str(action.get("name") or "").strip()
    if not name:
        raise MobileActionError("Название не может быть пустым.")
    if "baseRev" not in action or action["baseRev"] is None:
        raise MobileActionError("baseRev обязателен.")
    try:
        base_rev = int(action["baseRev"])
    except (TypeError, ValueError):
        raise MobileActionError("baseRev должен быть числом.")
    current_rev = int(asset["rev"])
    if base_rev != current_rev:
        raise EditConflictError(
            "Карточка была изменена на сервере.",
            {
                "rev": current_rev,
                "name": asset["name"],
                "category": asset["category"] or "",
                "inventoryNumber": asset["inventory_number"] or "",
                "serialNumber": asset["serial_number"] or "",
                "location": asset["location"] or "",
                "purchaseDate": asset["purchase_date"] or "",
                "warrantyEnd": asset["warranty_end"] or "",
            },
        )

    new_rev = current_rev + 1
    connection.execute(
        "UPDATE assets SET name = ?, category = ?, inventory_number = ?, serial_number = ?, "
        "location = ?, purchase_date = ?, warranty_end = ?, rev = ? WHERE id = ?",
        (
            name,
            str(action.get("category") or "").strip(),
            str(action.get("inventoryNumber") or "").strip(),
            str(action.get("serialNumber") or "").strip(),
            str(action.get("location") or "").strip(),
            str(action.get("purchaseDate") or "").strip(),
            str(action.get("warrantyEnd") or "").strip(),
            new_rev,
            asset["id"],
        ),
    )
    connection.execute(
        "INSERT INTO movements (id, type, asset_id, employee_id, department, site, act_number, "
        "quantity, date, notes) VALUES (?, 'edit', ?, NULL, '', '', NULL, ?, ?, ?)",
        (_new_movement_id(), asset["id"], asset["quantity"],
         datetime.now(timezone.utc).date().isoformat(), "Обновлена карточка техники (с телефона)"),
    )
    return new_rev


_DISPATCH = {
    "issue": apply_issue,
    "return": apply_return,
    "repair": apply_repair,
    "repair_return": apply_repair_return,
    "retire": apply_retire,
    "edit": apply_edit,
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

    new_rev = _DISPATCH[action_type](connection, action)

    result = {"assetId": action["assetId"], "replayed": False}
    if new_rev is not None:
        result["rev"] = new_rev
    connection.execute(
        "INSERT INTO mobile_action_log (client_action_id, response_json, created_at) VALUES (?, ?, ?)",
        (client_action_id, json.dumps(result), datetime.now(timezone.utc).isoformat()),
    )
    return result
