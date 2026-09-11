"""Выдачи в базе данных: проекция, сверка и запись операций.

Общий слой для server.py и mobile_actions.py. Правило одно на всех:
единственный источник правды о том, у кого что находится, — выдачи
(assignments + assignment_items), а asset_allocations — их проекция.

Мобильный клиент пишет в базу напрямую, минуя POST /api/state. Если бы
он по-прежнему правил asset_allocations, следующее сохранение с
десктопа пересчитало бы проекцию из выдач и молча стёрло бы мобильную
операцию. Поэтому и мобильные действия идут через этот модуль.

Файл не импортирует server и mobile_actions — оба импортируют его.
"""
from __future__ import annotations

import secrets
import sqlite3
import time

import assignment_codes

RECOVERED_NOTE = "Восстановлено по текущему состоянию: исходная операция выдачи неизвестна."


class NotEnoughHeld(ValueError):
    """Снять просят больше, чем числится за получателем."""

    def __init__(self, held: int, requested: int):
        super().__init__(f"Нельзя снять {requested} шт.: числится {held} шт.")
        self.held = held
        self.requested = requested


# ─── Получатель и проекция ─────────────────────────────────────────

def normalize_recipient(employee_id, department, site, workplace_id) -> tuple:
    """Одна запись asset_allocations — ровно один получатель.

    Старый мобильный клиент мог записать строку с сотрудником И объектом.
    Выдачу с двумя хозяевами отвергает серверная валидация, поэтому
    побеждает сотрудник — так же, как его находит find_employee_allocation.
    """
    if employee_id:
        return (employee_id, "", "", "")
    if department:
        return (None, department, "", "")
    if site:
        return (None, "", site, "")
    return (None, "", "", workplace_id or "")


def assignment_recipient(assignment: dict, scope: str = "personal") -> tuple:
    """Кому адресуется позиция выдачи в терминах asset_allocations.

    Выдача знает обоих — человека и стол. Проекция обязана выбрать
    одного, потому что весь существующий код чтения (getEmployeeAllocation
    в app.js, find_employee_allocation в mobile_actions.py) ждёт запись
    ровно с одним заполненным полем. Выбирает scope позиции: личная
    техника числится за человеком и уезжает с ним, столовая — за местом
    и остаётся там при смене сотрудника.

    Та же логика — в AssetOps.assignmentRecipient (asset_ops.js);
    совпадение проверяет tests/test_assignments_js_parity.py.
    """
    employee_id = assignment.get("employeeId") or None
    workplace_id = assignment.get("workplaceId") or ""
    department = (assignment.get("department") or "").strip()
    site = (assignment.get("site") or "").strip()
    if scope == "workplace" and workplace_id:
        return (None, "", "", workplace_id)
    if employee_id:
        return (employee_id, "", "", "")
    if department:
        return (None, department, "", "")
    if site:
        return (None, "", site, "")
    return (None, "", "", workplace_id)


def project_allocations(assignments: list) -> dict[str, list[dict]]:
    """Активные остатки выдач в виде asset_allocations: техника -> записи.

    Активна та часть позиции, которую ещё не вернули: quantity минус
    returned_quantity. Возврат не удаляет строку (§12 ТЗ), поэтому
    закрытая позиция просто перестаёт попадать в проекцию — и техника
    исчезает у сотрудника, у стола и снова видна на складе разом.
    """
    totals: dict[str, dict[tuple, int]] = {}
    for assignment in assignments or []:
        for item in assignment.get("items") or []:
            try:
                quantity = int(item.get("quantity") or 0)
                returned = int(item.get("returnedQuantity") or 0)
            except (TypeError, ValueError):
                continue
            active = quantity - returned
            if active <= 0:
                continue
            asset_id = item.get("assetId")
            if not asset_id:
                continue
            key = assignment_recipient(assignment, item.get("scope") or "personal")
            bucket = totals.setdefault(asset_id, {})
            bucket[key] = bucket.get(key, 0) + active
    projected: dict[str, list[dict]] = {}
    for asset_id, bucket in totals.items():
        projected[asset_id] = [
            {"employeeId": key[0], "department": key[1], "site": key[2],
             "workplaceId": key[3], "quantity": quantity}
            for key, quantity in sorted(bucket.items(), key=lambda pair: str(pair[0]))
        ]
    return projected


def _projection_key(entry: dict) -> tuple:
    return (entry["employeeId"] or None, entry["department"], entry["site"], entry["workplaceId"])


def _as_recipient(recipient: tuple) -> tuple:
    """Получатель от вызывающего кода — к виду ключа проекции."""
    employee_id, department, site, workplace_id = recipient
    return (employee_id or None, department or "", site or "", workplace_id or "")


# ─── Чтение выдач по одной позиции ─────────────────────────────────

def _load_asset_items(connection: sqlite3.Connection, asset_id: str) -> list[dict]:
    """Позиции этой техники вместе с получателем их выдачи."""
    return [
        {
            "assignment_id": row["assignment_id"],
            "item_id": row["item_id"],
            "issued_at": row["issued_at"] or "",
            "code": row["code"] or "",
            "quantity": int(row["quantity"] or 0),
            "returned_quantity": int(row["returned_quantity"] or 0),
            "scope": row["scope"] or "personal",
            "assignment": {
                "employeeId": row["employee_id"],
                "workplaceId": row["workplace_id"] or "",
                "department": row["department"] or "",
                "site": row["site"] or "",
            },
        }
        for row in connection.execute(
            "SELECT a.id AS assignment_id, a.code, a.employee_id, a.workplace_id, "
            "a.department, a.site, a.issued_at, i.id AS item_id, i.quantity, "
            "i.returned_quantity, i.scope "
            "FROM assignment_items i JOIN assignments a ON a.id = i.assignment_id "
            "WHERE i.asset_id = ?",
            (asset_id,),
        )
    ]


def _projected_for_asset(connection: sqlite3.Connection, asset_id: str) -> list[dict]:
    assignments = [
        dict(entry["assignment"], items=[{
            "assetId": asset_id,
            "quantity": entry["quantity"],
            "returnedQuantity": entry["returned_quantity"],
            "scope": entry["scope"],
        }])
        for entry in _load_asset_items(connection, asset_id)
    ]
    return project_allocations(assignments).get(asset_id, [])


def held_quantity(connection: sqlite3.Connection, asset_id: str, recipient: tuple) -> int:
    """Сколько единиц числится за получателем по выдачам."""
    wanted = _as_recipient(recipient)
    return sum(
        entry["quantity"] for entry in _projected_for_asset(connection, asset_id)
        if _projection_key(entry) == wanted
    )


def rebuild_asset_allocations(connection: sqlite3.Connection, asset_id: str) -> None:
    """Переписывает asset_allocations этой техники по её выдачам."""
    connection.execute("DELETE FROM asset_allocations WHERE asset_id = ?", (asset_id,))
    for entry in _projected_for_asset(connection, asset_id):
        connection.execute(
            "INSERT INTO asset_allocations (asset_id, employee_id, department, site, "
            "workplace_id, quantity) VALUES (?, ?, ?, ?, ?, ?)",
            (asset_id, entry["employeeId"], entry["department"], entry["site"],
             entry["workplaceId"], entry["quantity"]),
        )


# ─── Запись операций ───────────────────────────────────────────────

def _new_id(prefix: str) -> str:
    # Формат <prefix>_<timestamp_ms>_<hex> — как createId в app.js.
    return f"{prefix}_{int(time.time() * 1000)}_{secrets.token_hex(3)}"


def create_assignment(
    connection: sqlite3.Connection,
    *,
    employee_id: str | None = None,
    workplace_id: str = "",
    department: str = "",
    site: str = "",
    issued_at: str = "",
    notes: str = "",
    created_by: str = "",
    act_number: int | None = None,
    items: list[dict],
) -> str:
    """Заводит операцию выдачи с серверным номером ASSIGN-NNNN."""
    assignment_id = _new_id("asg")
    code = assignment_codes.assign_code(assignment_codes.next_number(connection))
    connection.execute(
        "INSERT INTO assignments (id, code, employee_id, workplace_id, department, site, "
        "status, issued_at, returned_at, act_number, notes, created_by) "
        "VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, ?)",
        (assignment_id, code, employee_id or None, workplace_id or "", department or "",
         site or "", issued_at or "", act_number, notes or "", created_by or ""),
    )
    for item in items:
        connection.execute(
            "INSERT INTO assignment_items (id, assignment_id, asset_id, quantity, "
            "returned_quantity, scope, returned_at) VALUES (?, ?, ?, ?, 0, ?, NULL)",
            (_new_id("asgi"), assignment_id, item["asset_id"],
             max(1, int(item.get("quantity") or 1)),
             "workplace" if item.get("scope") == "workplace" else "personal"),
        )
    return assignment_id


def _sync_status(connection: sqlite3.Connection, assignment_id: str, date: str) -> None:
    """Статус выдачи — следствие её позиций: закрыта, когда вернули всё."""
    items = list(connection.execute(
        "SELECT quantity, returned_quantity, returned_at FROM assignment_items WHERE assignment_id = ?",
        (assignment_id,),
    ))
    closed = bool(items) and all(int(i["returned_quantity"]) >= int(i["quantity"]) for i in items)
    if closed:
        dates = [i["returned_at"] for i in items if i["returned_at"]]
        connection.execute(
            "UPDATE assignments SET status = 'returned', returned_at = ? WHERE id = ?",
            (max(dates) if dates else (date or None), assignment_id),
        )
    else:
        connection.execute(
            "UPDATE assignments SET status = 'active', returned_at = NULL WHERE id = ?",
            (assignment_id,),
        )


def close_items(
    connection: sqlite3.Connection, asset_id: str, quantity: int, date: str, *, recipient: tuple,
) -> list[str]:
    """Снимает технику с получателя, закрывая позиции его выдач.

    Количество разносится от старых выдач к свежим, чтобы «на руках»
    оставалась последняя. Строки не удаляются — наращивается
    returned_quantity (§12 ТЗ). Возвращает id затронутых выдач по порядку.
    Бросает NotEnoughHeld до первой записи, если столько не числится.
    """
    wanted = _as_recipient(recipient)
    candidates = [
        entry for entry in _load_asset_items(connection, asset_id)
        if entry["quantity"] > entry["returned_quantity"]
        and _as_recipient(assignment_recipient(entry["assignment"], entry["scope"])) == wanted
    ]
    held = sum(entry["quantity"] - entry["returned_quantity"] for entry in candidates)
    if quantity > held:
        raise NotEnoughHeld(held, quantity)

    candidates.sort(key=lambda entry: (entry["issued_at"], entry["code"], entry["item_id"]))
    remaining = quantity
    touched: list[str] = []
    for entry in candidates:
        if remaining <= 0:
            break
        taken = min(remaining, entry["quantity"] - entry["returned_quantity"])
        returned = entry["returned_quantity"] + taken
        connection.execute(
            "UPDATE assignment_items SET returned_quantity = ?, returned_at = ? WHERE id = ?",
            (returned, date if returned >= entry["quantity"] else None, entry["item_id"]),
        )
        remaining -= taken
        if entry["assignment_id"] not in touched:
            touched.append(entry["assignment_id"])
    for assignment_id in touched:
        _sync_status(connection, assignment_id, date)
    return touched


def reconcile_asset(connection: sqlite3.Connection, asset_id: str, date: str) -> None:
    """Приводит выдачи этой техники к asset_allocations: состояние главнее.

    Тот же принцип, что у бэкофилла в миграции 036, но для одной позиции
    и по ходу работы. Нужен там, где asset_allocations могли измениться
    в обход выдач: старые базы, тесты, сохранение из вкладки браузера,
    открытой до обновления программы.

    Недостача по выдачам восстанавливается выдачей без даты с пометкой
    RECOVERED_NOTE, излишек закрывается начиная со старых.
    """
    actual: dict[tuple, int] = {}
    for row in connection.execute(
        "SELECT employee_id, department, site, workplace_id, quantity "
        "FROM asset_allocations WHERE asset_id = ? AND quantity > 0",
        (asset_id,),
    ):
        key = normalize_recipient(row["employee_id"], row["department"] or "",
                                  row["site"] or "", row["workplace_id"] or "")
        actual[key] = actual.get(key, 0) + int(row["quantity"])

    projected: dict[tuple, int] = {}
    for entry in _projected_for_asset(connection, asset_id):
        key = _projection_key(entry)
        projected[key] = projected.get(key, 0) + int(entry["quantity"])

    for key in sorted(set(actual) | set(projected), key=str):
        difference = actual.get(key, 0) - projected.get(key, 0)
        if difference > 0:
            employee_id, department, site, workplace_id = key
            create_assignment(
                connection,
                employee_id=employee_id, department=department, site=site,
                workplace_id=workplace_id, notes=RECOVERED_NOTE,
                items=[{
                    "asset_id": asset_id,
                    "quantity": difference,
                    "scope": "workplace" if workplace_id and not employee_id else "personal",
                }],
            )
        elif difference < 0:
            close_items(connection, asset_id, -difference, date, recipient=key)
