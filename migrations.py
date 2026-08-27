from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import Callable

Migration = tuple[int, str, "Callable[[sqlite3.Connection], None]"]


def _add_column_if_missing(connection: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    existing = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}
    if column not in existing:
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def _migrate_001(c): _add_column_if_missing(c, "assets", "repair_quantity", "repair_quantity INTEGER NOT NULL DEFAULT 0")
def _migrate_002(c): _add_column_if_missing(c, "assets", "retired_quantity", "retired_quantity INTEGER NOT NULL DEFAULT 0")
def _migrate_003(c): _add_column_if_missing(c, "assets", "min_quantity", "min_quantity INTEGER NOT NULL DEFAULT 0")
def _migrate_004(c): _add_column_if_missing(c, "assets", "warranty_end", "warranty_end TEXT NOT NULL DEFAULT ''")
def _migrate_005(c): _add_column_if_missing(c, "assets", "price", "price REAL NOT NULL DEFAULT 0")
def _migrate_006(c): _add_column_if_missing(c, "assets", "repair_date", "repair_date TEXT NOT NULL DEFAULT ''")
def _migrate_007(c): _add_column_if_missing(c, "assets", "location", "location TEXT NOT NULL DEFAULT ''")
def _migrate_008(c): _add_column_if_missing(c, "assets", "photo_url", "photo_url TEXT NOT NULL DEFAULT ''")
def _migrate_009(c): _add_column_if_missing(c, "employees", "phone", "phone TEXT NOT NULL DEFAULT ''")
def _migrate_010(c): _add_column_if_missing(c, "employees", "site", "site TEXT NOT NULL DEFAULT ''")
def _migrate_011(c): _add_column_if_missing(c, "employees", "status", "status TEXT NOT NULL DEFAULT 'active'")
def _migrate_012(c): _add_column_if_missing(c, "movements", "act_number", "act_number INTEGER")
def _migrate_013(c): _add_column_if_missing(c, "movements", "department", "department TEXT NOT NULL DEFAULT ''")
def _migrate_014(c): _add_column_if_missing(c, "movements", "site", "site TEXT NOT NULL DEFAULT ''")


def _migrate_015_asset_allocations_rebuild(connection: sqlite3.Connection) -> None:
    # Check if table exists
    table_check = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='asset_allocations'"
    ).fetchone()
    if table_check is None:
        return

    alloc_info = list(connection.execute("PRAGMA table_info(asset_allocations)"))
    alloc_cols = {row["name"] for row in alloc_info}
    emp_col = next((row for row in alloc_info if row["name"] == "employee_id"), None)
    needs_migration = ("department" not in alloc_cols) or (emp_col is not None and emp_col["notnull"] == 1)
    if not needs_migration:
        return
    connection.execute("PRAGMA foreign_keys = OFF")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS asset_allocations_new (
            asset_id TEXT NOT NULL,
            employee_id TEXT,
            department TEXT NOT NULL DEFAULT '',
            quantity INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (asset_id) REFERENCES assets(id)
        );
        """
    )
    select_dept = "department" if "department" in alloc_cols else "''"
    connection.execute(
        f"INSERT INTO asset_allocations_new (asset_id, employee_id, department, quantity) "
        f"SELECT asset_id, employee_id, {select_dept}, quantity FROM asset_allocations"
    )
    connection.execute("DROP TABLE asset_allocations")
    connection.execute("ALTER TABLE asset_allocations_new RENAME TO asset_allocations")
    connection.execute("PRAGMA foreign_keys = ON")


def _migrate_016(connection: sqlite3.Connection) -> None:
    # Check if table exists
    table_check = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='asset_allocations'"
    ).fetchone()
    if table_check is None:
        return
    _add_column_if_missing(connection, "asset_allocations", "site", "site TEXT NOT NULL DEFAULT ''")


def _migrate_017_sites_table(c):
    c.execute("CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, name TEXT NOT NULL)")


def _migrate_018_audit_log_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            action TEXT NOT NULL,
            changes TEXT NOT NULL DEFAULT '{}',
            timestamp TEXT NOT NULL
        )
        """
    )


def _migrate_019_kit_templates_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS kit_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            items TEXT NOT NULL DEFAULT '[]'
        )
        """
    )


def _migrate_020_mobile_action_log_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS mobile_action_log (
            client_action_id TEXT PRIMARY KEY,
            response_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )


def _migrate_021_users_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            iterations INTEGER NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin','storekeeper','viewer')),
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        )
        """
    )


MIGRATIONS: list[Migration] = [
    (1, "assets.repair_quantity", _migrate_001),
    (2, "assets.retired_quantity", _migrate_002),
    (3, "assets.min_quantity", _migrate_003),
    (4, "assets.warranty_end", _migrate_004),
    (5, "assets.price", _migrate_005),
    (6, "assets.repair_date", _migrate_006),
    (7, "assets.location", _migrate_007),
    (8, "assets.photo_url", _migrate_008),
    (9, "employees.phone", _migrate_009),
    (10, "employees.site", _migrate_010),
    (11, "employees.status", _migrate_011),
    (12, "movements.act_number", _migrate_012),
    (13, "movements.department", _migrate_013),
    (14, "movements.site", _migrate_014),
    (15, "asset_allocations rebuild (department, nullable employee_id)", _migrate_015_asset_allocations_rebuild),
    (16, "asset_allocations.site", _migrate_016),
    (17, "sites table", _migrate_017_sites_table),
    (18, "audit_log table", _migrate_018_audit_log_table),
    (19, "kit_templates table", _migrate_019_kit_templates_table),
    (20, "mobile_action_log table", _migrate_020_mobile_action_log_table),
    (21, "users table", _migrate_021_users_table),
]


def current_version(connection: sqlite3.Connection) -> int:
    connection.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    row = connection.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
    return row["v"] or 0


def pending_migrations(connection: sqlite3.Connection) -> list[Migration]:
    applied = current_version(connection)
    return [m for m in MIGRATIONS if m[0] > applied]


def run_migrations(connection: sqlite3.Connection) -> list[int]:
    applied_versions: list[int] = []
    for version, _name, func in pending_migrations(connection):
        func(connection)
        connection.execute(
            "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
            (version, datetime.now(timezone.utc).isoformat()),
        )
        applied_versions.append(version)
    connection.commit()
    return applied_versions
