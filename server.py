from __future__ import annotations

import json
import mimetypes
import shutil
import sqlite3
import sys
import threading
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

try:
    from act_generator import generate_act
except Exception as _act_err:  # noqa: BLE001
    generate_act = None
    _ACT_IMPORT_ERROR = str(_act_err)
else:
    _ACT_IMPORT_ERROR = ""

import mobile_actions
import migrations
import auth

if getattr(sys, 'frozen', False):
    ROOT = Path(sys.executable).resolve().parent
else:
    ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "warehouse.db"
SCHEMA_PATH = ROOT / "schema.sql"
CONFIG_PATH = ROOT / "config.json"
BACKUP_DIR = ROOT / "backups"
MAX_BACKUPS = 30

# Static files are served WITHOUT authentication (the desktop client must be able
# to load its own shell before anyone can log in), so this is an explicit
# allowlist rather than "anything under ROOT" — otherwise warehouse.db, the
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


_config = load_config()
# host "127.0.0.1" — доступ только с этого компьютера;
# host "0.0.0.0" — доступ по локальной сети (см. setup_lan.bat).
HOST = str(_config.get("host", "127.0.0.1"))
PORT = int(_config.get("port", 8765))


def auto_backup() -> str | None:
    """Create a timestamped backup of the database file."""
    if not DB_PATH.exists():
        return None
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"warehouse_{stamp}.db"
    shutil.copy2(DB_PATH, dest)
    # Prune old backups
    backups = sorted(BACKUP_DIR.glob("warehouse_*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in backups[MAX_BACKUPS:]:
        old.unlink(missing_ok=True)
    return str(dest)


def pre_migration_backup() -> str | None:
    """Separate, clearly-labeled backup taken only when migrations are about to run."""
    if not DB_PATH.exists():
        return None
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"pre_migration_{stamp}.db"
    shutil.copy2(DB_PATH, dest)
    return str(dest)


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
    return connection


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    is_fresh_install = not DB_PATH.exists()
    with get_connection() as connection:
        connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        if not is_fresh_install and migrations.pending_migrations(connection):
            pre_migration_backup()
        migrations.run_migrations(connection)


def read_state_version(connection: sqlite3.Connection) -> int:
    row = connection.execute("SELECT value FROM app_meta WHERE key = 'state_version'").fetchone()
    try:
        return int(row["value"]) if row else 0
    except (TypeError, ValueError):
        return 0


def get_state_version() -> int:
    with get_connection() as connection:
        return read_state_version(connection)


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
            "SELECT id, name, category, inventory_number, serial_number, purchase_date, status, notes, quantity, repair_quantity, retired_quantity, min_quantity, warranty_end, price, repair_date, location, photo_url, rev FROM assets ORDER BY name"
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

    return {
        "meta": {"updatedAt": meta_row["value"] if meta_row else None, "version": version},
        "employees": employees,
        "departments": departments,
        "sites": sites,
        "assets": assets,
        "movements": movements,
        "auditLog": audit,
        "kitTemplates": kits,
    }


def import_state(payload: dict, actor: str) -> dict:
    employees = payload.get("employees", [])
    departments = payload.get("departments", [])
    sites = payload.get("sites", [])
    assets = payload.get("assets", [])
    movements = payload.get("movements", [])
    updated_at = (payload.get("meta") or {}).get("updatedAt")

    with get_connection() as connection:
        connection.execute("BEGIN")
        old_assets = {
            row["id"]: (
                row["name"], row["category"] or "", row["inventory_number"] or "",
                row["serial_number"] or "", row["location"] or "", row["purchase_date"] or "",
                row["warranty_end"] or "", row["rev"],
            )
            for row in connection.execute(
                "SELECT id, name, category, inventory_number, serial_number, location, "
                "purchase_date, warranty_end, rev FROM assets"
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
            connection.execute(
                """
                INSERT INTO assets (id, name, category, inventory_number, serial_number, purchase_date, status, notes, quantity, repair_quantity, retired_quantity, min_quantity, warranty_end, price, repair_date, location, photo_url, rev)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            self.send_json(export_state())
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
                        "state": export_state(),
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
            state = import_state(payload, actor=user["username"])
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

    def serve_static(self, raw_path: str) -> None:
        relative = "index.html" if raw_path in {"/", ""} else raw_path.lstrip("/")
        if relative not in STATIC_ALLOWLIST:
            # Not on the allowlist: always 404, never 403, so a probe can't tell
            # "exists but you may not have it" from "does not exist".
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        file_path = ROOT / relative
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
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), WarehouseHandler)
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
