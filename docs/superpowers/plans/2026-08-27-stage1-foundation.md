# Этап 1 дорожной карты: фундамент для массового запуска — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Версионные миграции БД, учётные записи/роли/токены, и HTTP+HMAC защита канала для мобильного LAN-трафика — без потери офлайн-очереди мобильного, дедупликации `mobile_action_log` или существующих данных.

**Architecture:** Два новых модуля (`migrations.py`, `auth.py`), тонкая обвязка в `server.py` (диспетчеризация + проверка роли/токена/подписи на каждом эндпойнте), обновления в `app.js` (логин/сетап/управление пользователями) и в `mobile/www/js/*` (токен вместо пароля, HMAC-подпись через Web Crypto).

**Tech Stack:** Python stdlib (`sqlite3`, `hashlib`, `hmac`, `secrets`, `http.server`), pytest; ванильный JS, `node --test`, Web Crypto API (`crypto.subtle`) в Capacitor WebView.

**Spec:** `docs/superpowers/specs/2026-08-27-stage1-foundation-design.md`

## Global Constraints

- Проект полностью бесплатный: никаких облачных API, платных библиотек, новых pip-зависимостей (весь код — Python stdlib + существующий JS без сборщика).
- Все новые `.py`-модули, которые импортирует `server.py`, должны быть добавлены в `datas` в `WarehouseApp_New.spec`, иначе PyInstaller-сборка их не найдёт (как сейчас `mobile_actions.py`).
- Не ломать: офлайн-очередь мобильного (`mobile/www/js/db.js`), дедупликацию `mobile_action_log`, существующие данные (миграции без потерь).
- Язык интерфейса и сообщений об ошибках — русский. Стиль кода — как в существующих файлах (см. `server.py`, `mobile_actions.py`, `mobile/www/js/qr.js`).
- `schema.sql` обновляется в том же коммите, где добавляется соответствующая миграция.
- Коммит по завершении каждой отдельно нумерованной задачи ниже (не сваливать несколько задач в один коммит).
- Десктоп-клиент (`warehouse_tray.py`) всегда обращается к серверу через `127.0.0.1`, даже когда сервер слушает `0.0.0.0` — это уже так, использовать как данность (loopback-исключение в задаче C опирается именно на это).
- Все ссылки вида `file.py:123-145` в этом плане указывают на номера строк в файле ДО начала этого плана (снимок, сделанный при написании плана). Каждая задача A5+/B5+/B6/C2 редактирует файл, уже изменённый предыдущими задачами — реальные номера строк к этому моменту сдвинутся. Ищите код по показанному фрагменту/имени функции, а не по номеру строки буквально; номер строки — это лишь ориентир, откуда примерно начинать искать.

---

## Задача A — версионные миграции схемы БД

### Task A1: Модуль `migrations.py` — трекинг версий схемы

**Files:**
- Create: `migrations.py`
- Test: `tests/test_migrations.py`
- Modify: `WarehouseApp_New.spec` (добавить `migrations.py` в `datas`)

**Interfaces:**
- Produces: `migrations.Migration = tuple[int, str, Callable[[sqlite3.Connection], None]]`, `migrations.MIGRATIONS: list[Migration]` (изначально пустой), `migrations.current_version(connection) -> int`, `migrations.pending_migrations(connection) -> list[Migration]`, `migrations.run_migrations(connection) -> list[int]`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_migrations.py
import sqlite3

import pytest

import migrations


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    yield connection
    connection.close()


def test_current_version_is_zero_on_fresh_connection(conn):
    assert migrations.current_version(conn) == 0


def test_pending_migrations_returns_everything_when_nothing_applied(conn, monkeypatch):
    monkeypatch.setattr(migrations, "MIGRATIONS", [(1, "a", lambda c: None), (2, "b", lambda c: None)])
    assert [m[0] for m in migrations.pending_migrations(conn)] == [1, 2]


def test_run_migrations_applies_pending_and_records_version(conn, monkeypatch):
    calls = []
    monkeypatch.setattr(migrations, "MIGRATIONS", [(1, "test", lambda c: calls.append(c))])
    applied = migrations.run_migrations(conn)
    assert applied == [1]
    assert len(calls) == 1
    assert migrations.current_version(conn) == 1


def test_run_migrations_is_idempotent(conn, monkeypatch):
    monkeypatch.setattr(migrations, "MIGRATIONS", [(1, "test", lambda c: None)])
    migrations.run_migrations(conn)
    assert migrations.run_migrations(conn) == []


def test_run_migrations_applies_only_versions_above_current(conn, monkeypatch):
    monkeypatch.setattr(migrations, "MIGRATIONS", [(1, "a", lambda c: None)])
    migrations.run_migrations(conn)
    monkeypatch.setattr(migrations, "MIGRATIONS", [(1, "a", lambda c: None), (2, "b", lambda c: None)])
    assert migrations.run_migrations(conn) == [2]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_migrations.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'migrations'`

- [ ] **Step 3: Implement `migrations.py`**

```python
# migrations.py
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_migrations.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Add `schema_version` to `schema.sql`**

Append to `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

- [ ] **Step 6: Register `migrations.py` with PyInstaller**

In `WarehouseApp_New.spec`, in the `datas=[...]` list, add `('migrations.py', '.'),` right after `('mobile_actions.py', '.'),`.

- [ ] **Step 7: Commit**

```bash
git add migrations.py tests/test_migrations.py schema.sql WarehouseApp_New.spec
git commit -m "Task A1: add migrations.py schema-version tracking"
```

---

### Task A2: Портировать миграции колонок (assets/employees/movements)

**Files:**
- Modify: `migrations.py`
- Modify: `tests/test_migrations.py`

**Interfaces:**
- Consumes: `migrations.MIGRATIONS`, `migrations.run_migrations`, `migrations.Migration` (Task A1).
- Produces: `migrations.MIGRATIONS` populated with versions 1–14; private helper `migrations._add_column_if_missing(connection, table, column, ddl)`.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_migrations.py`:

```python
LEGACY_SCHEMA = """
CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  department TEXT,
  position TEXT,
  email TEXT
);
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  inventory_number TEXT,
  serial_number TEXT,
  purchase_date TEXT,
  status TEXT NOT NULL DEFAULT 'in_stock',
  notes TEXT,
  quantity INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE movements (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  employee_id TEXT,
  quantity INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  notes TEXT
);
"""


@pytest.fixture
def legacy_conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(LEGACY_SCHEMA)
    connection.execute(
        "INSERT INTO assets (id, name, quantity) VALUES ('ast_1', 'Ноутбук', 5)"
    )
    connection.commit()
    yield connection
    connection.close()


@pytest.mark.parametrize("table,column", [
    ("assets", "repair_quantity"), ("assets", "retired_quantity"), ("assets", "min_quantity"),
    ("assets", "warranty_end"), ("assets", "price"), ("assets", "repair_date"),
    ("assets", "location"), ("assets", "photo_url"),
    ("employees", "phone"), ("employees", "site"), ("employees", "status"),
    ("movements", "act_number"), ("movements", "department"), ("movements", "site"),
])
def test_column_migrations_add_missing_columns(legacy_conn, table, column):
    migrations.run_migrations(legacy_conn)
    columns = {row["name"] for row in legacy_conn.execute(f"PRAGMA table_info({table})")}
    assert column in columns


def test_column_migrations_preserve_existing_rows(legacy_conn):
    migrations.run_migrations(legacy_conn)
    row = legacy_conn.execute("SELECT name, quantity, repair_quantity FROM assets WHERE id='ast_1'").fetchone()
    assert row["name"] == "Ноутбук"
    assert row["quantity"] == 5
    assert row["repair_quantity"] == 0


def test_column_migrations_are_noop_on_already_current_schema(legacy_conn):
    migrations.run_migrations(legacy_conn)
    applied_twice = migrations.run_migrations(legacy_conn)
    assert applied_twice == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_migrations.py -v -k column_migrations`
Expected: FAIL — columns not found (`MIGRATIONS` still empty from Task A1)

- [ ] **Step 3: Implement the column migrations**

Add to `migrations.py`, above `MIGRATIONS`:

```python
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
```

Replace `MIGRATIONS: list[Migration] = []` with:

```python
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
]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_migrations.py -v`
Expected: PASS (all tests, including Task A1's — they use `monkeypatch.setattr` so are unaffected by the now-populated `MIGRATIONS`)

- [ ] **Step 5: Commit**

```bash
git add migrations.py tests/test_migrations.py
git commit -m "Task A2: port asset/employee/movement column migrations"
```

---

### Task A3: Портировать пересборку `asset_allocations`

**Files:**
- Modify: `migrations.py`
- Modify: `tests/test_migrations.py`

**Interfaces:**
- Consumes: Task A1/A2 (`MIGRATIONS`, `_add_column_if_missing`).
- Produces: `MIGRATIONS` versions 15–16.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_migrations.py` (extend `LEGACY_SCHEMA` fixture with the old-shape allocations table):

```python
LEGACY_ALLOCATIONS_SCHEMA = LEGACY_SCHEMA + """
CREATE TABLE asset_allocations (
  asset_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);
"""


@pytest.fixture
def legacy_alloc_conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(LEGACY_ALLOCATIONS_SCHEMA)
    connection.execute("INSERT INTO assets (id, name, quantity) VALUES ('ast_1', 'Ноутбук', 5)")
    connection.execute("INSERT INTO employees (id, full_name) VALUES ('emp_1', 'Иванов')")
    connection.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, quantity) VALUES ('ast_1', 'emp_1', 2)"
    )
    connection.commit()
    yield connection
    connection.close()


def test_asset_allocations_migration_adds_department_and_nullable_employee(legacy_alloc_conn):
    migrations.run_migrations(legacy_alloc_conn)
    cols = {row["name"]: row for row in legacy_alloc_conn.execute("PRAGMA table_info(asset_allocations)")}
    assert "department" in cols
    assert "site" in cols
    assert cols["employee_id"]["notnull"] == 0


def test_asset_allocations_migration_preserves_existing_rows(legacy_alloc_conn):
    migrations.run_migrations(legacy_alloc_conn)
    row = legacy_alloc_conn.execute(
        "SELECT asset_id, employee_id, quantity FROM asset_allocations WHERE asset_id='ast_1'"
    ).fetchone()
    assert row["employee_id"] == "emp_1"
    assert row["quantity"] == 2


def test_asset_allocations_migration_allows_department_only_row_after(legacy_alloc_conn):
    migrations.run_migrations(legacy_alloc_conn)
    legacy_alloc_conn.execute(
        "INSERT INTO asset_allocations (asset_id, employee_id, department, site, quantity) "
        "VALUES ('ast_1', NULL, 'IT', '', 1)"
    )
    legacy_alloc_conn.commit()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_migrations.py -v -k asset_allocations`
Expected: FAIL — `department` not in columns (migration not implemented yet)

- [ ] **Step 3: Implement**

Add to `migrations.py`:

```python
def _migrate_015_asset_allocations_rebuild(connection: sqlite3.Connection) -> None:
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


def _migrate_016(c): _add_column_if_missing(c, "asset_allocations", "site", "site TEXT NOT NULL DEFAULT ''")
```

Append to `MIGRATIONS`:

```python
    (15, "asset_allocations rebuild (department, nullable employee_id)", _migrate_015_asset_allocations_rebuild),
    (16, "asset_allocations.site", _migrate_016),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_migrations.py -v`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add migrations.py tests/test_migrations.py
git commit -m "Task A3: port asset_allocations rebuild migration"
```

---

### Task A4: Портировать создание таблиц (sites/audit_log/kit_templates/mobile_action_log)

**Files:**
- Modify: `migrations.py`
- Modify: `tests/test_migrations.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_migrations.py`:

```python
@pytest.mark.parametrize("table", ["sites", "audit_log", "kit_templates", "mobile_action_log"])
def test_table_creation_migrations_create_expected_tables(legacy_alloc_conn, table):
    migrations.run_migrations(legacy_alloc_conn)
    row = legacy_alloc_conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    assert row is not None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_migrations.py -v -k table_creation`
Expected: FAIL — tables don't exist

- [ ] **Step 3: Implement**

Add to `migrations.py`:

```python
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
```

Append to `MIGRATIONS`:

```python
    (17, "sites table", _migrate_017_sites_table),
    (18, "audit_log table", _migrate_018_audit_log_table),
    (19, "kit_templates table", _migrate_019_kit_templates_table),
    (20, "mobile_action_log table", _migrate_020_mobile_action_log_table),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_migrations.py -v`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add migrations.py tests/test_migrations.py
git commit -m "Task A4: port table-creation migrations"
```

---

### Task A5: Подключить миграции в `server.py`, убрать ad-hoc код, тест эквивалентности схем

**Files:**
- Modify: `server.py:1-30` (import), `server.py:57-69` (добавить `pre_migration_backup`), `server.py:133-225` (`init_db`)
- Test: `tests/test_migrations.py`, `tests/test_server_migrations.py` (new)

**Interfaces:**
- Consumes: `migrations.pending_migrations`, `migrations.run_migrations` (Task A1-A4).
- Produces: `server.pre_migration_backup() -> str | None`, `server.init_db()` без ad-hoc ALTER-кода.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_server_migrations.py
import sqlite3
from pathlib import Path

import pytest

import migrations

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"


def _table_shapes(connection: sqlite3.Connection) -> dict:
    tables = [r["name"] for r in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
        "AND name != 'schema_version' ORDER BY name"
    )]
    shapes = {}
    for table in tables:
        columns = [(r["name"], r["type"], r["notnull"], r["dflt_value"])
                   for r in connection.execute(f"PRAGMA table_info({table})")]
        shapes[table] = columns
    return shapes


def test_migrations_are_a_noop_on_top_of_current_schema_sql():
    # schema.sql already mirrors the current head schema (every column/table
    # migrations 1-20 would add already exists there) — so running all
    # migrations on top of a schema.sql-only database must change nothing
    # structurally. This is a regression guard, not a TDD-red test: it
    # already passes today since migrations.py and schema.sql are both
    # complete as of Task A4. It's here so a future migration that breaks
    # this invariant fails loudly.
    before = sqlite3.connect(":memory:")
    before.row_factory = sqlite3.Row
    before.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))

    after = sqlite3.connect(":memory:")
    after.row_factory = sqlite3.Row
    after.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    migrations.run_migrations(after)

    assert _table_shapes(before) == _table_shapes(after)


def test_init_db_creates_pre_migration_backup_for_a_legacy_database(tmp_path, monkeypatch):
    db_path = tmp_path / "warehouse.db"
    backup_dir = tmp_path / "backups"
    legacy = sqlite3.connect(db_path)
    legacy.executescript(
        "CREATE TABLE employees (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);"
        "CREATE TABLE assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1);"
        "CREATE TABLE movements (id TEXT PRIMARY KEY, type TEXT NOT NULL, asset_id TEXT NOT NULL, "
        "quantity INTEGER NOT NULL DEFAULT 0, date TEXT NOT NULL);"
        "INSERT INTO assets (id, name, quantity) VALUES ('ast_1', 'Ноутбук', 3);"
    )
    legacy.commit()
    legacy.close()

    monkeypatch.setattr(server, "DB_PATH", db_path)
    monkeypatch.setattr(server, "BACKUP_DIR", backup_dir)
    server.init_db()

    assert list(backup_dir.glob("pre_migration_*.db")), "не создан бэкап перед миграцией"
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(assets)")}
    assert "repair_quantity" in columns
    row = conn.execute("SELECT name, quantity FROM assets WHERE id='ast_1'").fetchone()
    assert row["name"] == "Ноутбук"
    assert row["quantity"] == 3


def test_init_db_does_not_create_a_backup_for_a_brand_new_database(tmp_path, monkeypatch):
    db_path = tmp_path / "warehouse.db"
    backup_dir = tmp_path / "backups"
    monkeypatch.setattr(server, "DB_PATH", db_path)
    monkeypatch.setattr(server, "BACKUP_DIR", backup_dir)
    server.init_db()
    assert not backup_dir.exists() or not list(backup_dir.glob("pre_migration_*.db"))
```

Add `import server` to the top-level imports of this file, next to `import migrations`.

- [ ] **Step 2: Run tests to verify the integration ones fail**

Run: `python -m pytest tests/test_server_migrations.py -v`
Expected: `test_migrations_are_a_noop_on_top_of_current_schema_sql` PASSES immediately (it only exercises `migrations.py`/`schema.sql`, both already complete from Tasks A1-A4). `test_init_db_creates_pre_migration_backup_for_a_legacy_database` FAILS — no `pre_migration_*.db` file is created, because `server.py` doesn't call `migrations.run_migrations` or take a pre-migration backup yet (it still runs its own ad-hoc `ALTER TABLE` checks with no backup step). `test_init_db_does_not_create_a_backup_for_a_brand_new_database` passes trivially either way — that's fine, it exists to guard against a future regression, not to drive this step.

- [ ] **Step 3: Wire migrations into `server.py`**

Modify `server.py` — add near the top-level imports (after `import mobile_actions`):

```python
import migrations
```

Add a new function right after `auto_backup()` (server.py:57-69):

```python
def pre_migration_backup() -> str | None:
    """Separate, clearly-labeled backup taken only when migrations are about to run."""
    if not DB_PATH.exists():
        return None
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"pre_migration_{stamp}.db"
    shutil.copy2(DB_PATH, dest)
    return str(dest)
```

Replace the entire body of `init_db()` (server.py:133-225, from `def init_db()` through the closing of the `with get_connection() as connection:` block) with:

```python
def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_connection() as connection:
        connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        if migrations.pending_migrations(connection):
            pre_migration_backup()
        migrations.run_migrations(connection)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_server_migrations.py tests/test_migrations.py tests/test_mobile_actions.py -v`
Expected: PASS (all tests, including the backup test from Step 1 — `init_db()` now takes a `pre_migration_*.db` snapshot before running migrations on the legacy fixture; `test_mobile_actions.py` still passes because `schema.sql` already has every column it relies on)

- [ ] **Step 5: Manual verification against a real old database**

Copy a real old backup for a smoke test (do not commit the copy):

```bash
cp backups/warehouse_20260101_000000.db /tmp/old_test.db 2>/dev/null || echo "нет старого бэкапа — пропустить, тест из Step 1/4 уже покрывает эквивалентность схем"
python -c "
import sqlite3, migrations
conn = sqlite3.connect('/tmp/old_test.db')
conn.row_factory = sqlite3.Row
before = conn.execute('SELECT COUNT(*) AS n FROM assets').fetchone()['n']
migrations.run_migrations(conn)
after = conn.execute('SELECT COUNT(*) AS n FROM assets').fetchone()['n']
assert before == after, 'потеряны строки!'
print('OK, строк было/стало:', before, after)
"
```

Expected: `OK, строк было/стало: N N` (одинаковые числа) — если реального старого бэкапа под рукой нет, этот шаг пропускается без риска для приёмки, т.к. `test_init_db_creates_pre_migration_backup_for_a_legacy_database` и `test_migrations_are_a_noop_on_top_of_current_schema_sql` уже формально доказывают эквивалентность схем и отсутствие потери данных.

- [ ] **Step 6: Commit**

```bash
git add server.py tests/test_server_migrations.py
git commit -m "Task A5: wire migrations into init_db, remove ad-hoc ALTER code"
```

---

## Задача B — учётные записи, роли, токены

### Task B1: `auth.py` — хэширование паролей

**Files:**
- Create: `auth.py`
- Test: `tests/test_auth.py`
- Modify: `WarehouseApp_New.spec`

**Interfaces:**
- Produces: `auth.hash_password(password: str, *, iterations: int = 390_000) -> tuple[str, str, int]`, `auth.verify_password(password: str, password_hash: str, salt: str, iterations: int) -> bool`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_auth.py
import auth


def test_hash_password_returns_hash_salt_and_iterations():
    password_hash, salt, iterations = auth.hash_password("secret123")
    assert isinstance(password_hash, str) and len(password_hash) == 64  # sha256 hex digest
    assert isinstance(salt, str) and len(salt) == 32  # 16 bytes hex
    assert iterations > 0


def test_verify_password_accepts_correct_password():
    password_hash, salt, iterations = auth.hash_password("secret123")
    assert auth.verify_password("secret123", password_hash, salt, iterations) is True


def test_verify_password_rejects_wrong_password():
    password_hash, salt, iterations = auth.hash_password("secret123")
    assert auth.verify_password("wrong", password_hash, salt, iterations) is False


def test_hash_password_uses_distinct_salts():
    hash_a, salt_a, _ = auth.hash_password("secret123")
    hash_b, salt_b, _ = auth.hash_password("secret123")
    assert salt_a != salt_b
    assert hash_a != hash_b
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_auth.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'auth'`

- [ ] **Step 3: Implement**

```python
# auth.py
from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from datetime import datetime, timedelta, timezone

ROLES = ("admin", "storekeeper", "viewer")


def hash_password(password: str, *, iterations: int = 390_000) -> tuple[str, str, int]:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), iterations)
    return digest.hex(), salt, iterations


def verify_password(password: str, password_hash: str, salt: str, iterations: int) -> bool:
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), iterations)
    return hmac.compare_digest(digest.hex(), password_hash)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_auth.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Register `auth.py` with PyInstaller**

In `WarehouseApp_New.spec`, add `('auth.py', '.'),` to `datas=[...]` next to `('migrations.py', '.'),`.

- [ ] **Step 6: Commit**

```bash
git add auth.py tests/test_auth.py WarehouseApp_New.spec
git commit -m "Task B1: add auth.py password hashing (PBKDF2)"
```

---

### Task B2: Таблица `users` и CRUD

**Files:**
- Modify: `migrations.py` (migration 21), `schema.sql`, `auth.py`, `tests/test_auth.py`

**Interfaces:**
- Consumes: Task A (`migrations.MIGRATIONS`), Task B1 (`hash_password`).
- Produces: `auth.AuthError`, `auth.has_any_user(connection) -> bool`, `auth.create_user(connection, username, password, role) -> dict`, `auth.get_user_by_username(connection, username) -> sqlite3.Row | None`, `auth.get_user_by_id(connection, user_id) -> sqlite3.Row | None`, `auth.list_users(connection) -> list[dict]`, `auth.set_user_role(connection, user_id, role) -> None`, `auth.set_user_active(connection, user_id, is_active: bool) -> None`, `auth.set_user_password(connection, user_id, password) -> None`, `auth.authenticate_user(connection, username, password) -> sqlite3.Row | None`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_auth.py (add)
import sqlite3
from pathlib import Path

import pytest

import migrations

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    migrations.run_migrations(connection)
    yield connection
    connection.close()


def test_has_any_user_false_on_empty_table(conn):
    assert auth.has_any_user(conn) is False


def test_create_user_then_has_any_user_true(conn):
    auth.create_user(conn, "admin", "pass1234", "admin")
    assert auth.has_any_user(conn) is True


def test_create_user_rejects_unknown_role(conn):
    with pytest.raises(auth.AuthError):
        auth.create_user(conn, "bob", "pass1234", "superuser")


def test_create_user_rejects_duplicate_username(conn):
    auth.create_user(conn, "bob", "pass1234", "viewer")
    with pytest.raises(auth.AuthError):
        auth.create_user(conn, "bob", "other", "viewer")


def test_authenticate_user_succeeds_with_correct_password(conn):
    auth.create_user(conn, "bob", "pass1234", "storekeeper")
    user = auth.authenticate_user(conn, "bob", "pass1234")
    assert user is not None
    assert user["role"] == "storekeeper"


def test_authenticate_user_fails_with_wrong_password(conn):
    auth.create_user(conn, "bob", "pass1234", "storekeeper")
    assert auth.authenticate_user(conn, "bob", "wrong") is None


def test_authenticate_user_fails_for_deactivated_user(conn):
    user = auth.create_user(conn, "bob", "pass1234", "storekeeper")
    auth.set_user_active(conn, user["id"], False)
    assert auth.authenticate_user(conn, "bob", "pass1234") is None


def test_set_user_role_changes_role(conn):
    user = auth.create_user(conn, "bob", "pass1234", "viewer")
    auth.set_user_role(conn, user["id"], "admin")
    assert auth.get_user_by_id(conn, user["id"])["role"] == "admin"


def test_list_users_excludes_password_fields(conn):
    auth.create_user(conn, "bob", "pass1234", "viewer")
    users = auth.list_users(conn)
    assert users == [{"id": users[0]["id"], "username": "bob", "role": "viewer",
                       "isActive": True, "createdAt": users[0]["createdAt"]}]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_auth.py -v -k "user"`
Expected: FAIL — `no such table: users` / `AttributeError: module 'auth' has no attribute 'create_user'`

- [ ] **Step 3: Add the `users` migration**

Add to `migrations.py`:

```python
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
```

Append to `MIGRATIONS`: `(21, "users table", _migrate_021_users_table),`

Append to `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','storekeeper','viewer')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
```

- [ ] **Step 4: Implement the user functions in `auth.py`**

Add:

```python
class AuthError(Exception):
    """User-facing auth failure: duplicate username, unknown role, etc."""


def _generate_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def has_any_user(connection) -> bool:
    return connection.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None


def create_user(connection, username: str, password: str, role: str) -> dict:
    if role not in ROLES:
        raise AuthError(f"Неизвестная роль: {role}")
    username = (username or "").strip()
    if not username:
        raise AuthError("Логин не может быть пустым.")
    if connection.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        raise AuthError(f"Пользователь «{username}» уже существует.")
    password_hash, salt, iterations = hash_password(password)
    user_id = _generate_id("usr")
    created_at = datetime.now(timezone.utc).isoformat()
    connection.execute(
        "INSERT INTO users (id, username, password_hash, salt, iterations, role, is_active, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
        (user_id, username, password_hash, salt, iterations, role, created_at),
    )
    connection.commit()
    return {"id": user_id, "username": username, "role": role, "isActive": True, "createdAt": created_at}


def get_user_by_username(connection, username: str):
    return connection.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()


def get_user_by_id(connection, user_id: str):
    return connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def list_users(connection) -> list[dict]:
    rows = connection.execute(
        "SELECT id, username, role, is_active, created_at FROM users ORDER BY username"
    ).fetchall()
    return [
        {"id": r["id"], "username": r["username"], "role": r["role"],
         "isActive": bool(r["is_active"]), "createdAt": r["created_at"]}
        for r in rows
    ]


def set_user_role(connection, user_id: str, role: str) -> None:
    if role not in ROLES:
        raise AuthError(f"Неизвестная роль: {role}")
    connection.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
    connection.commit()


def set_user_active(connection, user_id: str, is_active: bool) -> None:
    connection.execute("UPDATE users SET is_active = ? WHERE id = ?", (1 if is_active else 0, user_id))
    if not is_active:
        connection.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    connection.commit()


def set_user_password(connection, user_id: str, password: str) -> None:
    password_hash, salt, iterations = hash_password(password)
    connection.execute(
        "UPDATE users SET password_hash = ?, salt = ?, iterations = ? WHERE id = ?",
        (password_hash, salt, iterations, user_id),
    )
    connection.commit()


def authenticate_user(connection, username: str, password: str):
    user = get_user_by_username(connection, username)
    if user is None or not user["is_active"]:
        return None
    if not verify_password(password, user["password_hash"], user["salt"], user["iterations"]):
        return None
    return user
```

> Note: `set_user_active` references the `sessions` table, which doesn't exist until Task B3. That's fine — this `DELETE` only ever executes when `is_active=False` is passed, and no test in this task calls it with `False` after Task B3 exists... actually `test_authenticate_user_fails_for_deactivated_user` DOES call `set_user_active(conn, user["id"], False)` in Step 1 above, which WILL hit `DELETE FROM sessions` before that table exists. Fix: guard the delete.

- [ ] **Step 3b: Guard the sessions delete until Task B3 adds the table**

In `set_user_active`, replace the unconditional delete with a guarded one:

```python
def set_user_active(connection, user_id: str, is_active: bool) -> None:
    connection.execute("UPDATE users SET is_active = ? WHERE id = ?", (1 if is_active else 0, user_id))
    if not is_active:
        table_exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'"
        ).fetchone()
        if table_exists:
            connection.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    connection.commit()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_auth.py -v`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add migrations.py schema.sql auth.py tests/test_auth.py
git commit -m "Task B2: add users table and CRUD in auth.py"
```

---

### Task B3: Таблица `sessions` и токены

**Files:**
- Modify: `migrations.py` (migration 22), `schema.sql`, `auth.py`, `tests/test_auth.py`

**Interfaces:**
- Consumes: Task B2 (`users` table, `create_user`, `set_user_active`).
- Produces: `auth.SESSION_LIFETIME_DAYS`, `auth.create_session(connection, user_id, *, device_secret=None) -> dict`, `auth.validate_token(connection, token) -> sqlite3.Row | None`, `auth.revoke_token(connection, token) -> None`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_auth.py (add)
def test_create_session_returns_token_and_expiry(conn):
    user = auth.create_user(conn, "bob", "pass1234", "storekeeper")
    session = auth.create_session(conn, user["id"])
    assert session["token"]
    assert session["expiresAt"]


def test_validate_token_returns_user_row_for_valid_token(conn):
    user = auth.create_user(conn, "bob", "pass1234", "storekeeper")
    session = auth.create_session(conn, user["id"])
    row = auth.validate_token(conn, session["token"])
    assert row is not None
    assert row["username"] == "bob"
    assert row["role"] == "storekeeper"


def test_validate_token_returns_none_for_unknown_token(conn):
    assert auth.validate_token(conn, "not-a-real-token") is None


def test_validate_token_returns_none_for_expired_token(conn, monkeypatch):
    import datetime as dt
    user = auth.create_user(conn, "bob", "pass1234", "storekeeper")
    session = auth.create_session(conn, user["id"])
    far_future = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=auth.SESSION_LIFETIME_DAYS + 1)

    class FrozenDatetime(dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return far_future

    monkeypatch.setattr(auth, "datetime", FrozenDatetime)
    assert auth.validate_token(conn, session["token"]) is None


def test_validate_token_returns_none_for_deactivated_user(conn):
    user = auth.create_user(conn, "bob", "pass1234", "storekeeper")
    session = auth.create_session(conn, user["id"])
    auth.set_user_active(conn, user["id"], False)
    assert auth.validate_token(conn, session["token"]) is None


def test_revoke_token_invalidates_it(conn):
    user = auth.create_user(conn, "bob", "pass1234", "storekeeper")
    session = auth.create_session(conn, user["id"])
    auth.revoke_token(conn, session["token"])
    assert auth.validate_token(conn, session["token"]) is None


def test_create_session_stores_device_secret(conn):
    user = auth.create_user(conn, "bob", "pass1234", "storekeeper")
    session = auth.create_session(conn, user["id"], device_secret="abc123")
    row = auth.validate_token(conn, session["token"])
    assert row["device_secret"] == "abc123"


def test_create_session_device_secret_defaults_to_none(conn):
    user = auth.create_user(conn, "bob", "pass1234", "storekeeper")
    session = auth.create_session(conn, user["id"])
    row = auth.validate_token(conn, session["token"])
    assert row["device_secret"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_auth.py -v -k session_or_token`
Expected: FAIL — `no such table: sessions` / `AttributeError`

- [ ] **Step 3: Add the `sessions` migration**

Add to `migrations.py`:

```python
def _migrate_022_sessions_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id),
            device_secret TEXT,
            created_at TEXT NOT NULL,
            last_used_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )
        """
    )
```

Append to `MIGRATIONS`: `(22, "sessions table", _migrate_022_sessions_table),`

Append to `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_secret TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
```

- [ ] **Step 4: Implement session functions in `auth.py`**

Add:

```python
SESSION_LIFETIME_DAYS = 90


def create_session(connection, user_id: str, *, device_secret: str | None = None) -> dict:
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=SESSION_LIFETIME_DAYS)
    connection.execute(
        "INSERT INTO sessions (token, user_id, device_secret, created_at, last_used_at, expires_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (token, user_id, device_secret, now.isoformat(), now.isoformat(), expires_at.isoformat()),
    )
    connection.commit()
    return {"token": token, "expiresAt": expires_at.isoformat()}


def validate_token(connection, token: str):
    if not token:
        return None
    row = connection.execute(
        """
        SELECT sessions.token AS token, sessions.user_id AS user_id, sessions.device_secret AS device_secret,
               sessions.expires_at AS expires_at, users.username AS username, users.role AS role,
               users.is_active AS is_active
        FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token = ?
        """,
        (token,),
    ).fetchone()
    if row is None or not row["is_active"]:
        return None
    now = datetime.now(timezone.utc)
    if datetime.fromisoformat(row["expires_at"]) < now:
        return None
    new_expiry = now + timedelta(days=SESSION_LIFETIME_DAYS)
    connection.execute(
        "UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token = ?",
        (now.isoformat(), new_expiry.isoformat(), token),
    )
    connection.commit()
    return row


def revoke_token(connection, token: str) -> None:
    connection.execute("DELETE FROM sessions WHERE token = ?", (token,))
    connection.commit()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_auth.py -v`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add migrations.py schema.sql auth.py tests/test_auth.py
git commit -m "Task B3: add sessions table and token lifecycle in auth.py"
```

---

### Task B4: Таблица `pairing_codes` и обмен QR-кода на токен

**Files:**
- Modify: `migrations.py` (migration 23), `schema.sql`, `auth.py`, `tests/test_auth.py`

**Interfaces:**
- Consumes: Task B2 (`get_user_by_id`), Task B3 (`create_session`).
- Produces: `auth.PAIRING_CODE_LIFETIME_MINUTES`, `auth.PairingError`, `auth.generate_pairing_code(connection, user_id) -> dict`, `auth.redeem_pairing_code(connection, code) -> dict`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_auth.py (add)
def test_generate_pairing_code_returns_code_secret_and_expiry(conn):
    user = auth.create_user(conn, "bob", "pass1234", "storekeeper")
    pairing = auth.generate_pairing_code(conn, user["id"])
    assert pairing["code"]
    assert pairing["secret"]
    assert pairing["expiresAt"]


def test_redeem_pairing_code_returns_token_for_the_right_user(conn):
    user = auth.create_user(conn, "bob", "pass1234", "storekeeper")
    pairing = auth.generate_pairing_code(conn, user["id"])
    result = auth.redeem_pairing_code(conn, pairing["code"])
    assert result["username"] == "bob"
    assert result["role"] == "storekeeper"
    assert result["token"]


def test_redeem_pairing_code_session_carries_the_device_secret(conn):
    user = auth.create_user(conn, "bob", "pass1234", "storekeeper")
    pairing = auth.generate_pairing_code(conn, user["id"])
    result = auth.redeem_pairing_code(conn, pairing["code"])
    row = auth.validate_token(conn, result["token"])
    assert row["device_secret"] == pairing["secret"]


def test_redeem_pairing_code_rejects_unknown_code(conn):
    with pytest.raises(auth.PairingError):
        auth.redeem_pairing_code(conn, "not-a-real-code")


def test_redeem_pairing_code_rejects_reuse(conn):
    user = auth.create_user(conn, "bob", "pass1234", "storekeeper")
    pairing = auth.generate_pairing_code(conn, user["id"])
    auth.redeem_pairing_code(conn, pairing["code"])
    with pytest.raises(auth.PairingError):
        auth.redeem_pairing_code(conn, pairing["code"])


def test_redeem_pairing_code_rejects_expired_code(conn, monkeypatch):
    import datetime as dt
    user = auth.create_user(conn, "bob", "pass1234", "storekeeper")
    pairing = auth.generate_pairing_code(conn, user["id"])
    far_future = dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=auth.PAIRING_CODE_LIFETIME_MINUTES + 1)

    class FrozenDatetime(dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return far_future

    monkeypatch.setattr(auth, "datetime", FrozenDatetime)
    with pytest.raises(auth.PairingError):
        auth.redeem_pairing_code(conn, pairing["code"])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_auth.py -v -k pairing`
Expected: FAIL — `no such table: pairing_codes` / `AttributeError`

- [ ] **Step 3: Add the `pairing_codes` migration**

Add to `migrations.py`:

```python
def _migrate_023_pairing_codes_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS pairing_codes (
            code TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id),
            device_secret TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            used_at TEXT
        )
        """
    )
```

Append to `MIGRATIONS`: `(23, "pairing_codes table", _migrate_023_pairing_codes_table),`

Append to `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
```

- [ ] **Step 4: Implement pairing functions in `auth.py`**

Add:

```python
PAIRING_CODE_LIFETIME_MINUTES = 10


class PairingError(Exception):
    """Raised when a pairing code is invalid, expired, or already used."""


def generate_pairing_code(connection, user_id: str) -> dict:
    code = secrets.token_urlsafe(16)
    device_secret = secrets.token_hex(32)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=PAIRING_CODE_LIFETIME_MINUTES)
    connection.execute(
        "INSERT INTO pairing_codes (code, user_id, device_secret, created_at, expires_at, used_at) "
        "VALUES (?, ?, ?, ?, ?, NULL)",
        (code, user_id, device_secret, now.isoformat(), expires_at.isoformat()),
    )
    connection.commit()
    return {"code": code, "secret": device_secret, "expiresAt": expires_at.isoformat()}


def redeem_pairing_code(connection, code: str) -> dict:
    row = connection.execute(
        "SELECT user_id, device_secret, expires_at, used_at FROM pairing_codes WHERE code = ?",
        (code,),
    ).fetchone()
    if row is None:
        raise PairingError("Код сопряжения не найден.")
    if row["used_at"] is not None:
        raise PairingError("Код сопряжения уже использован.")
    if datetime.fromisoformat(row["expires_at"]) < datetime.now(timezone.utc):
        raise PairingError("Код сопряжения истёк — сгенерируйте новый QR.")
    connection.execute(
        "UPDATE pairing_codes SET used_at = ? WHERE code = ?",
        (datetime.now(timezone.utc).isoformat(), code),
    )
    session = create_session(connection, row["user_id"], device_secret=row["device_secret"])
    user = get_user_by_id(connection, row["user_id"])
    connection.commit()
    return {"token": session["token"], "expiresAt": session["expiresAt"],
             "role": user["role"], "username": user["username"]}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_auth.py -v`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add migrations.py schema.sql auth.py tests/test_auth.py
git commit -m "Task B4: add pairing_codes table and QR pairing exchange"
```

---

### Task B5: `audit_log.actor` — кто сделал изменение

**Files:**
- Modify: `migrations.py` (migration 24), `schema.sql`, `server.py` (`import_state`, `export_state`, POST `/api/state` call site)
- Test: `tests/test_server_audit.py` (new)

**Interfaces:**
- Consumes: Task A (audit_log уже существует).
- Produces: `server.import_state(payload: dict, actor: str) -> dict` (сигнатура меняется — было `import_state(payload)`); `export_state()` включает `"actor"` в каждую запись `auditLog`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_server_audit.py
import sqlite3
from pathlib import Path

import pytest

import migrations
import server

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"


@pytest.fixture
def db(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setattr(server, "DB_PATH", db_path)
    server.init_db()
    yield db_path


def test_import_state_records_actor_on_new_audit_entries(db):
    payload = {
        "meta": {"updatedAt": "2026-08-27T00:00:00Z"},
        "employees": [], "departments": [], "sites": [], "assets": [], "movements": [],
        "auditLog": [{"entityType": "asset", "entityId": "ast_1", "action": "create", "changes": {}}],
        "kitTemplates": [],
    }
    server.import_state(payload, actor="bob")
    state = server.export_state()
    assert state["auditLog"][0]["actor"] == "bob"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_server_audit.py -v`
Expected: FAIL — `TypeError: import_state() missing 1 required positional argument: 'actor'` (once the signature is not yet changed, it's actually the opposite: currently `import_state(payload)` takes only one arg, so calling with `actor="bob"` fails with `TypeError: import_state() got an unexpected keyword argument 'actor'`)

- [ ] **Step 3: Add the `audit_log.actor` migration**

Add to `migrations.py`:

```python
def _migrate_024_audit_log_actor(c):
    _add_column_if_missing(c, "audit_log", "actor", "actor TEXT NOT NULL DEFAULT ''")
```

Append to `MIGRATIONS`: `(24, "audit_log.actor", _migrate_024_audit_log_actor),`

Modify `schema.sql`'s `audit_log` table definition to add the column:

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL DEFAULT '',
  timestamp TEXT NOT NULL
);
```

- [ ] **Step 4: Update `server.py`**

In `export_state()` (server.py:296-302), change the audit query to include `actor`:

```python
        audit = []
        for row in connection.execute(
            "SELECT id, entity_type AS entityType, entity_id AS entityId, action, changes, actor, timestamp "
            "FROM audit_log ORDER BY id DESC LIMIT 200"
        ):
            entry = dict(row)
            entry["changes"] = json.loads(entry["changes"] or "{}")
            audit.append(entry)
```

Change `import_state`'s signature (server.py:320) from `def import_state(payload: dict) -> dict:` to:

```python
def import_state(payload: dict, actor: str) -> dict:
```

In the same function, update the audit-log insert (server.py:417-423):

```python
        for entry in payload.get("auditLog", []):
            if not entry.get("id"):  # only new entries (without numeric id)
                connection.execute(
                    "INSERT INTO audit_log (entity_type, entity_id, action, changes, actor, timestamp) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (entry.get("entityType", ""), entry.get("entityId", ""), entry.get("action", ""),
                     json.dumps(entry.get("changes", {}), ensure_ascii=False), actor, entry.get("timestamp", "")),
                )
```

Update the call site in `do_POST` (server.py:528) — this line will be revisited fully in Task B6, but update it now so the test suite stays green:

```python
            state = import_state(payload, actor="")
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_server_audit.py tests/test_server_migrations.py tests/test_mobile_actions.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add migrations.py schema.sql server.py tests/test_server_audit.py
git commit -m "Task B5: record which user made each audit_log change"
```

---

### Task B6: Эндпойнты аутентификации, ролей и сопряжения в `server.py`

Это самая крупная задача этапа — весь HTTP-слой аутентификации в одном согласованном изменении (нельзя половину эндпойнтов оставить незащищённой между шагами).

**Files:**
- Modify: `server.py` (`do_GET`, `do_POST`, добавить `do_PATCH`, новые handler-методы)
- Test: `tests/test_server_auth.py` (new)

**Interfaces:**
- Consumes: `auth.validate_token`, `auth.role_allows` (новое), `auth.authenticate_user`, `auth.create_session`, `auth.create_user`, `auth.has_any_user`, `auth.list_users`, `auth.set_user_role`, `auth.set_user_active`, `auth.set_user_password`, `auth.generate_pairing_code`, `auth.redeem_pairing_code`, `auth.get_user_by_id`, `auth.AuthError`, `auth.PairingError`.
- Produces: `auth.role_allows(role, allowed) -> bool`; `server.WarehouseHandler.read_body() -> bytes`, `.authenticate() -> sqlite3.Row | None`, `.require_role(user, allowed) -> bool`; новые эндпойнты (см. таблицу в спеке).

- [ ] **Step 1: Add `role_allows` to `auth.py` with a test**

```python
# tests/test_auth.py (add)
def test_role_allows_true_when_role_in_allowed_list():
    assert auth.role_allows("admin", ("admin", "storekeeper")) is True


def test_role_allows_false_when_role_not_in_allowed_list():
    assert auth.role_allows("viewer", ("admin", "storekeeper")) is False
```

Run: `python -m pytest tests/test_auth.py -v -k role_allows` → FAIL (`AttributeError`)

Implement in `auth.py`:

```python
def role_allows(role: str, allowed: tuple[str, ...]) -> bool:
    return role in allowed
```

Run again → PASS.

- [ ] **Step 2: Write the failing HTTP integration tests**

```python
# tests/test_server_auth.py
import json
import sqlite3
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

import server


@pytest.fixture
def live_server(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(server, "BACKUP_DIR", tmp_path / "backups")
    server.init_db()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.WarehouseHandler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    httpd.shutdown()
    thread.join()


def _request(base_url, method, path, token=None, json_body=None):
    data = json.dumps(json_body).encode("utf-8") if json_body is not None else None
    req = urllib.request.Request(f"{base_url}{path}", data=data, method=method)
    if json_body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def _create_admin(base_url):
    status, body = _request(base_url, "POST", "/api/setup", json_body={"username": "admin", "password": "adminpass"})
    assert status == 200, body
    return body["token"]


def test_setup_status_true_before_any_user_exists(live_server):
    status, body = _request(live_server, "GET", "/api/setup-status")
    assert status == 200
    assert body == {"needsSetup": True}


def test_setup_creates_first_admin_and_returns_token(live_server):
    token = _create_admin(live_server)
    assert token
    status, body = _request(live_server, "GET", "/api/setup-status")
    assert body == {"needsSetup": False}


def test_setup_rejects_second_call_once_a_user_exists(live_server):
    _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/setup", json_body={"username": "x", "password": "y"})
    assert status == 409


def test_login_succeeds_with_correct_credentials(live_server):
    _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/login", json_body={"username": "admin", "password": "adminpass"})
    assert status == 200
    assert body["role"] == "admin"


def test_login_fails_with_wrong_password(live_server):
    _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/login", json_body={"username": "admin", "password": "wrong"})
    assert status == 401


def test_state_requires_authentication(live_server):
    _create_admin(live_server)
    status, body = _request(live_server, "GET", "/api/state")
    assert status == 401


def test_static_files_are_served_without_authentication(live_server):
    req = urllib.request.Request(f"{live_server}/index.html", method="GET")
    with urllib.request.urlopen(req) as response:
        assert response.status == 200


def _seed_asset(live_server_db_path):
    conn = sqlite3.connect(live_server_db_path)
    conn.execute(
        "INSERT INTO assets (id, name, quantity) VALUES ('ast_1', 'Ноутбук', 5)"
    )
    conn.commit()
    conn.close()


@pytest.mark.parametrize("role,expected_status", [("admin", 200), ("storekeeper", 200), ("viewer", 403)])
def test_mobile_action_role_matrix(live_server, role, expected_status):
    # "edit" is used here (not "purchase" — mobile_actions._DISPATCH has no such
    # type; mobile can only issue/return/repair/repair_return/retire/edit an
    # EXISTING asset, never create one) and requires a pre-existing asset row.
    _seed_asset(server.DB_PATH)
    admin_token = _create_admin(live_server)
    if role == "admin":
        token = admin_token
    else:
        status, body = _request(live_server, "POST", "/api/users", token=admin_token,
                                 json_body={"username": role, "password": "pass1234", "role": role})
        assert status == 200, body
        status, body = _request(live_server, "POST", "/api/login", json_body={"username": role, "password": "pass1234"})
        token = body["token"]
    status, body = _request(live_server, "POST", "/api/mobile/action", token=token,
                             json_body={"clientActionId": "x", "type": "edit", "assetId": "ast_1", "name": "Ноутбук новый"})
    assert status == expected_status, body


def test_viewer_can_read_state(live_server):
    admin_token = _create_admin(live_server)
    _request(live_server, "POST", "/api/users", token=admin_token,
             json_body={"username": "v", "password": "pass1234", "role": "viewer"})
    _, body = _request(live_server, "POST", "/api/login", json_body={"username": "v", "password": "pass1234"})
    status, _ = _request(live_server, "GET", "/api/state", token=body["token"])
    assert status == 200


def test_users_endpoint_is_admin_only(live_server):
    admin_token = _create_admin(live_server)
    _request(live_server, "POST", "/api/users", token=admin_token,
             json_body={"username": "v", "password": "pass1234", "role": "viewer"})
    _, body = _request(live_server, "POST", "/api/login", json_body={"username": "v", "password": "pass1234"})
    status, _ = _request(live_server, "GET", "/api/users", token=body["token"])
    assert status == 403


def test_logout_revokes_token(live_server):
    token = _create_admin(live_server)
    status, _ = _request(live_server, "POST", "/api/logout", token=token)
    assert status == 200
    status, _ = _request(live_server, "GET", "/api/state", token=token)
    assert status == 401


def test_patch_user_deactivate_then_login_fails(live_server):
    admin_token = _create_admin(live_server)
    _, created = _request(live_server, "POST", "/api/users", token=admin_token,
                           json_body={"username": "v", "password": "pass1234", "role": "viewer"})
    status, _ = _request(live_server, "PATCH", f"/api/users/{created['id']}", token=admin_token,
                          json_body={"isActive": False})
    assert status == 200
    status, _ = _request(live_server, "POST", "/api/login", json_body={"username": "v", "password": "pass1234"})
    assert status == 401


def test_pairing_generate_requires_admin(live_server):
    admin_token = _create_admin(live_server)
    _, created = _request(live_server, "POST", "/api/users", token=admin_token,
                           json_body={"username": "v", "password": "pass1234", "role": "viewer"})
    _, viewer_login = _request(live_server, "POST", "/api/login", json_body={"username": "v", "password": "pass1234"})
    status, _ = _request(live_server, "POST", "/api/pair/generate", token=viewer_login["token"],
                          json_body={"userId": created["id"]})
    assert status == 403


def test_pairing_full_flow(live_server):
    admin_token = _create_admin(live_server)
    _, created = _request(live_server, "POST", "/api/users", token=admin_token,
                           json_body={"username": "v", "password": "pass1234", "role": "viewer"})
    status, pairing = _request(live_server, "POST", "/api/pair/generate", token=admin_token,
                                json_body={"userId": created["id"]})
    assert status == 200
    status, result = _request(live_server, "POST", "/api/pair", json_body={"code": pairing["code"]})
    assert status == 200
    assert result["username"] == "v"
    status, _ = _request(live_server, "GET", "/api/state", token=result["token"])
    assert status == 200


def test_pairing_redeem_rejects_unknown_code(live_server):
    _create_admin(live_server)
    status, _ = _request(live_server, "POST", "/api/pair", json_body={"code": "bogus"})
    assert status == 400


def test_lan_info_does_not_include_a_password_field(live_server):
    token = _create_admin(live_server)
    status, body = _request(live_server, "GET", "/api/lan-info", token=token)
    assert status == 200
    assert "password" not in body
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `python -m pytest tests/test_server_auth.py -v`
Expected: FAIL — none of the new endpoints exist yet (404s / connection errors)

- [ ] **Step 4: Implement the endpoint wiring**

Add near the top of `server.py`, after `import mobile_actions`:

```python
import auth
```

Add these helper methods to `WarehouseHandler` (place right after `check_auth` — which this step removes entirely, see below):

```python
    def read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0") or "0")
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
```

Delete the entire `check_auth` method (server.py:448-464 in the pre-Task-B6 file) — it's fully replaced by `authenticate()`/`require_role()`.

Replace `do_GET` (server.py:466-481) with:

```python
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
```

Replace `do_POST` (server.py:483-529) with:

```python
    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        body = self.read_body()
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
            if base_version is not None and base_version != get_state_version():
                conflict_body = json.dumps(
                    {"error": "Данные были изменены в другом окне. Состояние обновлено — повторите последнее действие.",
                     "state": export_state()},
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
```

Add a new `do_PATCH` method (place after `do_POST`):

```python
    def do_PATCH(self) -> None:
        parsed = urlparse(self.path)
        body = self.read_body()
        user = self.authenticate()
        if user is None:
            return
        if not self.require_role(user, ("admin",)):
            return
        if parsed.path.startswith("/api/users/"):
            self.handle_update_user(parsed.path[len("/api/users/"):], body)
            return
        self.send_error(HTTPStatus.NOT_FOUND)
```

Add the new handler methods (place after `do_PATCH`, before `handle_mobile_action`):

```python
    def handle_setup(self, body: bytes) -> None:
        with get_connection() as connection:
            if auth.has_any_user(connection):
                self.send_json_error(HTTPStatus.CONFLICT, "Администратор уже создан.")
                return
            try:
                payload = json.loads(body or b"{}")
            except json.JSONDecodeError as exc:
                self.send_json_error(HTTPStatus.BAD_REQUEST, f"invalid json: {exc}")
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
        with get_connection() as connection:
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
        code = str(payload.get("code") or "")
        with get_connection() as connection:
            try:
                result = auth.redeem_pairing_code(connection, code)
            except auth.PairingError as exc:
                self.send_json_error(HTTPStatus.BAD_REQUEST, str(exc))
                return
        self.send_json(result)
```

Now update `handle_mobile_action` (server.py:531-568) to take `body: bytes` instead of reading it itself — change its signature from `def handle_mobile_action(self) -> None:` to `def handle_mobile_action(self, body: bytes) -> None:`, and delete its first four lines (`length = int(...)` through the `except json.JSONDecodeError` block's `return`), replacing them with:

```python
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError as exc:
            self.send_json_error(HTTPStatus.BAD_REQUEST, f"invalid json: {exc}")
            return
```

Do the same for `handle_act_request` (server.py:570-618): change signature to `def handle_act_request(self, body: bytes) -> None:`, and replace its body-reading block (`length = int(...)` through the JSON-decode `except`) with:

```python
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
```

Finally, remove the now-unused `PASSWORD` global (server.py:54) and its startup warning in `main()` (server.py:677-679):

```python
# Delete this line entirely:
# PASSWORD = str(_config.get("password", ""))
```

In `main()`, replace:

```python
        if not PASSWORD:
            print("ВНИМАНИЕ: сетевой режим включён, но пароль не задан — любой в сети имеет доступ к базе.")
            print("Запустите setup_lan.bat заново, чтобы задать пароль.")
```

with:

```python
        with get_connection() as connection:
            if not auth.has_any_user(connection):
                print("ВНИМАНИЕ: пользователей ещё нет — при первом открытии приложения появится мастер создания администратора.")
```

- [ ] **Step 5: Update `setup_lan.bat` to drop the obsolete password prompt**

Replace lines 17-19 and 26 of `setup_lan.bat` (the `LAN_PASSWORD` prompt and its use in `config.json`) — remove the `set /p LAN_PASSWORD=...` prompt entirely and drop the `"password": "%LAN_PASSWORD%"` line from the generated `config.json` (keep only `"host"` and `"port"`). Update the `[3/3]` message to state that access is now controlled by user accounts created on first launch, not a shared password.

- [ ] **Step 6: Run tests to verify they pass**

Run: `python -m pytest tests/ -v`
Expected: PASS (all tests across `test_migrations.py`, `test_auth.py`, `test_server_migrations.py`, `test_server_audit.py`, `test_server_auth.py`, `test_mobile_actions.py`)

- [ ] **Step 7: Commit**

```bash
git add server.py setup_lan.bat tests/test_server_auth.py
git commit -m "Task B6: wire login/roles/pairing endpoints, remove shared-password auth"
```

---

### Task B7: Десктоп UI — вход, мастер создания admin, управление пользователями

**Files:**
- Modify: `index.html` (добавить оверлеи логина/сетапа и управления пользователями)
- Modify: `app.js` (`init`, `loadState`/`saveState` fetch-вызовы, `openLanQrModal`, `showLanQrBtn` handler, новые функции)

**Interfaces:**
- Consumes: Task B6 эндпойнты (`/api/setup-status`, `/api/setup`, `/api/login`, `/api/logout`, `/api/users`, `/api/pair/generate`).
- Produces: `apiFetch(path, options) -> Promise<Response>` (используется всеми будущими вызовами API вместо голого `fetch`).

Нет автоматизированного тестового стенда для `app.js` (в проекте нет JS-тестов для десктопа) — верификация ручная, шаги ниже описывают точную последовательность проверки.

- [ ] **Step 1: Add auth/setup overlay markup to `index.html`**

Insert right before the closing `</body>` tag (after the existing `lanQrOverlay` block, e.g. after line ~960):

```html
<div id="authOverlay" class="modal-overlay">
  <div class="operation-modal">
    <div class="modal-header">
      <h3 id="authOverlayTitle">Вход</h3>
    </div>
    <form id="authForm">
      <label>Логин<input type="text" id="authUsername" required autocomplete="username"></label>
      <label>Пароль<input type="password" id="authPassword" required autocomplete="current-password"></label>
      <p id="authError" class="muted hidden"></p>
      <button type="submit" id="authSubmitBtn">Войти</button>
    </form>
  </div>
</div>

<div id="usersOverlay" class="modal-overlay hidden">
  <div class="operation-modal wide">
    <div class="modal-header">
      <h3>Пользователи</h3>
      <button type="button" class="modal-close" id="closeUsersBtn">Закрыть</button>
    </div>
    <table class="data-table">
      <thead><tr><th>Логин</th><th>Роль</th><th>Активен</th><th></th></tr></thead>
      <tbody id="usersTableBody"></tbody>
    </table>
    <h4>Новый пользователь</h4>
    <form id="createUserForm">
      <input type="text" id="newUserUsername" placeholder="Логин" required>
      <input type="password" id="newUserPassword" placeholder="Пароль" required>
      <select id="newUserRole">
        <option value="admin">admin</option>
        <option value="storekeeper" selected>storekeeper</option>
        <option value="viewer">viewer</option>
      </select>
      <button type="submit">Создать</button>
    </form>
  </div>
</div>
```

Note: `#authOverlay` intentionally has no `hidden` class by default and no close button — it's shown/hidden purely by JS (`classList.add/remove('hidden')`), and it can't be dismissed without successfully authenticating.

- [ ] **Step 2: Repurpose the sidebar QR button to open Users management**

In `index.html`, change the `showLanQrBtn` label from `QR для телефона` to `Пользователи`. In `app.js:3386`, change:

```javascript
document.getElementById("showLanQrBtn")?.addEventListener("click", openLanQrModal);
```

to:

```javascript
document.getElementById("showLanQrBtn")?.addEventListener("click", openUsersModal);
```

- [ ] **Step 3: Add `apiFetch` and auth-flow functions to `app.js`**

Add near the top of `app.js`, after the `dom` object definition:

```javascript
async function apiFetch(path, options = {}) {
  const token = localStorage.getItem("authToken");
  const headers = Object.assign({}, options.headers, token ? { Authorization: `Bearer ${token}` } : {});
  const response = await fetch(path, Object.assign({}, options, { headers }));
  if (response.status === 401) {
    localStorage.removeItem("authToken");
    localStorage.removeItem("userRole");
    showAuthOverlay("login");
    throw new Error("Сессия истекла — войдите снова.");
  }
  return response;
}

function showAuthOverlay(mode) {
  const overlay = document.getElementById("authOverlay");
  document.getElementById("authOverlayTitle").textContent =
    mode === "setup" ? "Создание администратора" : "Вход";
  document.getElementById("authSubmitBtn").textContent = mode === "setup" ? "Создать" : "Войти";
  overlay.dataset.mode = mode;
  overlay.classList.remove("hidden");
}

function hideAuthOverlay() {
  document.getElementById("authOverlay").classList.add("hidden");
}

async function ensureAuthenticated() {
  const status = await fetch("/api/setup-status").then((r) => r.json()).catch(() => ({ needsSetup: false }));
  if (status.needsSetup) {
    showAuthOverlay("setup");
    return false;
  }
  if (!localStorage.getItem("authToken")) {
    showAuthOverlay("login");
    return false;
  }
  return true;
}

function bindAuthEvents() {
  document.getElementById("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const mode = document.getElementById("authOverlay").dataset.mode;
    const username = document.getElementById("authUsername").value.trim();
    const password = document.getElementById("authPassword").value;
    const path = mode === "setup" ? "/api/setup" : "/api/login";
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json().catch(() => ({}));
    const errorEl = document.getElementById("authError");
    if (!response.ok) {
      errorEl.textContent = data.error || "Не удалось войти.";
      errorEl.classList.remove("hidden");
      return;
    }
    errorEl.classList.add("hidden");
    localStorage.setItem("authToken", data.token);
    localStorage.setItem("userRole", data.role);
    hideAuthOverlay();
    document.getElementById("authForm").reset();
    await boot();
  });
}

function applyRoleVisibility() {
  const role = localStorage.getItem("userRole");
  document.querySelectorAll("[data-requires-role]").forEach((el) => {
    const allowed = el.dataset.requiresRole.split(",");
    el.classList.toggle("hidden", !allowed.includes(role));
  });
}
```

- [ ] **Step 4: Wire `ensureAuthenticated`/`boot` into `init()`**

Replace `init()` (app.js:4339-4355) with:

```javascript
async function init() {
  initTheme();
  bindEvents();
  bindAuthEvents();
  const ready = await ensureAuthenticated();
  if (!ready) return;
  await boot();
}

async function boot() {
  try {
    state = await loadState();
    rebuildLookupMaps();
  } catch (error) {
    console.error(error);
    showToast('Не удалось подключиться к серверу. Запускайте через start_server.bat.', 'error');
    state = createEmptyState();
    rebuildLookupMaps();
  }
  resetAssetForm();
  resetEmployeeForm();
  resetOperationForms();
  applyRoleVisibility();
  render();
}
```

- [ ] **Step 5: Route existing fetch calls through `apiFetch`**

In `loadState()` (app.js:258-262), change `fetch("/api/state")` to `apiFetch("/api/state")`.

In `saveState()` (app.js:264-270), change `fetch("/api/state", {...})` to `apiFetch("/api/state", {...})`.

Find the `/api/act` fetch call (around app.js:2951) and change `fetch("/api/act", {...})` to `apiFetch("/api/act", {...})`.

- [ ] **Step 6: Add users-management functions and wire `openLanQrModal` to a chosen user**

Replace `openLanQrModal` (app.js:3639-3662) with:

```javascript
async function openLanQrModal(userId) {
  const overlay = document.getElementById("lanQrOverlay");
  const body = document.getElementById("lanQrBody");
  overlay.classList.remove("hidden");
  body.innerHTML = `<p class="muted">Загрузка…</p>`;
  let info;
  try {
    const response = await apiFetch("/api/lan-info");
    info = await response.json();
  } catch {
    body.innerHTML = `<p class="muted">Не удалось получить данные с сервера.</p>`;
    return;
  }
  if (!info.lanMode || !info.lanIp) {
    body.innerHTML = `<p class="muted">Сетевой режим выключен — телефон не сможет подключиться.<br>Запустите <code>setup_lan.bat</code> от имени администратора, затем перезапустите приложение.</p>`;
    return;
  }
  let pairing;
  try {
    const pairResponse = await apiFetch("/api/pair/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    pairing = await pairResponse.json();
    if (!pairResponse.ok) throw new Error(pairing.error || "Не удалось сгенерировать код сопряжения.");
  } catch (error) {
    body.innerHTML = `<p class="muted">${error.message}</p>`;
    return;
  }
  const url = `http://${info.lanIp}:${info.port}`;
  const payload = `WHC1:${JSON.stringify({ url, code: pairing.code, secret: pairing.secret })}`;
  body.innerHTML = `
    <div class="lan-qr-code">${qrHtml(payload, 60)}</div>
    <p class="muted">Отсканируйте в приложении на телефоне (Настройки → «Сканировать QR сервера») в течение 10 минут.<br>Адрес: <code>${url}</code></p>
  `;
}

async function openUsersModal() {
  document.getElementById("usersOverlay").classList.remove("hidden");
  await renderUsersTable();
}

function closeUsersModal() {
  document.getElementById("usersOverlay").classList.add("hidden");
}

async function renderUsersTable() {
  const response = await apiFetch("/api/users");
  const data = await response.json();
  document.getElementById("usersTableBody").innerHTML = data.users.map((u) => `
    <tr data-user-id="${u.id}">
      <td>${u.username}</td>
      <td>${u.role}</td>
      <td>${u.isActive ? "да" : "нет"}</td>
      <td>
        <button type="button" data-action="toggle-active">${u.isActive ? "Деактивировать" : "Активировать"}</button>
        <button type="button" data-action="generate-qr">QR</button>
      </td>
    </tr>
  `).join("");
}

document.getElementById("usersTableBody")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const userId = btn.closest("tr").dataset.userId;
  if (btn.dataset.action === "toggle-active") {
    const isActive = btn.textContent.trim() === "Активировать";
    await apiFetch(`/api/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive }),
    });
    await renderUsersTable();
  }
  if (btn.dataset.action === "generate-qr") {
    document.getElementById("usersOverlay").classList.add("hidden");
    await openLanQrModal(userId);
  }
});

document.getElementById("createUserForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("newUserUsername").value.trim();
  const password = document.getElementById("newUserPassword").value;
  const role = document.getElementById("newUserRole").value;
  const response = await apiFetch("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, role }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    showToast(data.error || "Не удалось создать пользователя.", "error");
    return;
  }
  e.target.reset();
  await renderUsersTable();
});

document.getElementById("closeUsersBtn")?.addEventListener("click", closeUsersModal);
document.getElementById("usersOverlay")?.addEventListener("click", (e) => {
  if (e.target === document.getElementById("usersOverlay")) closeUsersModal();
});
```

This mirrors the existing `closeLanQrBtn`/`lanQrOverlay` pattern (app.js:3387-3388) rather than the operation-modal system's generic `[data-close-modal]` handler, which is wired only to `#modalOverlay` and wouldn't fire for a standalone overlay like `usersOverlay`.

Also give `#showLanQrBtn` a `data-requires-role="admin"` attribute in `index.html`, so only admins see it (viewers/storekeepers have no use for user management).

- [ ] **Step 7: Manual verification**

```bash
python server.py
```

1. Open `http://127.0.0.1:8765/` in a browser — should show the "Создание администратора" (setup) overlay, since `warehouse.db` in this checkout has no users yet.
2. Create an admin (e.g. `admin` / `adminpass123`) — overlay should close and the normal app should load.
3. Reload the page — should NOT show the overlay again (token in `localStorage`).
4. Open DevTools, run `localStorage.removeItem('authToken')`, reload — should show "Вход" (login), not the setup wizard (since a user already exists).
5. Log in — click "Пользователи" in the sidebar — create a `storekeeper` user — click "QR" on that row — a QR code should render referencing `{"url":...,"code":...,"secret":...}` (inspect via browser devtools if needed, don't need to actually scan it yet).
6. Log out is not yet wired to a button in this task (no explicit UI change requested for that beyond the API) — verify via DevTools console: `await apiFetch('/api/logout', {method:'POST'})` then reload — should show the login screen again.

Expected: all six checks behave as described. If step 1 doesn't show the setup wizard, check that `warehouse.db` was actually freshly migrated with no `users` rows (delete the test DB and retry, or check via `sqlite3 warehouse.db "select * from users"`).

- [ ] **Step 8: Commit**

```bash
git add index.html app.js
git commit -m "Task B7: add desktop login screen, setup wizard, and user management UI"
```

---

### Task B8: Мобильный клиент — токен вместо пароля

**Files:**
- Modify: `mobile/www/js/qr.js`, `mobile/tests/qr.test.js`
- Modify: `mobile/www/js/settings.js`, Create: `mobile/tests/settings.test.js`
- Modify: `mobile/www/js/sync.js`, Create: `mobile/tests/sync.test.js`
- Modify: `mobile/www/js/scanner.js`, `mobile/www/js/screens.js`

**Interfaces:**
- Produces: `parseConnectQr(text) -> {serverUrl, code, secret} | null` (было `{serverUrl, password}`); `Settings.get() -> Promise<{serverUrl, token, deviceSecret}>`, `Settings.set({serverUrl, token, deviceSecret}) -> Promise<void>`; `Sync.pair(serverUrl, code) -> Promise<{token, deviceSecret}>` (new).

- [ ] **Step 1: Update `qr.js` payload shape with failing tests first**

Replace the connect-QR tests in `mobile/tests/qr.test.js` (lines 27-51):

```javascript
test('extracts url, code and secret from a valid connect QR', () => {
  assert.deepEqual(
    parseConnectQr('WHC1:{"url":"http://192.168.0.115:8765","code":"abc","secret":"deadbeef"}'),
    { serverUrl: 'http://192.168.0.115:8765', code: 'abc', secret: 'deadbeef' }
  );
});

test('returns null for a connect QR missing the code', () => {
  assert.equal(parseConnectQr('WHC1:{"url":"http://192.168.0.115:8765","secret":"deadbeef"}'), null);
});

test('returns null for a connect QR missing the secret', () => {
  assert.equal(parseConnectQr('WHC1:{"url":"http://192.168.0.115:8765","code":"abc"}'), null);
});

test('returns null for text without the WHC1: prefix', () => {
  assert.equal(parseConnectQr('WH1:ast_1'), null);
});

test('returns null for a connect QR with malformed JSON', () => {
  assert.equal(parseConnectQr('WHC1:not-json'), null);
});

test('returns null for a connect QR JSON payload missing url', () => {
  assert.equal(parseConnectQr('WHC1:{"code":"abc","secret":"deadbeef"}'), null);
});

test('returns null for an empty or missing connect QR scan result', () => {
  assert.equal(parseConnectQr(''), null);
  assert.equal(parseConnectQr(null), null);
  assert.equal(parseConnectQr(undefined), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test mobile/tests/qr.test.js`
Expected: FAIL — old `parseConnectQr` still accepts/returns the `password` shape

- [ ] **Step 3: Implement**

Replace `parseConnectQr` in `mobile/www/js/qr.js` (lines 11-22):

```javascript
function parseConnectQr(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith(WAREHOUSE_CONNECT_QR_PREFIX)) return null;
  let payload;
  try {
    payload = JSON.parse(trimmed.slice(WAREHOUSE_CONNECT_QR_PREFIX.length));
  } catch {
    return null;
  }
  if (!payload || typeof payload.url !== 'string' || !payload.url) return null;
  if (typeof payload.code !== 'string' || !payload.code) return null;
  if (typeof payload.secret !== 'string' || !payload.secret) return null;
  return { serverUrl: payload.url, code: payload.code, secret: payload.secret };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test mobile/tests/qr.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Rewrite `settings.js` to store token+secret, with failing tests first**

```javascript
// mobile/tests/settings.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Settings = require('../www/js/settings.js');

function fakePreferences() {
  const store = new Map();
  return {
    get: async ({ key }) => ({ value: store.has(key) ? store.get(key) : null }),
    set: async ({ key, value }) => { store.set(key, value); },
  };
}

test('get() returns empty defaults when nothing stored', async () => {
  const prefs = fakePreferences();
  assert.deepEqual(await Settings.get(prefs), { serverUrl: '', token: '', deviceSecret: '' });
});

test('set() then get() round-trips serverUrl/token/deviceSecret', async () => {
  const prefs = fakePreferences();
  await Settings.set({ serverUrl: 'http://192.168.0.1:8765', token: 'tok123', deviceSecret: 'sec456' }, prefs);
  assert.deepEqual(await Settings.get(prefs), {
    serverUrl: 'http://192.168.0.1:8765', token: 'tok123', deviceSecret: 'sec456',
  });
});

test('set() strips a trailing slash from serverUrl', async () => {
  const prefs = fakePreferences();
  await Settings.set({ serverUrl: 'http://192.168.0.1:8765/', token: 't', deviceSecret: 's' }, prefs);
  const result = await Settings.get(prefs);
  assert.equal(result.serverUrl, 'http://192.168.0.1:8765');
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `node --test mobile/tests/settings.test.js`
Expected: FAIL — `Cannot find module '../www/js/settings.js'` exports nothing importable, and current fields are `serverUrl`/`password`

- [ ] **Step 7: Implement**

Replace `mobile/www/js/settings.js` entirely:

```javascript
function getPreferences() {
  return Capacitor.Plugins.Preferences;
}

async function get(preferences = getPreferences()) {
  const [urlResult, tokenResult, secretResult] = await Promise.all([
    preferences.get({ key: 'serverUrl' }),
    preferences.get({ key: 'authToken' }),
    preferences.get({ key: 'deviceSecret' }),
  ]);
  return {
    serverUrl: (urlResult.value || '').replace(/\/$/, ''),
    token: tokenResult.value || '',
    deviceSecret: secretResult.value || '',
  };
}

async function set({ serverUrl, token, deviceSecret }, preferences = getPreferences()) {
  await preferences.set({ key: 'serverUrl', value: (serverUrl || '').replace(/\/$/, '') });
  await preferences.set({ key: 'authToken', value: token || '' });
  await preferences.set({ key: 'deviceSecret', value: deviceSecret || '' });
}

const Settings = { get, set };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Settings;
}
if (typeof window !== 'undefined') {
  window.Settings = Settings;
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `node --test mobile/tests/settings.test.js`
Expected: PASS (3 tests)

- [ ] **Step 9: Rewrite `sync.js` to use Bearer tokens and add a `pair()` function, with failing tests first**

```javascript
// mobile/tests/sync.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Sync = require('../www/js/sync.js');

test('pair() posts the code and returns token+deviceSecret from the response', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ token: 'tok123', role: 'storekeeper', username: 'bob' }),
    };
  };
  const result = await Sync.pair('http://192.168.0.1:8765', 'code123');
  assert.equal(result.token, 'tok123');
  assert.equal(calls[0].url, 'http://192.168.0.1:8765/api/pair');
  assert.deepEqual(JSON.parse(calls[0].options.body), { code: 'code123' });
});

test('pair() throws with the server error message on failure', async () => {
  global.fetch = async () => ({
    ok: false, status: 400, json: async () => ({ error: 'Код сопряжения истёк.' }),
  });
  await assert.rejects(() => Sync.pair('http://192.168.0.1:8765', 'expired'), /истёк/);
});

test('pullState sends a Bearer token, not Basic auth', async () => {
  let seenHeaders;
  global.fetch = async (url, options) => {
    seenHeaders = options.headers;
    return { ok: true, json: async () => ({}) };
  };
  global.Db = { replaceState: async () => {} };
  await Sync.pullState({ serverUrl: 'http://x', token: 'tok123', deviceSecret: 'sec' });
  assert.equal(seenHeaders.Authorization, 'Bearer tok123');
});
```

- [ ] **Step 10: Run to verify it fails**

Run: `node --test mobile/tests/sync.test.js`
Expected: FAIL — `sync.js` has no `module.exports`, no `pair()`, and still builds `Basic` auth headers

- [ ] **Step 11: Implement**

Replace `mobile/www/js/sync.js` entirely:

```javascript
function authHeaders(settings) {
  return settings.token ? { Authorization: `Bearer ${settings.token}` } : {};
}

async function pair(serverUrl, code) {
  const response = await fetch(`${serverUrl}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function flushQueue(settings) {
  const pending = await Db.listPendingActions();
  let flushed = 0;
  let failed = 0;
  for (const row of pending) {
    if (row.status === 'failed') continue;
    try {
      const response = await fetch(`${settings.serverUrl}/api/mobile/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(settings) },
        body: JSON.stringify(row.payload),
      });
      if (response.ok) {
        await Db.markActionSynced(row.client_action_id);
        flushed += 1;
      } else {
        const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        await Db.markActionFailed(row.client_action_id, body.error || `HTTP ${response.status}`);
        failed += 1;
      }
    } catch (err) {
      break;
    }
  }
  return { flushed, failed };
}

async function pullState(settings) {
  const response = await fetch(`${settings.serverUrl}/api/state`, {
    headers: authHeaders(settings),
  });
  if (!response.ok) throw new Error(`GET /api/state failed: HTTP ${response.status}`);
  const state = await response.json();
  await Db.replaceState(state);
}

async function run() {
  const settings = await Settings.get();
  if (!settings.serverUrl || !settings.token) return { pulled: false, flushed: 0, failed: 0 };
  const { flushed, failed } = await flushQueue(settings);
  let pulled = false;
  try {
    await pullState(settings);
    pulled = true;
  } catch (err) {
    pulled = false;
  }
  return { pulled, flushed, failed };
}

const Sync = { run, flushQueue, pullState, pair };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Sync;
}
if (typeof window !== 'undefined') {
  window.Sync = Sync;
}
```

- [ ] **Step 12: Run to verify it passes**

Run: `node --test mobile/tests/sync.test.js mobile/tests/qr.test.js mobile/tests/settings.test.js`
Expected: PASS (all tests)

- [ ] **Step 13: Wire the pairing scan flow in `screens.js`**

In `mobile/www/js/screens.js`, replace the `settingsScanBtn` click handler (lines 342-354):

```javascript
  document.getElementById('settingsScanBtn').addEventListener('click', async () => {
    try {
      const result = await Scanner.scanConnectQr();
      if (!result) return; // cancelled
      const { token } = await Sync.pair(result.serverUrl, result.code);
      await Settings.set({ serverUrl: result.serverUrl, token, deviceSecret: result.secret });
      document.getElementById('settingsUrl').value = result.serverUrl;
      showScreen('screen-scan');
      Sync.run().then((r) => { refreshQueueCount(); ConnStatus.report(r.pulled); });
    } catch (error) {
      alert(error && error.message ? error.message : 'Не удалось выполнить сканирование.');
    }
  });
```

Also remove the manual password field's role: change the `settingsSaveBtn` handler (lines 323-330) to only update the URL (a device that has never paired has no token to type manually, and one that has already paired shouldn't need to re-type a secret):

```javascript
  document.getElementById('settingsSaveBtn').addEventListener('click', async () => {
    const current = await Settings.get();
    await Settings.set({ serverUrl: document.getElementById('settingsUrl').value, token: current.token, deviceSecret: current.deviceSecret });
    showScreen('screen-scan');
    Sync.run().then((r) => { refreshQueueCount(); ConnStatus.report(r.pulled); });
  });
```

And in `navSettingsBtn`'s handler (lines 359-364) and `init()` (lines 314-321), drop references to `currentSettings.password`/`settings.password` (the field no longer exists) — just populate `settingsUrl` from `currentSettings.serverUrl`.

- [ ] **Step 14: Manual verification (requires a paired build — deferred to Task D's full build/verification step)**

No isolated manual check makes sense here without a running server + built APK; this flow is exercised end-to-end in Task D.

- [ ] **Step 15: Commit**

```bash
git add mobile/www/js/qr.js mobile/tests/qr.test.js mobile/www/js/settings.js mobile/tests/settings.test.js mobile/www/js/sync.js mobile/tests/sync.test.js mobile/www/js/screens.js
git commit -m "Task B8: mobile uses paired token instead of shared password"
```

---

## Задача C — HTTP + HMAC защита канала

### Task C1: `auth.py` — подпись и проверка запроса

**Files:**
- Modify: `auth.py`, `tests/test_auth.py`

**Interfaces:**
- Produces: `auth.SIGNATURE_WINDOW_SECONDS`, `auth.is_loopback(client_ip: str) -> bool`, `auth.sign_request(method, path, body, secret, *, timestamp=None) -> str`, `auth.verify_signature(method, path, body, secret, header_value, *, now=None) -> bool`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_auth.py (add)
def test_is_loopback_true_for_127_0_0_1():
    assert auth.is_loopback("127.0.0.1") is True


def test_is_loopback_true_for_ipv6_loopback():
    assert auth.is_loopback("::1") is True


def test_is_loopback_false_for_lan_address():
    assert auth.is_loopback("192.168.0.42") is False


def test_verify_signature_accepts_a_freshly_signed_request():
    header = auth.sign_request("GET", "/api/state", b"", "deadbeef")
    assert auth.verify_signature("GET", "/api/state", b"", "deadbeef", header) is True


def test_verify_signature_rejects_wrong_secret():
    header = auth.sign_request("GET", "/api/state", b"", "deadbeef")
    assert auth.verify_signature("GET", "/api/state", b"", "wrongsecret", header) is False


def test_verify_signature_rejects_tampered_body():
    header = auth.sign_request("POST", "/api/mobile/action", b'{"a":1}', "deadbeef")
    assert auth.verify_signature("POST", "/api/mobile/action", b'{"a":2}', "deadbeef", header) is False


def test_verify_signature_rejects_tampered_method():
    header = auth.sign_request("GET", "/api/state", b"", "deadbeef")
    assert auth.verify_signature("POST", "/api/state", b"", "deadbeef", header) is False


def test_verify_signature_rejects_expired_timestamp():
    header = auth.sign_request("GET", "/api/state", b"", "deadbeef", timestamp="1000")
    assert auth.verify_signature("GET", "/api/state", b"", "deadbeef", header, now=1000 + auth.SIGNATURE_WINDOW_SECONDS + 1) is False


def test_verify_signature_accepts_timestamp_within_window():
    header = auth.sign_request("GET", "/api/state", b"", "deadbeef", timestamp="1000")
    assert auth.verify_signature("GET", "/api/state", b"", "deadbeef", header, now=1000 + auth.SIGNATURE_WINDOW_SECONDS - 1) is True


def test_verify_signature_rejects_malformed_header():
    assert auth.verify_signature("GET", "/api/state", b"", "deadbeef", "not-a-valid-header") is False
    assert auth.verify_signature("GET", "/api/state", b"", "deadbeef", "") is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_auth.py -v -k signature`
Expected: FAIL — `AttributeError: module 'auth' has no attribute 'sign_request'`

- [ ] **Step 3: Implement**

Add to `auth.py`:

```python
SIGNATURE_WINDOW_SECONDS = 300
LOOPBACK_ADDRESSES = ("127.0.0.1", "::1")


def is_loopback(client_ip: str) -> bool:
    return client_ip in LOOPBACK_ADDRESSES


def _signing_string(method: str, path: str, timestamp: str, body: bytes) -> bytes:
    body_hash = hashlib.sha256(body).hexdigest()
    return f"{method}\n{path}\n{timestamp}\n{body_hash}".encode("utf-8")


def sign_request(method: str, path: str, body: bytes, secret: str, *, timestamp: str | None = None) -> str:
    ts = timestamp or str(int(time.time()))
    digest = hmac.new(bytes.fromhex(secret), _signing_string(method, path, ts, body), hashlib.sha256).hexdigest()
    return f"{ts}.{digest}"


def verify_signature(method: str, path: str, body: bytes, secret: str, header_value: str, *, now: int | None = None) -> bool:
    if not header_value or "." not in header_value:
        return False
    ts_str, _, digest = header_value.partition(".")
    try:
        ts = int(ts_str)
    except ValueError:
        return False
    current = now if now is not None else int(time.time())
    if abs(current - ts) > SIGNATURE_WINDOW_SECONDS:
        return False
    expected = hmac.new(bytes.fromhex(secret), _signing_string(method, path, ts_str, body), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, digest)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_auth.py -v`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add auth.py tests/test_auth.py
git commit -m "Task C1: add HMAC request signing and verification to auth.py"
```

---

### Task C2: Подключить проверку подписи в `server.py`

**Files:**
- Modify: `server.py` (`WarehouseHandler`)
- Modify: `tests/test_server_auth.py`

**Interfaces:**
- Consumes: `auth.is_loopback`, `auth.verify_signature` (Task C1); `self.authenticate()`, `body` variables already established in Task B6's `do_GET`/`do_POST`/`do_PATCH`.
- Produces: `WarehouseHandler.verify_channel_signature(user, body: bytes) -> bool`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_server_auth.py`. A non-loopback client can't be simulated by monkeypatching `client_address` on a real `urllib`-driven socket bound to `127.0.0.1` — so this task adds one true end-to-end test that connects via the machine's actual LAN-reachable address, skipped gracefully where none is available. Add `import auth` and `import socket` to the top of the file (next to the existing `import server`):

```python
import socket


def _lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return None


@pytest.fixture
def live_server_on_all_interfaces(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(server, "BACKUP_DIR", tmp_path / "backups")
    server.init_db()
    httpd = ThreadingHTTPServer(("0.0.0.0", 0), server.WarehouseHandler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield port
    httpd.shutdown()
    thread.join()


def test_loopback_requests_do_not_need_a_signature(live_server):
    # live_server (from Task B6) always connects via 127.0.0.1 — this is exactly
    # the loopback path desktop traffic always takes, even in LAN mode.
    token = _create_admin(live_server)
    status, _ = _request(live_server, "GET", "/api/state", token=token)
    assert status == 200  # no X-Signature header sent, and it still works


def _connect_via_lan_or_skip(base_url):
    # A firewall on a "Public" network profile can block a machine from
    # reaching its own LAN-facing address even when one exists — treat that
    # the same as "no LAN interface": skip rather than fail the whole suite.
    try:
        status, body = _request(base_url, "POST", "/api/setup", json_body={"username": "admin", "password": "adminpass"})
    except (OSError, urllib.error.URLError) as exc:
        pytest.skip(f"не удалось подключиться к собственному LAN-адресу: {exc}")
    assert status == 200, body
    return body["token"]


def test_non_loopback_request_without_signature_is_rejected(live_server_on_all_interfaces):
    lan_ip = _lan_ip()
    if lan_ip is None:
        pytest.skip("машина без LAN-интерфейса — не может подтвердить не-loopback путь")
    base_url = f"http://{lan_ip}:{live_server_on_all_interfaces}"
    admin_token = _connect_via_lan_or_skip(base_url)
    _, login = _request(base_url, "POST", "/api/login", json_body={"username": "admin", "password": "adminpass"})
    status, _ = _request(base_url, "GET", "/api/state", token=login["token"])
    assert status == 401


def test_non_loopback_request_with_valid_signature_succeeds(live_server_on_all_interfaces):
    lan_ip = _lan_ip()
    if lan_ip is None:
        pytest.skip("машина без LAN-интерфейса — не может подтвердить не-loopback путь")
    base_url = f"http://{lan_ip}:{live_server_on_all_interfaces}"
    admin_token = _connect_via_lan_or_skip(base_url)
    _, created = _request(base_url, "POST", "/api/users", token=admin_token,
                           json_body={"username": "v", "password": "pass1234", "role": "viewer"})
    _, pairing = _request(base_url, "POST", "/api/pair/generate", token=admin_token, json_body={"userId": created["id"]})
    _, paired = _request(base_url, "POST", "/api/pair", json_body={"code": pairing["code"]})
    header = auth.sign_request("GET", "/api/state", b"", pairing["secret"])
    req = urllib.request.Request(f"{base_url}/api/state", method="GET")
    req.add_header("Authorization", f"Bearer {paired['token']}")
    req.add_header("X-Signature", header)
    with urllib.request.urlopen(req) as response:
        assert response.status == 200
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_server_auth.py -v -k loopback`
Expected: `test_loopback_requests_do_not_need_a_signature` already passes (no enforcement yet); `test_non_loopback_request_without_signature_is_rejected` FAILS (currently returns 200, not 401) — this is the one that drives the implementation.

- [ ] **Step 3: Implement**

Add to `WarehouseHandler` in `server.py`, right after `require_role`:

```python
    def verify_channel_signature(self, user, body: bytes) -> bool:
        if auth.is_loopback(self.client_address[0]):
            return True
        secret = user["device_secret"]
        header_value = self.headers.get("X-Signature", "")
        if not secret or not auth.verify_signature(self.command, self.path, body, secret, header_value):
            self.send_json_error(HTTPStatus.UNAUTHORIZED, "Неверная или отсутствующая подпись запроса")
            return False
        return True
```

In `do_GET`, right after `user = self.authenticate(); if user is None: return`, add:

```python
        if not self.verify_channel_signature(user, b""):
            return
```

In `do_POST`, right after `user = self.authenticate(); if user is None: return` (before the `/api/logout` branch), add:

```python
        if not self.verify_channel_signature(user, body):
            return
```

In `do_PATCH`, right after `user = self.authenticate(); if user is None: return`, add the same:

```python
        if not self.verify_channel_signature(user, body):
            return
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_server_auth.py -v`
Expected: PASS (the two LAN-dependent tests either pass or skip depending on the environment; every other test passes)

- [ ] **Step 5: Run the full backend suite**

Run: `python -m pytest tests/ -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server.py tests/test_server_auth.py
git commit -m "Task C2: require HMAC signature on non-loopback API requests"
```

---

### Task C3: Мобильная подпись запросов (Web Crypto)

**Files:**
- Modify: `mobile/www/js/sync.js`, `mobile/tests/sync.test.js`

**Interfaces:**
- Consumes: `Settings.get()` теперь возвращает `deviceSecret` (Task B8).
- Produces: `Sync.signRequest(method, path, bodyText, secretHex) -> Promise<string>` (exported for testing); signed headers on every `fetch` in `flushQueue`/`pullState`.

- [ ] **Step 1: Write the failing tests**

Add to `mobile/tests/sync.test.js`:

```javascript
test('signRequest produces a "timestamp.hexdigest" string matching Node\'s crypto HMAC', async () => {
  const nodeCrypto = require('node:crypto');
  const secretHex = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const header = await Sync.signRequest('GET', '/api/state', '', secretHex);
  const [timestamp, digest] = header.split('.');
  const bodyHash = nodeCrypto.createHash('sha256').update('').digest('hex');
  const message = `GET\n/api/state\n${timestamp}\n${bodyHash}`;
  const expected = nodeCrypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(message).digest('hex');
  assert.equal(digest, expected);
});

test('flushQueue sends an X-Signature header derived from the request body', async () => {
  let seenHeaders;
  global.fetch = async (url, options) => {
    seenHeaders = options.headers;
    return { ok: true, json: async () => ({}) };
  };
  global.Db = {
    listPendingActions: async () => [{ client_action_id: 'a1', status: 'pending', payload: { x: 1 } }],
    markActionSynced: async () => {},
  };
  await Sync.flushQueue({ serverUrl: 'http://x', token: 'tok', deviceSecret: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  assert.ok(seenHeaders['X-Signature']);
  assert.match(seenHeaders['X-Signature'], /^\d+\.[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test mobile/tests/sync.test.js`
Expected: FAIL — `Sync.signRequest is not a function`, no `X-Signature` header sent

- [ ] **Step 3: Implement**

Add to `mobile/www/js/sync.js` (before `authHeaders`):

```javascript
function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function signRequest(method, path, bodyText, secretHex) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyBytes = new TextEncoder().encode(bodyText || '');
  const bodyHashBuffer = await crypto.subtle.digest('SHA-256', bodyBytes);
  const bodyHashHex = toHex(new Uint8Array(bodyHashBuffer));
  const message = `${method}\n${path}\n${timestamp}\n${bodyHashHex}`;
  const key = await crypto.subtle.importKey('raw', fromHex(secretHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return `${timestamp}.${toHex(new Uint8Array(signatureBuffer))}`;
}
```

Update `authHeaders` to become async and include the signature (rename usages accordingly):

```javascript
async function signedHeaders(settings, method, path, bodyText) {
  const headers = settings.token ? { Authorization: `Bearer ${settings.token}` } : {};
  if (settings.deviceSecret) {
    headers['X-Signature'] = await signRequest(method, path, bodyText, settings.deviceSecret);
  }
  return headers;
}
```

Update `flushQueue` to build the body text once and pass it through:

```javascript
async function flushQueue(settings) {
  const pending = await Db.listPendingActions();
  let flushed = 0;
  let failed = 0;
  for (const row of pending) {
    if (row.status === 'failed') continue;
    try {
      const bodyText = JSON.stringify(row.payload);
      const headers = { 'Content-Type': 'application/json', ...(await signedHeaders(settings, 'POST', '/api/mobile/action', bodyText)) };
      const response = await fetch(`${settings.serverUrl}/api/mobile/action`, { method: 'POST', headers, body: bodyText });
      if (response.ok) {
        await Db.markActionSynced(row.client_action_id);
        flushed += 1;
      } else {
        const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        await Db.markActionFailed(row.client_action_id, body.error || `HTTP ${response.status}`);
        failed += 1;
      }
    } catch (err) {
      break;
    }
  }
  return { flushed, failed };
}
```

Update `pullState`:

```javascript
async function pullState(settings) {
  const headers = await signedHeaders(settings, 'GET', '/api/state', '');
  const response = await fetch(`${settings.serverUrl}/api/state`, { headers });
  if (!response.ok) throw new Error(`GET /api/state failed: HTTP ${response.status}`);
  const state = await response.json();
  await Db.replaceState(state);
}
```

Update the exports at the bottom of the file:

```javascript
const Sync = { run, flushQueue, pullState, pair, signRequest };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test mobile/tests/sync.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full mobile suite**

Run: `node --test mobile/tests/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add mobile/www/js/sync.js mobile/tests/sync.test.js
git commit -m "Task C3: sign mobile requests with device secret via Web Crypto"
```

---

### Task C4: Документация ограничений канала

**Files:**
- Create: `docs/Защита_канала_LAN.md`

**Interfaces:** none (документация).

- [ ] **Step 1: Write the doc**

```markdown
# Защита канала в локальной сети

Начиная с этапа 1 дорожной карты, трафик между сервером и телефоном в
локальной сети подписывается HMAC-SHA256. Секрет подписи передаётся ТОЛЬКО
через QR-код при сопряжении устройства (сканирование камерой) — никогда по
сети. Это защищает от подделки запросов и (в пределах 5-минутного окна) от
их повторного воспроизведения, даже если Bearer-токен утёк из перехваченного
трафика.

## Что НЕ защищено

Весь трафик передаётся по обычному HTTP, без шифрования. Любой, кто может
слушать вашу Wi-Fi/LAN сеть (например, через ARP-спуфинг или доступ к
роутеру), может прочитать содержимое запросов и ответов — данные склада,
сотрудников, инвентарные номера. HMAC не защищает от прослушивания, только
от подделки/повтора.

Отдельно: обмен одноразового кода сопряжения на токен (`POST /api/pair`) не
подписывается — секрет для подписи в этот момент ещё не подтверждён обеими
сторонами. Если кто-то слушает сеть именно в 10-минутное окно жизни кода и
успевает отправить запрос раньше настоящего телефона, он получит токен
вместо него (одноразовость кода даёт only one winner). Это узкое окно риска,
актуальное только во время самого сканирования QR.

## Почему не HTTPS

Рассматривался вариант с самоподписанным TLS-сертификатом и пиннингом
отпечатка через QR. Он был отклонён для этого этапа: мобильный нативный
Android-слой сейчас нестабилен (см. историю коммитов — реверты вендоринга
плагинов из-за "startup bug"), а TLS-пиннинг в Capacitor WebView требует
правки нативного `WebViewClient` (`onReceivedSslError`) — рискованное
изменение поверх и без того нестабильной части. Это кандидат для отдельного
будущего этапа, когда мобильная нативная часть стабилизируется.

## Область действия

Проверка подписи применяется только к запросам, пришедшим НЕ с loopback-
адреса (`127.0.0.1`/`::1`). Десктоп-приложение всегда обращается к серверу
через `127.0.0.1`, даже в сетевом режиме — его трафик физически не покидает
машину, так что HMAC для него не нужен и не проверяется. Для телефона
(реальный LAN IP) подпись обязательна на каждом запросе с валидным токеном.
```

- [ ] **Step 2: Commit**

```bash
git add "docs/Защита_канала_LAN.md"
git commit -m "Task C4: document HTTP+HMAC channel protection and its limits"
```

---

## Задача D — финальная верификация этапа

### Task D1: Полный прогон тестов и пересборка EXE/APK

**Files:** none (verification only).

- [ ] **Step 1: Run the full backend test suite**

Run: `python -m pytest -q`
Expected: all tests pass, 0 failures

- [ ] **Step 2: Run the full mobile test suite**

Run: `node --test mobile/tests/`
Expected: all tests pass, 0 failures

- [ ] **Step 3: Smoke-test migration against a real old backup**

```bash
python -c "
import shutil, sqlite3
shutil.copy2('backups/<pick an old file>.db', 'warehouse_migration_smoke_test.db')
import server
server.DB_PATH = __import__('pathlib').Path('warehouse_migration_smoke_test.db')
server.init_db()
conn = sqlite3.connect('warehouse_migration_smoke_test.db')
conn.row_factory = sqlite3.Row
print('users table exists:', conn.execute(\"SELECT name FROM sqlite_master WHERE name='users'\").fetchone() is not None)
print('assets sample:', conn.execute('SELECT * FROM assets LIMIT 1').fetchone()['name'])
"
rm warehouse_migration_smoke_test.db
```

Expected: prints `users table exists: True` and a real asset name (no exception, no data loss).

- [ ] **Step 4: Rebuild the EXE**

Run: `build_exe.bat`
Expected: build completes without errors; `dist/WarehouseApp_New.exe` (or configured output path) exists

- [ ] **Step 5: Rebuild the APK**

Run: `mobile\android\gradlew.bat assembleDebug` (from `mobile/android`, or via the existing project build script if one wraps this)
Expected: build completes without errors; a new `.apk` is produced

- [ ] **Step 6: Verify acceptance criteria against the spec**

Walk `docs/superpowers/specs/2026-08-27-stage1-foundation-design.md`'s "Критерии приёмки" section and confirm each of the 5 items against what was actually built (old DB migrates with backup; no unauthenticated API access and viewer is blocked from issuing equipment; QR pairing works in one scan with no password transmitted; HMAC channel protection is in place and documented; tests are green and both builds succeed).

- [ ] **Step 7: Commit (if any fixes were needed during verification)**

```bash
git add -A
git commit -m "Task D1: stage 1 verification — tests, EXE, APK"
```

If no fixes were needed, skip this step (nothing to commit).
