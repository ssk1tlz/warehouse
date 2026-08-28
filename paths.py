"""Единственное место, где вычисляются пути приложения.

Данные (база, бэкапы, конфиг, логи) живут в %ProgramData%\\Warehouse —
отдельно от программы, которая ставится в Program Files и при обновлении
перезаписывается целиком. Ресурсы (schema.sql, index.html, app.js...)
поставляются вместе с программой и доступны только на чтение.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def data_dir() -> Path:
    """Папка с изменяемыми данными пользователя.

    %ProgramData%, а не %APPDATA%: сервер обслуживает LAN независимо от
    того, какой пользователь Windows сейчас залогинен, и данные не должны
    уезжать вместе с роуминг-профилем.
    """
    base = os.environ.get("ProgramData") or r"C:\ProgramData"
    return Path(base) / "Warehouse"


def resource_dir() -> Path:
    """Папка с файлами, поставляемыми вместе с программой (только чтение).

    PyInstaller в режиме onefile распаковывает datas во временную папку и
    кладёт её путь в sys._MEIPASS — рядом с самим .exe этих файлов НЕТ.
    Без этой ветки установленная в Program Files программа не найдёт ни
    schema.sql, ни index.html: раньше это не проявлялось только потому,
    что .exe лежал в папке с исходниками.
    """
    bundled = getattr(sys, "_MEIPASS", None)
    if bundled:
        return Path(bundled)
    return Path(__file__).resolve().parent


DATA_DIR = data_dir()
DB_PATH = DATA_DIR / "warehouse.db"
BACKUP_DIR = DATA_DIR / "backups"
CONFIG_PATH = DATA_DIR / "config.json"
LOG_DIR = DATA_DIR / "logs"
UPDATE_CACHE_PATH = DATA_DIR / "update_check.json"

RESOURCE_DIR = resource_dir()
SCHEMA_PATH = RESOURCE_DIR / "schema.sql"
VERSION_PATH = RESOURCE_DIR / "VERSION"
