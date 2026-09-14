"""Следующий свободный номер акта — сквозной по трём таблицам, где он
может жить: acts (ручные и «карточка сотрудника» акты), movements и
assignments (выдача/возврат, номер присваивается на клиенте в момент
создания операции — см. app.js getNextActNumber(), это не меняется).

Тот же приём, что assignment_codes.py для ASSIGN-NNNN: маленький модуль
без зависимости от server/migrations, вызывается из server.py.
"""
from __future__ import annotations

import sqlite3

_TABLES = ("acts", "movements", "assignments")


def next_number(connection: sqlite3.Connection) -> int:
    """Максимум act_number по всем трём таблицам, плюс один."""
    highest = 0
    for table in _TABLES:
        row = connection.execute(f"SELECT MAX(act_number) AS m FROM {table}").fetchone()
        if row["m"] is not None:
            highest = max(highest, int(row["m"]))
    return highest + 1


def reserve(
    connection: sqlite3.Connection,
    *,
    kind: str,
    employee_id: str | None,
    date: str,
    created_at: str,
    created_by: str,
) -> int:
    """Атомарно выделить и записать номер. Вызывающий код обязан
    удерживать STATE_LOCK на время вызова — этот модуль сам не
    блокирует, как и assignment_codes.next_number()."""
    number = next_number(connection)
    connection.execute(
        "INSERT INTO acts (act_number, kind, employee_id, date, created_at, created_by) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (number, kind, employee_id, date, created_at, created_by),
    )
    return number
