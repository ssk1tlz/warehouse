"""Генерация внутреннего идентификатора рабочего места.

Код имеет вид ``WP-NNNN`` — сквозной номер по всем рабочим местам, без
попытки угадать префикс по отделу (в отличие от asset_codes.py): у
рабочего места нет категории, только произвольное имя отдела на
русском, и надёжного правила "имя отдела -> латинский префикс" нет.

Файл, как и asset_codes.py, не импортирует ничего из server и
migrations, чтобы тестироваться отдельно и быть вызываемым из обоих:
migrations.py — при бэкофилле существующих строк (миграция 034),
server.py — при создании новых рабочих мест в import_state.
"""
from __future__ import annotations

import re
import sqlite3

_CODE_RE = re.compile(r"^WP-(\d+)$")


def next_number(connection: sqlite3.Connection) -> int:
    """Следующий свободный порядковый номер — максимум по таблице плюс один."""
    highest = 0
    for row in connection.execute("SELECT code FROM workplaces WHERE code != ''"):
        match = _CODE_RE.match(str(row["code"]).strip())
        if match:
            highest = max(highest, int(match.group(1)))
    return highest + 1


def assign_code(number: int) -> str:
    """Готовый код вида ``WP-0001`` по порядковому номеру."""
    return f"WP-{number:04d}"
