from __future__ import annotations

import json
import logging
import mimetypes
import shutil
import sqlite3
import sys
import threading
import uuid
from datetime import date, datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.parse import urlparse

try:
    from act_generator import generate_act, generate_inventory_act
except Exception as _act_err:  # noqa: BLE001
    generate_act = None
    generate_inventory_act = None
    _ACT_IMPORT_ERROR = str(_act_err)
else:
    _ACT_IMPORT_ERROR = ""

import mobile_actions
import migrations
import auth
import paths
import updates
from paths import (
    BACKUP_DIR,
    CONFIG_PATH,
    DB_PATH,
    LOG_DIR,
    RESOURCE_DIR,
    SCHEMA_PATH,
    UPDATE_CACHE_PATH,
    VERSION_PATH,
)

MAX_BACKUPS = 30


def _read_app_version() -> str:
    """Версия продукта из файла VERSION (общая с мобильным приложением)."""
    try:
        return VERSION_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        return "0.0.0"


APP_VERSION = _read_app_version()

# Static files are served WITHOUT authentication (the desktop client must be able
# to load its own shell before anyone can log in), so this is an explicit
# allowlist rather than "anything under RESOURCE_DIR" — otherwise warehouse.db, the
# backups/ directory and every .py source file would be downloadable by any
# unauthenticated LAN client. Every entry below is referenced by index.html;
# anything not listed returns 404 (never 403 — we don't leak which files exist).
STATIC_ALLOWLIST = frozenset({
    "index.html",
    "app.js",
    "styles.css",
    "chart.umd.min.js",
    "qrcode-lib.js",
})

# Requests larger than this are refused before the body is read, so an
# unauthenticated caller can't force a huge allocation with a Content-Length header.
MAX_BODY_BYTES = 10 * 1024 * 1024


def load_config() -> dict:
    """Optional config.json next to the app. Absent file = local-only mode."""
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            print(f"Некорректный config.json ({exc}) — использую настройки по умолчанию.")
    return {}


def save_config(updates_to_apply: dict) -> None:
    """Слить изменения в config.json, сохранив остальные ключи (host/port/...)."""
    config = load_config()
    config.update(updates_to_apply)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


def check_updates_enabled() -> bool:
    """Читаем config.json заново при каждом вызове, чтобы выключение
    проверки в настройках действовало сразу, без перезапуска сервера."""
    return bool(load_config().get("checkUpdates", True))


def current_update() -> dict | None:
    """Кэшированная новая версия, если она есть, новее текущей и проверка включена."""
    if not check_updates_enabled():
        return None
    cache = updates.read_cache(UPDATE_CACHE_PATH)
    latest = cache.get("latestVersion")
    if not updates.is_newer(latest, APP_VERSION):
        return None
    return {"version": latest, "url": cache.get("releaseUrl")}


def _decorate_with_versions(state: dict) -> dict:
    """Add currentVersion/latestVersion/releaseUrl to a state dict in place.

    Factored out of state_with_versions() so callers that already have a
    freshly-built state dict (e.g. POST /api/state's success response, which
    gets one back from import_state()) don't have to pay for a second full
    export_state() just to pick up these three fields.
    """
    state["currentVersion"] = APP_VERSION
    update = current_update()
    state["latestVersion"] = update["version"] if update else None
    state["releaseUrl"] = update["url"] if update else None
    return state


def state_with_versions() -> dict:
    """export_state() decorated with the three version fields GET /api/state already carries."""
    return _decorate_with_versions(export_state())


def refresh_update_cache_if_due() -> None:
    """Спросить GitHub, если прошли сутки с последнего успешного запроса."""
    if not check_updates_enabled():
        return
    cache = updates.read_cache(UPDATE_CACHE_PATH)
    if not updates.should_check(cache, datetime.now(timezone.utc)):
        return
    updates.check_now(UPDATE_CACHE_PATH)


# GET /api/state is polled by the mobile app every 15s for sync, so this guard
# must keep it a cheap no-op almost every time: only spawn a background thread
# when a check is actually due (per updates.should_check), and never spawn a
# second thread while one is already in flight — the lock below (acquired
# non-blocking) makes a concurrent call a no-op instead of piling up threads.
_update_check_lock = threading.Lock()


def _run_update_check_and_release_lock() -> None:
    try:
        refresh_update_cache_if_due()
    finally:
        _update_check_lock.release()


def start_background_update_check() -> None:
    """Проверка в фоне: старт сервера не должен ждать сети.

    Ничего не делает (и не создаёт поток), если проверка выключена, если
    она не назрела, или если другая проверка уже выполняется."""
    if not check_updates_enabled():
        return
    cache = updates.read_cache(UPDATE_CACHE_PATH)
    if not updates.should_check(cache, datetime.now(timezone.utc)):
        return
    if not _update_check_lock.acquire(blocking=False):
        return
    thread = threading.Thread(target=_run_update_check_and_release_lock, daemon=True)
    try:
        thread.start()
    except Exception:
        # thread.start() failing (rare — e.g. OS thread-creation failure)
        # would otherwise leave the lock held forever, permanently disabling
        # update checks for the rest of the process's life. Update checks
        # are meant to be entirely optional and silent (see module docstring
        # in updates.py) — log and swallow rather than crash the request
        # thread that happened to trigger this (GET /api/state, polled by
        # the mobile app every 15s).
        logging.exception("Не удалось запустить фоновый поток проверки обновлений")
        _update_check_lock.release()


LOG_HANDLER_NAME = "warehouse-file"


def setup_logging() -> None:
    """Логи запуска и ошибок — в файл с ротацией, чтобы было что приложить к жалобе.

    Идемпотентна: трей вызывает её при запуске, а main() — при консольном
    старте; второй обработчик писал бы каждую строку дважды.
    """
    root_logger = logging.getLogger()
    if any(handler.get_name() == LOG_HANDLER_NAME for handler in root_logger.handlers):
        return
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:  # noqa: BLE001
        print(f"Не удалось создать папку для логов ({exc}) — работаю без файла логов.")
        return
    handler = RotatingFileHandler(
        LOG_DIR / "warehouse.log", maxBytes=5_000_000, backupCount=3, encoding="utf-8"
    )
    handler.set_name(LOG_HANDLER_NAME)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    root_logger.setLevel(logging.INFO)
    root_logger.addHandler(handler)


_config = load_config()
# host "127.0.0.1" — доступ только с этого компьютера;
# host "0.0.0.0" — доступ по локальной сети (см. setup_lan.bat).
HOST = str(_config.get("host", "127.0.0.1"))
PORT = int(_config.get("port", 8765))


def reload_config() -> None:
    """Перечитать config.json и обновить HOST/PORT.

    HOST/PORT вычисляются один раз при импорте модуля — но
    paths.migrate_legacy_data() (переносящий старый config.json с реальными
    host/port пользователя в DATA_DIR) выполняется ПОЗЖЕ, внутри main() и
    warehouse_tray.start_server(), уже после того как этот импорт отработал.
    Без этого вызова тот самый запуск, который выполняет миграцию, всё ещё
    слушает на loopback по умолчанию — пользователю, обновившемуся со
    старой версии в LAN-режиме, пришлось бы перезапускать приложение
    вручную, чтобы телефон снова смог достучаться до сервера.
    """
    global HOST, PORT
    config = load_config()
    HOST = str(config.get("host", HOST))
    PORT = int(config.get("port", PORT))


def _prune_backups() -> None:
    files = sorted(BACKUP_DIR.glob("*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[MAX_BACKUPS:]:
        old.unlink(missing_ok=True)


def _copy_database(source_path: Path, dest_path: Path) -> None:
    """Snapshot a SQLite database file using SQLite's own online backup API.

    A plain shutil.copy2() of DB_PATH is not safe while the server is running.
    Every connection runs in WAL mode (Task B1), so committed data can live
    only in warehouse.db-wal — a file copy of warehouse.db alone silently
    produces a backup missing that data — and SQLite's own size-based
    auto-checkpoint can rewrite warehouse.db *while* the copy is in progress,
    tearing it. Connection.backup() is WAL-aware and serializes against
    concurrent writers, so it always yields one self-contained, consistent file
    with no -wal/-shm sidecars of its own.

    Best-effort fallback: if the source isn't readable as a database at all
    (fresh/corrupt file), fall back to a plain copy so that e.g.
    pre_restore_backup() still preserves whatever is there before it's
    overwritten — exactly what the old shutil.copy2() did.
    """
    source = sqlite3.connect(source_path)
    try:
        destination = sqlite3.connect(dest_path)
        try:
            source.backup(destination)
        finally:
            destination.close()
    except sqlite3.DatabaseError as exc:
        # As in init_db() and handle_restore_backup(): a raw sqlite3.DatabaseError
        # (not a more specific subclass like OperationalError/IntegrityError)
        # means SQLite couldn't even read the file as a database. Subclasses
        # indicate a real problem and must not be swallowed.
        if type(exc) is not sqlite3.DatabaseError:
            raise
        print(
            f"ПРЕДУПРЕЖДЕНИЕ: {source_path} не читается как база данных ({exc}) — "
            "копирую файл как есть."
        )
        dest_path.unlink(missing_ok=True)
        shutil.copy2(source_path, dest_path)
    finally:
        source.close()


def auto_backup() -> str | None:
    """Create a timestamped backup of the database file."""
    if not DB_PATH.exists():
        return None
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"warehouse_{stamp}.db"
    _copy_database(DB_PATH, dest)
    _prune_backups()
    return str(dest)


def pre_migration_backup() -> str | None:
    """Separate, clearly-labeled backup taken only when migrations are about to run."""
    if not DB_PATH.exists():
        return None
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"pre_migration_{stamp}.db"
    _copy_database(DB_PATH, dest)
    _prune_backups()
    return str(dest)


def pre_restore_backup() -> str | None:
    """Snapshot of the current DB taken right before a one-click restore overwrites it."""
    if not DB_PATH.exists():
        return None
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"pre_restore_{stamp}.db"
    _copy_database(DB_PATH, dest)
    _prune_backups()
    return str(dest)


def list_backups() -> list[dict]:
    if not BACKUP_DIR.exists():
        return []
    files = sorted(BACKUP_DIR.glob("*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    return [
        {
            "filename": p.name,
            "createdAt": datetime.fromtimestamp(p.stat().st_mtime).isoformat(),
            "sizeBytes": p.stat().st_size,
        }
        for p in files
    ]


VALID_STATUSES = {"in_stock", "assigned", "partial", "repair", "retired"}
VALID_MOVEMENT_TYPES = {"purchase", "issue", "return", "repair", "repair_return", "retire", "edit", "delete"}

# Serializes read-check-write cycles on /api/state so concurrent POSTs
# can't both pass the version check.
STATE_LOCK = threading.Lock()


def validate_state(payload: dict) -> str | None:
    """Basic server-side validation. Returns error message or None."""
    if not isinstance(payload, dict):
        return "Payload must be a JSON object."
    for emp in payload.get("employees", []):
        if not emp.get("id") or not emp.get("fullName", "").strip():
            return "Each employee must have an id and fullName."
    for asset in payload.get("assets", []):
        if not asset.get("id") or not asset.get("name", "").strip():
            return "Each asset must have an id and name."
        status = asset.get("status", "in_stock")
        if status not in VALID_STATUSES:
            return f"Invalid asset status: {status}"
        qty = asset.get("quantity", 1)
        if not isinstance(qty, (int, float)) or qty < 0:
            return f"Invalid quantity for asset {asset.get('name')}."
        allocated = 0
        for alloc in asset.get("allocations") or []:
            alloc_qty = alloc.get("quantity", 0)
            if not isinstance(alloc_qty, (int, float)) or alloc_qty < 0:
                return f"Некорректное количество в выдаче по позиции «{asset.get('name')}»."
            allocated += alloc_qty
        repair_qty = asset.get("repairQuantity", 0) or 0
        if not isinstance(repair_qty, (int, float)) or repair_qty < 0:
            return f"Некорректное количество в ремонте по позиции «{asset.get('name')}»."
        if allocated + repair_qty > qty:
            return (
                f"По позиции «{asset.get('name')}» выдано и в ремонте {allocated + repair_qty} шт. "
                f"при общем количестве {qty} шт. Сначала оформите возврат."
            )
    for mov in payload.get("movements", []):
        if not mov.get("id"):
            return "Each movement must have an id."
        mtype = mov.get("type", "")
        if mtype not in VALID_MOVEMENT_TYPES:
            return f"Invalid movement type: {mtype}"
    return None

EMPTY_STATE = {
    "meta": {"updatedAt": None},
    "employees": [],
    "assets": [],
    "movements": [],
}


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


class DatabaseIntegrityError(RuntimeError):
    """Raised by init_db() when warehouse.db fails PRAGMA integrity_check.

    Deliberately a RuntimeError (i.e. an Exception) rather than SystemExit:
    warehouse_tray.py — the shipped EXE's launch path, built with
    console=False — wraps init_db() in `except Exception`, and a SystemExit
    would sail straight past it and kill the app with no window, no tray icon
    and no message anywhere. `str(exc)` is the full Russian message meant to be
    shown to the user as-is.
    """


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    is_fresh_install = not DB_PATH.exists()
    try:
        with get_connection() as connection:
            connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
            if not is_fresh_install and migrations.pending_migrations(connection):
                pre_migration_backup()
            migrations.run_migrations(connection)
            result = connection.execute("PRAGMA integrity_check").fetchone()[0]
    except sqlite3.DatabaseError as exc:
        # A raw sqlite3.DatabaseError here (not a more specific subclass like
        # IntegrityError/OperationalError) means SQLite couldn't even read the
        # file as a database (e.g. "file is not a database") — treat that the
        # same as a failed integrity_check rather than letting a confusing
        # traceback crash the server. Subclasses are re-raised as-is: those
        # indicate a real bug (e.g. in a migration), not file corruption.
        if type(exc) is not sqlite3.DatabaseError:
            raise
        result = str(exc)
    if result != "ok":
        available = "\n".join(f"  - {b['filename']} ({b['createdAt']})" for b in list_backups())
        raise DatabaseIntegrityError(
            "ОШИБКА: проверка целостности базы данных не пройдена "
            f"({result}).\n"
            f"База данных: {DB_PATH}\n"
            "Доступные резервные копии в backups/:\n"
            f"{available or '  (нет резервных копий)'}\n"
            "Скопируйте один из файлов поверх warehouse.db вручную и запустите сервер снова."
        )


def read_state_version(connection: sqlite3.Connection) -> int:
    row = connection.execute("SELECT value FROM app_meta WHERE key = 'state_version'").fetchone()
    try:
        return int(row["value"]) if row else 0
    except (TypeError, ValueError):
        return 0


def get_state_version() -> int:
    with get_connection() as connection:
        return read_state_version(connection)


def compute_attention_items(assets: list[dict], settings: dict, *, today: date | None = None) -> list[dict]:
    today = today or datetime.now(timezone.utc).date()
    warranty_days = int(settings.get("attentionWarrantyDays") or 30)
    repair_days = int(settings.get("attentionRepairDays") or 14)
    items: list[dict] = []
    for asset in assets:
        warranty_end = (asset.get("warrantyEnd") or "").strip()
        if warranty_end:
            try:
                end_date = date.fromisoformat(warranty_end)
            except ValueError:
                end_date = None
            if end_date is not None and (end_date - today).days <= warranty_days:
                days_left = (end_date - today).days
                detail = (
                    f"Гарантия истекла {days_left * -1} дн. назад" if days_left < 0
                    else f"Гарантия истекает через {days_left} дн." if days_left > 0
                    else "Гарантия истекает сегодня"
                )
                items.append({
                    "type": "warranty", "assetId": asset["id"],
                    "assetName": asset.get("name") or "", "detail": detail,
                })
    return items


def export_state() -> dict:
    with get_connection() as connection:
        meta_row = connection.execute("SELECT value FROM app_meta WHERE key = 'updated_at'").fetchone()
        version = read_state_version(connection)
        employees = [dict(row) for row in connection.execute(
            "SELECT id, full_name AS fullName, department, site, position, email, phone, status FROM employees ORDER BY full_name"
        )]

        departments = [dict(row) for row in connection.execute(
            "SELECT id, name FROM departments ORDER BY name"
        )]

        sites = [dict(row) for row in connection.execute(
            "SELECT id, name FROM sites ORDER BY name"
        )]

        allocations_by_asset: dict[str, list[dict]] = {}
        for row in connection.execute(
            "SELECT asset_id, employee_id, department, site, quantity FROM asset_allocations WHERE quantity > 0 ORDER BY asset_id, employee_id, department, site"
        ):
            allocations_by_asset.setdefault(row["asset_id"], []).append(
                {"employeeId": row["employee_id"], "department": row["department"] or "", "site": row["site"] or "", "quantity": row["quantity"]}
            )

        assets = []
        for row in connection.execute(
            "SELECT id, name, category, inventory_number, serial_number, purchase_date, status, notes, quantity, repair_quantity, retired_quantity, min_quantity, warranty_end, price, repair_date, location, photo_url, label_printed_at, rev FROM assets ORDER BY name"
        ):
            assets.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "category": row["category"] or "",
                    "inventoryNumber": row["inventory_number"] or "",
                    "serialNumber": row["serial_number"] or "",
                    "purchaseDate": row["purchase_date"] or "",
                    "status": row["status"],
                    "notes": row["notes"] or "",
                    "quantity": row["quantity"],
                    "repairQuantity": row["repair_quantity"] or 0,
                    "retiredQuantity": row["retired_quantity"] or 0,
                    "minQuantity": row["min_quantity"] or 0,
                    "warrantyEnd": row["warranty_end"] or "",
                    "price": row["price"] or 0,
                    "repairDate": row["repair_date"] or "",
                    "location": row["location"] or "",
                    "photoUrl": row["photo_url"] or "",
                    "labelPrintedAt": row["label_printed_at"] or None,
                    "rev": row["rev"],
                    "allocations": allocations_by_asset.get(row["id"], []),
                }
            )

        movements = [dict(row) for row in connection.execute(
            "SELECT id, type, asset_id AS assetId, employee_id AS employeeId, department, site, act_number AS actNumber, quantity, date, notes FROM movements ORDER BY date DESC, id DESC"
        )]

        audit = []
        for row in connection.execute(
            "SELECT id, entity_type AS entityType, entity_id AS entityId, action, changes, actor, timestamp "
            "FROM audit_log ORDER BY id DESC LIMIT 200"
        ):
            entry = dict(row)
            entry["changes"] = json.loads(entry["changes"] or "{}")
            audit.append(entry)

        kits = []
        for row in connection.execute("SELECT id, name, items FROM kit_templates ORDER BY name"):
            kits.append({"id": row["id"], "name": row["name"], "items": json.loads(row["items"] or "[]")})

        active_inventory_session = _load_active_inventory_session(connection)

    return {
        "meta": {"updatedAt": meta_row["value"] if meta_row else None, "version": version},
        "employees": employees,
        "departments": departments,
        "sites": sites,
        "assets": assets,
        "movements": movements,
        "auditLog": audit,
        "kitTemplates": kits,
        "activeInventorySession": active_inventory_session,
    }


def _load_active_inventory_session(connection: sqlite3.Connection) -> dict | None:
    row = connection.execute(
        "SELECT id, started_at, started_by FROM inventory_sessions WHERE status = 'open'"
    ).fetchone()
    if row is None:
        return None
    return {"id": row["id"], "startedAt": row["started_at"], "startedBy": row["started_by"]}


def import_state(payload: dict, actor: str) -> dict:
    employees = payload.get("employees", [])
    departments = payload.get("departments", [])
    sites = payload.get("sites", [])
    assets = payload.get("assets", [])
    movements = payload.get("movements", [])
    updated_at = (payload.get("meta") or {}).get("updatedAt")

    with get_connection() as connection:
        connection.execute("BEGIN")
        # Deferred FK enforcement: assets get DELETEd and re-INSERTed within
        # this same transaction below, but inventory_scans.asset_id (added by
        # migration 026) references assets(id) and is never touched by this
        # function (it's historical audit data, not part of the state
        # payload). Without deferral, the DELETE FROM assets a few lines down
        # would fail immediately the moment any inventory session has ever
        # recorded a scan. Deferring resolves the common case (any
        # edit-and-save re-inserts the same asset ids) with zero behavior
        # change; a genuine delete of an asset with scan history still fails,
        # but only at COMMIT — handled by the sqlite3.IntegrityError catch
        # around this function's call site in do_POST.
        connection.execute("PRAGMA defer_foreign_keys = ON")
        old_assets = {
            row["id"]: (
                row["name"], row["category"] or "", row["inventory_number"] or "",
                row["serial_number"] or "", row["location"] or "", row["purchase_date"] or "",
                row["warranty_end"] or "", row["rev"], row["label_printed_at"],
            )
            for row in connection.execute(
                "SELECT id, name, category, inventory_number, serial_number, location, "
                "purchase_date, warranty_end, rev, label_printed_at FROM assets"
            )
        }
        connection.execute("DELETE FROM asset_allocations")
        connection.execute("DELETE FROM movements")
        connection.execute("DELETE FROM assets")
        connection.execute("DELETE FROM employees")
        connection.execute("DELETE FROM departments")
        connection.execute("DELETE FROM sites")

        for employee in employees:
            connection.execute(
                "INSERT INTO employees (id, full_name, department, site, position, email, phone, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    employee.get("id"),
                    employee.get("fullName") or "",
                    employee.get("department") or "",
                    employee.get("site") or "",
                    employee.get("position") or "",
                    employee.get("email") or "",
                    employee.get("phone") or "",
                    employee.get("status") or "active",
                ),
            )

        for department in departments:
            connection.execute(
                "INSERT INTO departments (id, name) VALUES (?, ?)",
                (department.get("id"), department.get("name") or ""),
            )

        for site in sites:
            connection.execute(
                "INSERT INTO sites (id, name) VALUES (?, ?)",
                (site.get("id"), site.get("name") or ""),
            )

        for asset in assets:
            new_fields = (
                asset.get("name") or "Без названия",
                asset.get("category") or "",
                asset.get("inventoryNumber") or "",
                asset.get("serialNumber") or "",
                asset.get("location") or "",
                asset.get("purchaseDate") or "",
                asset.get("warrantyEnd") or "",
            )
            old = old_assets.get(asset.get("id"))
            if old is None:
                new_rev = 0
            elif old[:7] == new_fields:
                new_rev = old[7]
            else:
                new_rev = old[7] + 1
            # label_printed_at is server-owned (set by the label-printed
            # endpoint, read by the label-print filter) — the desktop app.js
            # state object never carries it, so it must be preserved from the
            # OLD row rather than read from the client payload, exactly like
            # rev above. Otherwise every desktop save would silently wipe it.
            old_label_printed_at = old[8] if old is not None else None
            connection.execute(
                """
                INSERT INTO assets (id, name, category, inventory_number, serial_number, purchase_date, status, notes, quantity, repair_quantity, retired_quantity, min_quantity, warranty_end, price, repair_date, location, photo_url, rev, label_printed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    asset.get("id"),
                    asset.get("name") or "Без названия",
                    asset.get("category") or "",
                    asset.get("inventoryNumber") or "",
                    asset.get("serialNumber") or "",
                    asset.get("purchaseDate") or "",
                    asset.get("status") or "in_stock",
                    asset.get("notes") or "",
                    max(1, int(asset.get("quantity") or 1)),
                    max(0, int(asset.get("repairQuantity") or 0)),
                    max(0, int(asset.get("retiredQuantity") or 0)),
                    max(0, int(asset.get("minQuantity") or 0)),
                    asset.get("warrantyEnd") or "",
                    max(0, float(asset.get("price") or 0)),
                    asset.get("repairDate") or "",
                    asset.get("location") or "",
                    asset.get("photoUrl") or "",
                    new_rev,
                    old_label_printed_at,
                ),
            )
            for allocation in asset.get("allocations", []):
                quantity = int(allocation.get("quantity") or 0)
                if quantity <= 0:
                    continue
                connection.execute(
                    "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) VALUES (?, ?, ?, ?, ?)",
                    (asset.get("id"), allocation.get("employeeId") or None, allocation.get("department") or "", allocation.get("site") or "", quantity),
                )

        for movement in movements:
            connection.execute(
                "INSERT INTO movements (id, type, asset_id, employee_id, department, site, act_number, quantity, date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    movement.get("id"),
                    movement.get("type") or "purchase",
                    movement.get("assetId"),
                    movement.get("employeeId") or None,
                    movement.get("department") or "",
                    movement.get("site") or "",
                    movement.get("actNumber"),
                    int(movement.get("quantity") or 0),
                    movement.get("date") or "",
                    movement.get("notes") or "",
                ),
            )

        # Save audit log entries
        for entry in payload.get("auditLog", []):
            if not entry.get("id"):  # only new entries (without numeric id)
                connection.execute(
                    "INSERT INTO audit_log (entity_type, entity_id, action, changes, actor, timestamp) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (entry.get("entityType", ""), entry.get("entityId", ""), entry.get("action", ""),
                     json.dumps(entry.get("changes", {}), ensure_ascii=False), actor, entry.get("timestamp", "")),
                )

        # Save kit templates
        connection.execute("DELETE FROM kit_templates")
        for kit in payload.get("kitTemplates", []):
            connection.execute(
                "INSERT INTO kit_templates (id, name, items) VALUES (?, ?, ?)",
                (kit.get("id"), kit.get("name", ""), json.dumps(kit.get("items", []), ensure_ascii=False)),
            )

        connection.execute(
            "INSERT INTO app_meta (key, value) VALUES ('updated_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (updated_at,),
        )
        new_version = read_state_version(connection) + 1
        connection.execute(
            "INSERT INTO app_meta (key, value) VALUES ('state_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(new_version),),
        )
        connection.commit()

    return export_state()


class WarehouseHandler(BaseHTTPRequestHandler):
    def read_body(self) -> bytes:
        """Read the request body, or None if the request must be rejected.

        Callers MUST treat a None return as "response already sent, stop" —
        the size check runs before any authentication, so an unauthenticated
        caller can't make the server allocate an arbitrary buffer just by
        sending a large Content-Length.
        """
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Некорректный заголовок Content-Length.")
            return None
        if length < 0:
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Некорректный заголовок Content-Length.")
            return None
        if length > MAX_BODY_BYTES:
            self.send_json_error(
                HTTPStatus.BAD_REQUEST,
                f"Слишком большой запрос: максимум {MAX_BODY_BYTES // (1024 * 1024)} МБ.",
            )
            return None
        return self.rfile.read(length) if length else b""

    def authenticate(self):
        auth_header = self.headers.get("Authorization", "")
        token = auth_header[len("Bearer "):] if auth_header.startswith("Bearer ") else ""
        with get_connection() as connection:
            user = auth.validate_token(connection, token)
        if user is None:
            self.send_json_error(HTTPStatus.UNAUTHORIZED, "Требуется авторизация")
            return None
        return user

    def require_role(self, user, allowed) -> bool:
        if not auth.role_allows(user["role"], allowed):
            self.send_json_error(HTTPStatus.FORBIDDEN, "Недостаточно прав")
            return False
        return True

    def verify_channel_signature(self, user, body: bytes) -> bool:
        if auth.is_loopback(self.client_address[0]):
            return True
        secret = user["device_secret"]
        header_value = self.headers.get("X-Signature", "")
        if not secret or not auth.verify_signature(self.command, self.path, body, secret, header_value):
            self.send_json_error(HTTPStatus.UNAUTHORIZED, "Неверная или отсутствующая подпись запроса")
            return False
        return True

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.serve_static(parsed.path)
            return
        if parsed.path == "/api/setup-status":
            with get_connection() as connection:
                needs_setup = not auth.has_any_user(connection)
            self.send_json({"needsSetup": needs_setup})
            return
        user = self.authenticate()
        if user is None:
            return
        if not self.verify_channel_signature(user, b""):
            return
        if parsed.path == "/api/state":
            state = state_with_versions()
            start_background_update_check()
            self.send_json(state)
            return
        if parsed.path == "/api/lan-info":
            self.send_json({"lanMode": HOST != "127.0.0.1", "lanIp": get_lan_ip(), "port": PORT})
            return
        if parsed.path == "/api/users":
            if not self.require_role(user, ("admin",)):
                return
            with get_connection() as connection:
                users = auth.list_users(connection)
            self.send_json({"users": users})
            return
        if parsed.path == "/api/backups":
            if not self.require_role(user, ("admin",)):
                return
            self.handle_list_backups()
            return
        if parsed.path.startswith("/api/inventory/sessions/") and parsed.path.endswith("/act"):
            if not self.require_role(user, ("admin",)):
                return
            session_id = parsed.path[len("/api/inventory/sessions/"):-len("/act")]
            self.handle_inventory_act(session_id)
            return
        if parsed.path == "/api/inventory/sessions":
            if not self.require_role(user, ("admin",)):
                return
            self.handle_list_inventory_sessions()
            return
        if parsed.path == "/api/settings":
            if not self.require_role(user, ("admin",)):
                return
            self.handle_get_settings()
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        body = self.read_body()
        if body is None:
            return
        if parsed.path == "/api/setup":
            self.handle_setup(body)
            return
        if parsed.path == "/api/login":
            self.handle_login(body)
            return
        if parsed.path == "/api/pair":
            self.handle_pair(body)
            return
        user = self.authenticate()
        if user is None:
            return
        if not self.verify_channel_signature(user, body):
            return
        if parsed.path == "/api/logout":
            with get_connection() as connection:
                auth.revoke_token(connection, user["token"])
            self.send_json({"ok": True})
            return
        if parsed.path == "/api/users":
            if not self.require_role(user, ("admin",)):
                return
            self.handle_create_user(body)
            return
        if parsed.path == "/api/pair/generate":
            if not self.require_role(user, ("admin",)):
                return
            self.handle_generate_pairing(body)
            return
        if parsed.path == "/api/backups/restore":
            if not self.require_role(user, ("admin",)):
                return
            self.handle_restore_backup(body)
            return
        if parsed.path == "/api/settings":
            if not self.require_role(user, ("admin",)):
                return
            self.handle_save_settings(body)
            return
        if parsed.path == "/api/inventory/start":
            if not self.require_role(user, ("admin",)):
                return
            self.handle_start_inventory(user["username"])
            return
        if parsed.path == "/api/act":
            if not self.require_role(user, ("admin", "storekeeper")):
                return
            self.handle_act_request(body)
            return
        if parsed.path == "/api/mobile/action":
            if not self.require_role(user, ("admin", "storekeeper")):
                return
            self.handle_mobile_action(body)
            return
        if parsed.path == "/api/assets/label-printed":
            if not self.require_role(user, ("admin", "storekeeper")):
                return
            self.handle_mark_labels_printed(body)
            return
        if parsed.path != "/api/state":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not self.require_role(user, ("admin", "storekeeper")):
            return
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError as exc:
            self.send_json_error(HTTPStatus.BAD_REQUEST, f"invalid json: {exc}")
            return
        error = validate_state(payload)
        if error:
            self.send_json_error(HTTPStatus.BAD_REQUEST, error)
            return
        with STATE_LOCK:
            base_version = (payload.get("meta") or {}).get("version")
            try:
                base_version = int(base_version) if base_version is not None else None
            except (TypeError, ValueError):
                base_version = None
            # Old clients don't send a version — accept their writes as before.
            if base_version is not None and base_version != get_state_version():
                conflict_body = json.dumps(
                    {
                        "error": "Данные были изменены в другом окне. Состояние обновлено — повторите последнее действие.",
                        "state": state_with_versions(),
                    },
                    ensure_ascii=False,
                ).encode("utf-8")
                self.send_response(HTTPStatus.CONFLICT)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(conflict_body)))
                self.end_headers()
                self.wfile.write(conflict_body)
                return
            auto_backup()
            try:
                state = _decorate_with_versions(import_state(payload, actor=user["username"]))
            except sqlite3.IntegrityError:
                # The desktop payload omitted an asset that still has
                # inventory_scans history referencing it (a true delete, not
                # just an edit) — import_state's deferred FK check catches
                # this at COMMIT time. The transaction rolled back, so the
                # server's state is unchanged — but the client's in-memory
                # state_version is now stale relative to nothing having
                # actually been persisted, so this must carry "state" the
                # same way the version-conflict branch above does: without
                # it, the desktop's existing `if (data.state)` reconciliation
                # never triggers, and every subsequent save keeps retrying
                # against the same stale version and getting 409'd again.
                conflict_body = json.dumps(
                    {
                        "error": "Нельзя удалить актив с историей инвентаризации.",
                        "state": state_with_versions(),
                    },
                    ensure_ascii=False,
                ).encode("utf-8")
                self.send_response(HTTPStatus.CONFLICT)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(conflict_body)))
                self.end_headers()
                self.wfile.write(conflict_body)
                return
        self.send_json(state)

    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        body = self.read_body()
        if body is None:
            return
        user = self.authenticate()
        if user is None:
            return
        if not self.verify_channel_signature(user, body):
            return
        if not self.require_role(user, ("admin",)):
            return
        if parsed.path.startswith("/api/users/"):
            self.handle_update_user(parsed.path[len("/api/users/"):], body)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_setup(self, body: bytes) -> None:
        # Bootstrapping the very first admin is a local-console action. Allowing
        # it over the network would hand the first account to whoever reaches
        # the port first on a fresh install.
        if not auth.is_loopback(self.client_address[0]):
            self.send_json_error(
                HTTPStatus.FORBIDDEN,
                "Первого администратора можно создать только на самом сервере.",
            )
            return
        with get_connection() as connection:
            if auth.has_any_user(connection):
                self.send_json_error(HTTPStatus.CONFLICT, "Администратор уже создан.")
                return
            try:
                payload = json.loads(body or b"{}")
            except json.JSONDecodeError as exc:
                self.send_json_error(HTTPStatus.BAD_REQUEST, f"invalid json: {exc}")
                return
            if not isinstance(payload, dict):
                self.send_json_error(HTTPStatus.BAD_REQUEST, "Payload must be a JSON object.")
                return
            username = str(payload.get("username") or "").strip()
            password = str(payload.get("password") or "")
            if not username or not password:
                self.send_json_error(HTTPStatus.BAD_REQUEST, "Укажите логин и пароль.")
                return
            try:
                user = auth.create_user(connection, username, password, "admin")
            except auth.AuthError as exc:
                self.send_json_error(HTTPStatus.BAD_REQUEST, str(exc))
                return
            session = auth.create_session(connection, user["id"])
        self.send_json({"token": session["token"], "expiresAt": session["expiresAt"], "role": "admin"})

    def handle_login(self, body: bytes) -> None:
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError as exc:
            self.send_json_error(HTTPStatus.BAD_REQUEST, f"invalid json: {exc}")
            return
        if not isinstance(payload, dict):
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Payload must be a JSON object.")
            return
        username = str(payload.get("username") or "")
        password = str(payload.get("password") or "")
        with get_connection() as connection:
            user = auth.authenticate_user(connection, username, password)
            if user is None:
                self.send_json_error(HTTPStatus.UNAUTHORIZED, "Неверный логин или пароль.")
                return
            session = auth.create_session(connection, user["id"])
        self.send_json({"token": session["token"], "expiresAt": session["expiresAt"], "role": user["role"]})

    def handle_create_user(self, body: bytes) -> None:
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError as exc:
            self.send_json_error(HTTPStatus.BAD_REQUEST, f"invalid json: {exc}")
            return
        if not isinstance(payload, dict):
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Payload must be a JSON object.")
            return
        username = str(payload.get("username") or "").strip()
        password = str(payload.get("password") or "")
        role = str(payload.get("role") or "")
        if not password:
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Пароль не может быть пустым.")
            return
        with get_connection() as connection:
            try:
                user = auth.create_user(connection, username, password, role)
            except auth.AuthError as exc:
                self.send_json_error(HTTPStatus.BAD_REQUEST, str(exc))
                return
        self.send_json(user)

    def handle_update_user(self, user_id: str, body: bytes) -> None:
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError as exc:
            self.send_json_error(HTTPStatus.BAD_REQUEST, f"invalid json: {exc}")
            return
        if not isinstance(payload, dict):
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Payload must be a JSON object.")
            return
        with get_connection() as connection:
            target = auth.get_user_by_id(connection, user_id)
            if target is None:
                self.send_json_error(HTTPStatus.BAD_REQUEST, "Пользователь не найден.")
                return
            # Never let the system end up with no active admin: /api/setup
            # refuses to run once any user exists, so there would be no way back
            # in. Evaluate role and isActive together — a single request can
            # demote and deactivate at once.
            new_role = str(payload["role"]) if "role" in payload else target["role"]
            new_active = bool(payload["isActive"]) if "isActive" in payload else bool(target["is_active"])
            was_active_admin = target["role"] == "admin" and bool(target["is_active"])
            stays_active_admin = new_role == "admin" and new_active
            if was_active_admin and not stays_active_admin and auth.count_active_admins(connection) <= 1:
                self.send_json_error(
                    HTTPStatus.BAD_REQUEST,
                    "Нельзя деактивировать или понизить единственного администратора.",
                )
                return
            try:
                if "role" in payload:
                    auth.set_user_role(connection, user_id, str(payload["role"]))
                if "isActive" in payload:
                    auth.set_user_active(connection, user_id, bool(payload["isActive"]))
                if payload.get("password"):
                    auth.set_user_password(connection, user_id, str(payload["password"]))
            except auth.AuthError as exc:
                self.send_json_error(HTTPStatus.BAD_REQUEST, str(exc))
                return
        self.send_json({"ok": True})

    def handle_generate_pairing(self, body: bytes) -> None:
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError as exc:
            self.send_json_error(HTTPStatus.BAD_REQUEST, f"invalid json: {exc}")
            return
        if not isinstance(payload, dict):
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Payload must be a JSON object.")
            return
        user_id = str(payload.get("userId") or "")
        with get_connection() as connection:
            if auth.get_user_by_id(connection, user_id) is None:
                self.send_json_error(HTTPStatus.BAD_REQUEST, "Пользователь не найден.")
                return
            pairing = auth.generate_pairing_code(connection, user_id)
        self.send_json(pairing)

    def handle_pair(self, body: bytes) -> None:
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError as exc:
            self.send_json_error(HTTPStatus.BAD_REQUEST, f"invalid json: {exc}")
            return
        if not isinstance(payload, dict):
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Payload must be a JSON object.")
            return
        code = str(payload.get("code") or "")
        with get_connection() as connection:
            try:
                result = auth.redeem_pairing_code(connection, code)
            except auth.PairingError as exc:
                self.send_json_error(HTTPStatus.BAD_REQUEST, str(exc))
                return
        self.send_json(result)

    def handle_mobile_action(self, body: bytes) -> None:
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError as exc:
            self.send_json_error(HTTPStatus.BAD_REQUEST, f"invalid json: {exc}")
            return
        if not isinstance(payload, dict):
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Payload must be a JSON object.")
            return
        with STATE_LOCK:
            auto_backup()
            try:
                with get_connection() as connection:
                    connection.execute("BEGIN")
                    result = mobile_actions.apply_action(connection, payload)
                    if not result["replayed"]:
                        new_version = read_state_version(connection) + 1
                        connection.execute(
                            "INSERT INTO app_meta (key, value) VALUES ('state_version', ?) "
                            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                            (str(new_version),),
                        )
                    else:
                        new_version = read_state_version(connection)
            except mobile_actions.EditConflictError as exc:
                body = json.dumps(
                    {"error": exc.message, "currentAsset": exc.current_asset}, ensure_ascii=False
                ).encode("utf-8")
                self.send_response(HTTPStatus.CONFLICT)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            except mobile_actions.MobileActionError as exc:
                self.send_json_error(HTTPStatus.BAD_REQUEST, exc.message)
                return
            except (sqlite3.Error, ValueError, TypeError, KeyError, AttributeError) as exc:
                # Anything else the mutation logic can raise on bad/inconsistent
                # input (a non-numeric quantity, an FK violation from a stale
                # employeeId, etc.) — always send a response so an offline-retry
                # client sees a clear rejection instead of a dropped connection
                # indistinguishable from "network down".
                self.send_json_error(HTTPStatus.BAD_REQUEST, str(exc))
                return
        result["version"] = new_version
        self.send_json(result)

    def handle_act_request(self, body: bytes) -> None:
        if generate_act is None:
            body_out = json.dumps({"error": f"act generator not available: {_ACT_IMPORT_ERROR}"}, ensure_ascii=False).encode("utf-8")
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body_out)))
            self.end_headers()
            self.wfile.write(body_out)
            return
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError as exc:
            body_out = json.dumps({"error": f"invalid json: {exc}"}, ensure_ascii=False).encode("utf-8")
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body_out)))
            self.end_headers()
            self.wfile.write(body_out)
            return
        try:
            docx_bytes = generate_act(
                act_number=payload.get("actNumber"),
                date_iso=payload.get("date"),
                employee=payload.get("employee"),
                items=payload.get("items") or [],
                is_issue=bool(payload.get("isIssue", True)),
            )
        except Exception as exc:  # noqa: BLE001
            body = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        filename = payload.get("filename") or f"act_{payload.get('actNumber') or 'document'}.docx"
        try:
            filename.encode("ascii")
            disp = f'attachment; filename="{filename}"'
        except UnicodeEncodeError:
            from urllib.parse import quote
            disp = f"attachment; filename*=UTF-8''{quote(filename)}"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        self.send_header("Content-Disposition", disp)
        self.send_header("Content-Length", str(len(docx_bytes)))
        self.end_headers()
        self.wfile.write(docx_bytes)

    def handle_list_backups(self) -> None:
        self.send_json({"backups": list_backups()})

    def handle_restore_backup(self, body: bytes) -> None:
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError as exc:
            self.send_json_error(HTTPStatus.BAD_REQUEST, f"invalid json: {exc}")
            return
        if not isinstance(payload, dict):
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Payload must be a JSON object.")
            return
        filename = str(payload.get("filename") or "")
        valid_names = {b["filename"] for b in list_backups()}
        if filename not in valid_names:
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Файл резервной копии не найден.")
            return
        candidate = BACKUP_DIR / filename
        with STATE_LOCK:
            check_stamp = datetime.now().strftime("%Y%m%d_%H%M%S%f")
            tmp_path = BACKUP_DIR / f"_restore_check_{check_stamp}.db"
            shutil.copy2(candidate, tmp_path)
            try:
                try:
                    check_connection = sqlite3.connect(tmp_path)
                    try:
                        result = check_connection.execute("PRAGMA integrity_check").fetchone()[0]
                    finally:
                        check_connection.close()
                except sqlite3.DatabaseError as exc:
                    # As in init_db(): a raw sqlite3.DatabaseError here (not a more
                    # specific subclass) means SQLite couldn't even read the file as
                    # a database (e.g. "file is not a database") — treat that the
                    # same as a failed integrity_check instead of crashing the
                    # request. The connection is still closed above (via the inner
                    # finally) so the temp file can be unlinked afterwards.
                    if type(exc) is not sqlite3.DatabaseError:
                        raise
                    result = str(exc)
                if result != "ok":
                    self.send_json_error(HTTPStatus.BAD_REQUEST, "Файл резервной копии повреждён.")
                    return
                pre_restore_backup()
                # NOT shutil.copy2(): overwriting warehouse.db as a plain file
                # leaves warehouse.db-wal/-shm behind, and any write that lands
                # between here and the next open of warehouse.db (e.g.
                # auth.validate_token()'s "UPDATE sessions SET last_used_at",
                # which runs on every authenticated request and does NOT take
                # STATE_LOCK) is replayed from that stale WAL on top of the
                # freshly restored file — silently reverting or corrupting the
                # restore. Connection.backup() writes through a live connection
                # to warehouse.db instead, so the WAL stays consistent with the
                # restored content.
                source = sqlite3.connect(tmp_path)
                try:
                    destination = get_connection()
                    try:
                        with destination:
                            source.backup(destination)
                    finally:
                        destination.close()
                finally:
                    source.close()
            finally:
                tmp_path.unlink(missing_ok=True)
            with get_connection() as connection:
                migrations.run_migrations(connection)
        self.send_json({"ok": True})

    def handle_get_settings(self) -> None:
        self.send_json({"checkUpdates": check_updates_enabled()})

    def handle_list_inventory_sessions(self) -> None:
        with get_connection() as connection:
            sessions = []
            for row in connection.execute(
                "SELECT id, started_at, finished_at, started_by, status "
                "FROM inventory_sessions ORDER BY started_at DESC"
            ):
                found_count = 0
                wrong_location_count = 0
                missing_count = 0
                extra_count = 0
                if row["status"] == "finished":
                    cached = connection.execute(
                        "SELECT response_json FROM mobile_action_log "
                        "WHERE response_json LIKE ? ORDER BY created_at DESC LIMIT 1",
                        (f'%"sessionId": "{row["id"]}"%',),
                    ).fetchone()
                    if cached is not None:
                        payload = json.loads(cached["response_json"])
                        found_count = payload.get("foundCount", 0)
                        wrong_location_count = payload.get("wrongLocationCount", 0)
                        missing_count = len(payload.get("missingAssetIds") or [])
                        extra_count = len(payload.get("extraCodes") or [])
                sessions.append(
                    {
                        "id": row["id"],
                        "startedAt": row["started_at"],
                        "finishedAt": row["finished_at"],
                        "startedBy": row["started_by"],
                        "status": row["status"],
                        "foundCount": found_count,
                        "wrongLocationCount": wrong_location_count,
                        "missingCount": missing_count,
                        "extraCount": extra_count,
                    }
                )
        self.send_json({"sessions": sessions})

    def handle_inventory_act(self, session_id: str) -> None:
        if generate_inventory_act is None:
            body_out = json.dumps(
                {"error": f"act generator not available: {_ACT_IMPORT_ERROR}"}, ensure_ascii=False
            ).encode("utf-8")
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body_out)))
            self.end_headers()
            self.wfile.write(body_out)
            return
        with get_connection() as connection:
            session_row = connection.execute(
                "SELECT id, started_at, finished_at, started_by, status FROM inventory_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            if session_row is None:
                self.send_json_error(HTTPStatus.NOT_FOUND, "Сессия инвентаризации не найдена.")
                return
            if session_row["status"] != "finished":
                self.send_json_error(HTTPStatus.CONFLICT, "Инвентаризация ещё не завершена.")
                return
            # quantity > 0: exclude fully-retired assets (retire decrements
            # quantity to 0 but never deletes the row) — same fix as Task A2's
            # apply_inventory_complete, otherwise retired items show up here
            # as permanently "not found".
            asset_names = {
                row["id"]: {"name": row["name"], "inventoryNumber": row["inventory_number"] or "", "location": row["location"] or ""}
                for row in connection.execute(
                    "SELECT id, name, inventory_number, location FROM assets WHERE quantity > 0"
                )
            }
            scanned_wrong_location = [
                {
                    "name": asset_names.get(row["asset_id"], {}).get("name", row["asset_id"]),
                    "inventoryNumber": asset_names.get(row["asset_id"], {}).get("inventoryNumber", ""),
                    "expectedLocation": asset_names.get(row["asset_id"], {}).get("location", ""),
                    "foundLocation": row["found_location"],
                }
                for row in connection.execute(
                    "SELECT asset_id, found_location FROM inventory_scans WHERE session_id = ? AND status = 'wrong_location'",
                    (session_id,),
                )
            ]
            # apply_inventory_complete already computed and cached the
            # correct "missing" snapshot (missingAssetIds, reflecting the
            # asset registry as it stood at submit time) into
            # mobile_action_log.response_json — handle_list_inventory_sessions
            # already reads that same cache. Recomputing live against the
            # CURRENT assets table (as this used to do) would disagree with
            # the desktop session list whenever assets are added/removed
            # after the session finished, which real warehouse use makes
            # likely by the time an act is actually downloaded.
            cached = connection.execute(
                "SELECT response_json FROM mobile_action_log WHERE response_json LIKE ? ORDER BY created_at DESC LIMIT 1",
                (f'%"sessionId": "{session_id}"%',),
            ).fetchone()
            extra_codes = []
            cached_missing_ids = []
            if cached is not None:
                cached_payload = json.loads(cached["response_json"])
                extra_codes = cached_payload.get("extraCodes") or []
                cached_missing_ids = cached_payload.get("missingAssetIds") or []
            missing_assets = [
                {
                    "name": asset_names.get(asset_id, {}).get("name", asset_id),
                    "inventoryNumber": asset_names.get(asset_id, {}).get("inventoryNumber", ""),
                }
                for asset_id in cached_missing_ids
            ]
        docx_bytes = generate_inventory_act(
            session={
                "id": session_row["id"],
                "startedAt": session_row["started_at"],
                "finishedAt": session_row["finished_at"],
                "startedBy": session_row["started_by"],
            },
            missing_assets=missing_assets,
            wrong_location=scanned_wrong_location,
            extra_codes=extra_codes,
        )
        filename = f"inventory_act_{session_id[:8]}.docx"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(docx_bytes)))
        self.end_headers()
        self.wfile.write(docx_bytes)

    def handle_start_inventory(self, username: str) -> None:
        # STATE_LOCK serializes this check-then-insert against other threads
        # calling the same handler (ThreadingHTTPServer) — without it, two
        # near-simultaneous POSTs can both see "no open session" before either
        # commits its INSERT, producing two open inventory_sessions rows and
        # violating "one open inventory session server-wide". Same pattern as
        # the /api/state import path and handle_restore_backup below.
        with STATE_LOCK:
            with get_connection() as connection:
                existing = connection.execute(
                    "SELECT id, started_at, started_by FROM inventory_sessions WHERE status = 'open'"
                ).fetchone()
                if existing is not None:
                    body = json.dumps(
                        {
                            "error": "Инвентаризация уже начата.",
                            "session": {
                                "id": existing["id"],
                                "startedAt": existing["started_at"],
                                "startedBy": existing["started_by"],
                            },
                        },
                        ensure_ascii=False,
                    ).encode("utf-8")
                    self.send_response(HTTPStatus.CONFLICT)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                session_id = str(uuid.uuid4())
                started_at = datetime.now(timezone.utc).isoformat()
                connection.execute(
                    "INSERT INTO inventory_sessions (id, started_at, started_by, status) VALUES (?, ?, ?, 'open')",
                    (session_id, started_at, username),
                )
        body = json.dumps({"sessionId": session_id, "startedAt": started_at}, ensure_ascii=False).encode("utf-8")
        self.send_response(HTTPStatus.CREATED)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_save_settings(self, body: bytes) -> None:
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError as exc:
            self.send_json_error(HTTPStatus.BAD_REQUEST, f"invalid json: {exc}")
            return
        if not isinstance(payload, dict):
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Payload must be a JSON object.")
            return
        value = payload.get("checkUpdates")
        if not isinstance(value, bool):
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Поле checkUpdates должно быть true или false.")
            return
        save_config({"checkUpdates": value})
        self.send_json({"ok": True})

    def handle_mark_labels_printed(self, body: bytes) -> None:
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError as exc:
            self.send_json_error(HTTPStatus.BAD_REQUEST, f"invalid json: {exc}")
            return
        asset_ids = payload.get("assetIds")
        if not isinstance(asset_ids, list):
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Поле assetIds должно быть списком.")
            return
        now = datetime.now(timezone.utc).isoformat()
        with get_connection() as connection:
            updated = 0
            for asset_id in asset_ids:
                cursor = connection.execute(
                    "UPDATE assets SET label_printed_at = ? WHERE id = ?", (now, str(asset_id))
                )
                updated += cursor.rowcount
        self.send_json({"updated": updated})

    def serve_static(self, raw_path: str) -> None:
        relative = "index.html" if raw_path in {"/", ""} else raw_path.lstrip("/")
        if relative not in STATIC_ALLOWLIST:
            # Not on the allowlist: always 404, never 403, so a probe can't tell
            # "exists but you may not have it" from "does not exist".
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        file_path = RESOURCE_DIR / relative
        if not file_path.exists() or not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content_type, _ = mimetypes.guess_type(file_path.name)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(file_path.read_bytes())

    def send_json(self, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json_error(self, status: HTTPStatus, message: str) -> None:
        body = json.dumps({"error": message}, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        return


def get_lan_ip() -> str | None:
    """Determine this machine's LAN address (no traffic is actually sent)."""
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return None


def main() -> None:
    setup_logging()
    if paths.migrate_legacy_data(_copy_database):
        reload_config()
    try:
        init_db()
    except DatabaseIntegrityError as exc:
        # Console launch path (python server.py / start_server.bat): keep the
        # old SystemExit behaviour — print the message, exit non-zero.
        # warehouse_tray.py (no console) handles this exception itself.
        print(str(exc))
        sys.exit(1)
    start_background_update_check()
    server = ThreadingHTTPServer((HOST, PORT), WarehouseHandler)
    logging.info("Сервер запускается на http://%s:%s", HOST, PORT)
    print(f"Warehouse app running at http://{HOST}:{PORT}")
    if HOST == "0.0.0.0":
        lan_ip = get_lan_ip()
        if lan_ip:
            print(f"Доступ с других компьютеров: http://{lan_ip}:{PORT}/")
        with get_connection() as connection:
            if not auth.has_any_user(connection):
                print("ВНИМАНИЕ: пользователей ещё нет — при первом открытии приложения появится мастер создания администратора.")
    print(f"Press Ctrl+C to stop the server")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        server.shutdown()


if __name__ == "__main__":
    main()
