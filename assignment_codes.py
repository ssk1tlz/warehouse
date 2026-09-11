"""Генерация номера операции выдачи.

Код имеет вид ``ASSIGN-NNNN`` — сквозной номер по всем выдачам, как
``WP-NNNN`` у рабочих мест. Номер принадлежит операции, а не технике:
инвентарный номер (``asset_codes.py``) остаётся за единицей техники
навсегда и при выдаче не меняется, поэтому подменять одно другим
нельзя — это разные идентификаторы разных сущностей.

Файл, как workplace_codes.py и asset_codes.py, ничего не импортирует из
server и migrations: он вызывается из обоих — migrations.py при
бэкофилле существующих актов и server.py при создании новых выдач в
import_state.
"""
from __future__ import annotations

import re
import sqlite3

_CODE_RE = re.compile(r"^ASSIGN-(\d+)$")


def next_number(connection: sqlite3.Connection) -> int:
    """Следующий свободный порядковый номер — максимум по таблице плюс один."""
    highest = 0
    for row in connection.execute("SELECT code FROM assignments WHERE code != ''"):
        match = _CODE_RE.match(str(row["code"]).strip())
        if match:
            highest = max(highest, int(match.group(1)))
    return highest + 1


def assign_code(number: int) -> str:
    """Готовый код вида ``ASSIGN-0001`` по порядковому номеру.

    Четыре знака — минимальная ширина, а не потолок: номер 10000
    печатается целиком, и next_number прочитает его обратно.
    """
    return f"ASSIGN-{number:04d}"
