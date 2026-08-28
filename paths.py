"""Единственное место, где вычисляются пути приложения.

Данные (база, бэкапы, конфиг, логи) живут в %ProgramData%\\Warehouse —
отдельно от программы, которая ставится в Program Files и при обновлении
перезаписывается целиком. Ресурсы (schema.sql, index.html, app.js...)
поставляются вместе с программой и доступны только на чтение.
"""
from __future__ import annotations

import os
import shutil
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


def legacy_root() -> Path:
    """Папка, где данные лежали до Этапа 3 — рядом с исполняемым файлом."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _retire_legacy_file(path: Path) -> None:
    """Переименовать перенесённый файл, не удаляя его.

    Осиротевшие warehouse.db-wal/-shm тоже переименовываем: оставленный
    рядом -wal был бы «проигран» поверх базы, если пользователь когда-нибудь
    вернёт старый .db на место — ровно та ошибка, которую финальное ревью
    Этапа 2 нашло в восстановлении из бэкапа.

    Переименование — best-effort. На Windows файл, который всё ещё держит
    открытым любое SQLite-соединение (например, не выгруженная старая копия
    программы), нельзя переименовать: os.replace бросает PermissionError
    (WinError 32). Данные уже скопированы в DATA_DIR — это то, что
    действительно важно; если переименование не удалось, файл просто остаётся
    на старом месте и не мешает следующему запуску (миграция не повторится,
    так как DB_PATH в DATA_DIR уже существует).
    """
    if not path.exists():
        return
    try:
        path.replace(path.with_name(path.name + ".migrated"))
    except OSError as exc:
        print(
            f"ПРЕДУПРЕЖДЕНИЕ: не удалось переименовать {path} после переноса "
            f"данных ({exc}) — файл ещё занят другим процессом, оставляю как есть."
        )


def migrate_legacy_data(copy_database) -> bool:
    """Перенести данные из папки рядом с программой в DATA_DIR.

    Возвращает True, если миграция реально выполнялась.

    Guard `if DB_PATH.exists()` наверху обязан быть правдой ровно тогда,
    когда миграция целиком завершена — иначе он способен соврать. Поэтому
    DB_PATH — это ПОСЛЕДНЕЕ, что появляется на диске: база сначала пишется
    во временный файл рядом (warehouse.db.migrating, та же файловая
    система, что и DATA_DIR), затем копируются config.json и backups/, и
    только после этого temp атомарно переименовывается в DB_PATH через
    os.replace(). sqlite3.connect() создаёт файл назначения сразу, до
    первой записи — если бы копия шла прямо в DB_PATH, то падение между
    копированием базы и копированием config.json (антивирус, забитый
    диск, kill -9 на середине обновления) оставляло бы DB_PATH
    существующим, но config.json/backups — нет. При следующем запуске
    guard увидел бы "миграция уже была" и молча пропустил бы их навсегда
    (пользователь тихо теряет host/port из config.json). Если что-то из
    трёх шагов упадёт, temp-файл удаляется и исключение пробрасывается
    дальше — повтор при следующем запуске начнётся с чистого листа.

    `copy_database` — (source, dest) -> None; вызывающий передаёт
    server._copy_database (копия через SQLite online backup API, которая
    видит данные в -wal). Обычного копирования файла здесь недостаточно.
    Параметр, а не импорт server — иначе циклический импорт (server сам
    импортирует paths).
    """
    if DB_PATH.exists():
        return False
    old_db = legacy_root() / "warehouse.db"
    if not old_db.exists():
        return False

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp_db = DATA_DIR / "warehouse.db.migrating"
    try:
        copy_database(old_db, temp_db)

        old_config = legacy_root() / "config.json"
        if old_config.exists() and not CONFIG_PATH.exists():
            shutil.copy2(old_config, CONFIG_PATH)

        old_backups = legacy_root() / "backups"
        if old_backups.is_dir():
            BACKUP_DIR.mkdir(parents=True, exist_ok=True)
            for item in sorted(old_backups.glob("*.db")):
                target = BACKUP_DIR / item.name
                if not target.exists():
                    shutil.copy2(item, target)
    except Exception:
        temp_db.unlink(missing_ok=True)
        raise

    os.replace(temp_db, DB_PATH)  # атомарно в пределах одной файловой системы

    _retire_legacy_file(old_db)
    _retire_legacy_file(old_db.with_name(old_db.name + "-wal"))
    _retire_legacy_file(old_db.with_name(old_db.name + "-shm"))
    return True
