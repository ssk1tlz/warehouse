from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import Callable

Migration = tuple[int, str, "Callable[[sqlite3.Connection], None]"]

MIGRATIONS: list[Migration] = []


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
