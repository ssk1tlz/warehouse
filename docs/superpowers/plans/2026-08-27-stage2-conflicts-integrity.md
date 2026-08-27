# Этап 2 дорожной карты: конфликты, целостность синхронизации и человеческие ошибки — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Точечное версионирование (`assets.rev`) для обнаружения конфликтов между мобильным `edit` и десктопным сохранением, WAL-режим + `PRAGMA integrity_check` при старте, одно-кликовое восстановление из бэкапа (admin), и замена `alert()` на тосты в мобильном приложении.

**Architecture:** Никаких новых модулей — расширяем существующие четыре точки: `migrations.py` (миграция 25), `mobile_actions.py` (`apply_edit` + новое исключение `EditConflictError`), `server.py` (WAL/integrity_check/`import_state`/новые эндпойнты `/api/backups*`), `app.js`+`mobile/www/js/*` (UI конфликтов, восстановление, тосты).

**Tech Stack:** Python stdlib (`sqlite3`, `shutil`, `pathlib`), pytest; ванильный JS, `node --test`, Capacitor SQLite plugin (мобильный кэш).

**Spec:** `docs/superpowers/specs/2026-08-27-stage2-conflicts-integrity-design.md`

## Global Constraints

- Проект полностью бесплатный: никаких облачных API, платных библиотек, новых pip/npm-зависимостей.
- `rev` добавляется ТОЛЬКО в `assets`, не в `employees` (в мобильном приложении нет ни одного действия, редактирующего сотрудника — см. спеку, раздел "Не-цели").
- `rev` инкрементируется только когда меняется хотя бы одно из полей: `name, category, inventoryNumber, serialNumber, location, purchaseDate, warrantyEnd`. Операции с количеством (issue/return/repair/repair_return/retire) эти поля не трогают и `rev` не бампают — ни на мобильном, ни при десктопном `import_state`.
- Не ломать: офлайн-очередь мобильного, дедупликацию `mobile_action_log`, роли/токены/HMAC из Этапа 1, существующие данные (миграции без потерь).
- Язык интерфейса и сообщений об ошибках — русский. Стиль кода — как в существующих файлах.
- `schema.sql` обновляется в том же коммите, где добавляется миграция.
- Коммит по завершении каждой отдельно нумерованной задачи ниже.
- `mobile/www/js/db.js` не имеет файла тестов и не тестируется через `node --test` (плагин Capacitor SQLite требует `window`, недоступного в Node) — верификация только чтением кода, это существующий прецедент в проекте, не отступление от процесса.
- `mobile/www/js/screens.js` также не имеет файла тестов (DOM-логика) — новый код там верифицируется чтением/ручной трассировкой, кроме специально помеченных grep-тестов.
- Восстановление из бэкапа (`POST /api/backups/restore`) НЕ требует loopback — это не bootstrap-действие, роль `admin` + HMAC уже достаточны (см. спеку, "Не-цели").
- Все ссылки вида `file.py:123` в этом плане указывают на номера строк ДО начала этого плана — реальные номера сдвинутся по ходу задач. Искать по показанному фрагменту кода/имени функции.

---

## Задача A — обнаружение конфликтов редактирования

### Task A1: Миграция 25 — `assets.rev`

**Files:**
- Modify: `migrations.py` (миграция 25), `schema.sql`
- Test: `tests/test_migrations.py`

**Interfaces:**
- Consumes: `migrations._add_column_if_missing`, `migrations.MIGRATIONS` (Этап 1).
- Produces: `assets.rev INTEGER NOT NULL DEFAULT 0` — используется задачами A2-A4.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_migrations.py`:

```python
def test_migration_025_adds_assets_rev_column(legacy_conn):
    migrations.run_migrations(legacy_conn)
    columns = {row["name"] for row in legacy_conn.execute("PRAGMA table_info(assets)")}
    assert "rev" in columns


def test_migration_025_defaults_existing_rows_to_zero(legacy_conn):
    migrations.run_migrations(legacy_conn)
    row = legacy_conn.execute("SELECT rev FROM assets WHERE id='ast_1'").fetchone()
    assert row["rev"] == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_migrations.py -v -k migration_025`
Expected: FAIL — `rev` not in columns.

- [ ] **Step 3: Implement**

Add to `migrations.py`, after `_migrate_024_audit_log_actor`:

```python
def _migrate_025_assets_rev(c):
    _add_column_if_missing(c, "assets", "rev", "rev INTEGER NOT NULL DEFAULT 0")
```

Append to `MIGRATIONS`: `(25, "assets.rev", _migrate_025_assets_rev),`

Append to `schema.sql` (in the `assets` table's column list — add `rev INTEGER NOT NULL DEFAULT 0,` alongside the other columns, matching how `min_quantity`/`price`/etc. are already listed there):

```sql
  rev INTEGER NOT NULL DEFAULT 0,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_migrations.py -v`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add migrations.py schema.sql tests/test_migrations.py
git commit -m "Task A1: add assets.rev column (migration 25)"
```

---

### Task A2: `mobile_actions.py` — `apply_edit` требует `baseRev`, новое исключение `EditConflictError`

**Files:**
- Modify: `mobile_actions.py`
- Test: `tests/test_mobile_actions.py`

**Interfaces:**
- Consumes: `assets.rev` (Task A1).
- Produces: `mobile_actions.EditConflictError(MobileActionError)` с атрибутом `current_asset: dict`; `apply_edit` теперь требует `action["baseRev"]` и возвращает новый `rev: int` (было `None`); `apply_action` включает `"rev"` в возвращаемый `result`, когда дочерняя функция его вернула.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_mobile_actions.py` (adapt the existing `conn`/asset-seeding fixtures already used by other `apply_edit` tests in this file — seed one asset via the same helper the file already uses, e.g. `_seed_asset(conn, "ast_1", rev=0)` if such a helper exists, otherwise a direct `INSERT INTO assets ...` matching the file's existing style):

```python
def test_apply_edit_succeeds_with_matching_base_rev_and_bumps_rev(conn):
    action = {
        "clientActionId": "c1", "type": "edit", "assetId": "ast_1",
        "baseRev": 0, "name": "Новое имя", "category": "", "inventoryNumber": "",
        "serialNumber": "", "location": "", "purchaseDate": "", "warrantyEnd": "",
    }
    result = mobile_actions.apply_action(conn, action)
    assert result["rev"] == 1
    row = conn.execute("SELECT name, rev FROM assets WHERE id='ast_1'").fetchone()
    assert row["name"] == "Новое имя"
    assert row["rev"] == 1


def test_apply_edit_rejects_stale_base_rev(conn):
    action = {
        "clientActionId": "c1", "type": "edit", "assetId": "ast_1",
        "baseRev": 5, "name": "Новое имя", "category": "", "inventoryNumber": "",
        "serialNumber": "", "location": "", "purchaseDate": "", "warrantyEnd": "",
    }
    with pytest.raises(mobile_actions.EditConflictError) as excinfo:
        mobile_actions.apply_action(conn, action)
    assert excinfo.value.current_asset["rev"] == 0
    assert excinfo.value.current_asset["name"] == "Ноутбук"  # seeded name, unchanged


def test_apply_edit_requires_base_rev(conn):
    action = {
        "clientActionId": "c1", "type": "edit", "assetId": "ast_1",
        "name": "Новое имя", "category": "", "inventoryNumber": "",
        "serialNumber": "", "location": "", "purchaseDate": "", "warrantyEnd": "",
    }
    with pytest.raises(mobile_actions.MobileActionError):
        mobile_actions.apply_action(conn, action)


def test_apply_issue_does_not_change_rev(conn):
    conn.execute("INSERT INTO employees (id, full_name) VALUES ('emp_1', 'Иванов')")
    conn.commit()
    action = {
        "clientActionId": "c1", "type": "issue", "assetId": "ast_1",
        "employeeId": "emp_1", "quantity": 1,
    }
    mobile_actions.apply_action(conn, action)
    row = conn.execute("SELECT rev FROM assets WHERE id='ast_1'").fetchone()
    assert row["rev"] == 0
```

Check the file's existing fixture for the seeded asset `ast_1` — if it does not already set `name='Ноутбук'` and `quantity` sufficient for an `issue` of 1, adjust the two new tests' literals to match whatever the existing fixture actually seeds (read the fixture before writing these assertions; don't guess the seeded name).

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_mobile_actions.py -v -k "base_rev or does_not_change_rev"`
Expected: FAIL — `AttributeError: module 'mobile_actions' has no attribute 'EditConflictError'` / `rev` column missing until Task A1 lands (this task assumes A1 is already merged).

- [ ] **Step 3: Implement**

Add near the top of `mobile_actions.py`, after `MobileActionError`:

```python
class EditConflictError(MobileActionError):
    """Raised when a mobile edit's baseRev no longer matches the server's.

    `current_asset` carries the fields the caller needs to either show the
    user what changed or blindly retry with a fresh baseRev ("retry on top").
    """

    def __init__(self, message: str, current_asset: dict):
        super().__init__(message)
        self.current_asset = current_asset
```

Replace `apply_edit` entirely:

```python
def apply_edit(connection: sqlite3.Connection, action: dict) -> int:
    """Edit an asset's identifying/descriptive fields from the mobile app.

    Deliberately narrower than the desktop's full edit form: only the fields
    that don't interact with the allocation/quantity accounting (issue/return/
    repair/retire own that math) are editable here, so a mobile edit can never
    desync quantity vs. asset_allocations the way changing quantity or status
    directly could. These are exactly the fields `rev` guards.
    """
    asset = _load_asset(connection, action["assetId"])
    name = str(action.get("name") or "").strip()
    if not name:
        raise MobileActionError("Название не может быть пустым.")
    if "baseRev" not in action or action["baseRev"] is None:
        raise MobileActionError("baseRev обязателен.")
    try:
        base_rev = int(action["baseRev"])
    except (TypeError, ValueError):
        raise MobileActionError("baseRev должен быть числом.")
    current_rev = int(asset["rev"])
    if base_rev != current_rev:
        raise EditConflictError(
            "Карточка была изменена на сервере.",
            {
                "rev": current_rev,
                "name": asset["name"],
                "category": asset["category"] or "",
                "inventoryNumber": asset["inventory_number"] or "",
                "serialNumber": asset["serial_number"] or "",
                "location": asset["location"] or "",
                "purchaseDate": asset["purchase_date"] or "",
                "warrantyEnd": asset["warranty_end"] or "",
            },
        )

    new_rev = current_rev + 1
    connection.execute(
        "UPDATE assets SET name = ?, category = ?, inventory_number = ?, serial_number = ?, "
        "location = ?, purchase_date = ?, warranty_end = ?, rev = ? WHERE id = ?",
        (
            name,
            str(action.get("category") or "").strip(),
            str(action.get("inventoryNumber") or "").strip(),
            str(action.get("serialNumber") or "").strip(),
            str(action.get("location") or "").strip(),
            str(action.get("purchaseDate") or "").strip(),
            str(action.get("warrantyEnd") or "").strip(),
            new_rev,
            asset["id"],
        ),
    )
    connection.execute(
        "INSERT INTO movements (id, type, asset_id, employee_id, department, site, act_number, "
        "quantity, date, notes) VALUES (?, 'edit', ?, NULL, '', '', NULL, ?, ?, ?)",
        (_new_movement_id(), asset["id"], asset["quantity"],
         datetime.now(timezone.utc).date().isoformat(), "Обновлена карточка техники (с телефона)"),
    )
    return new_rev
```

Update `_DISPATCH` — no change needed (still maps `"edit": apply_edit`, just now returns an `int` instead of `None`).

Modify `apply_action` — the dispatch-call line and the result-building line:

```python
    new_rev = _DISPATCH[action_type](connection, action)

    result = {"assetId": action["assetId"], "replayed": False}
    if new_rev is not None:
        result["rev"] = new_rev
    connection.execute(
```

(This replaces the existing `_DISPATCH[action_type](connection, action)` statement and the `result = {"assetId": action["assetId"], "replayed": False}` line — the `connection.execute("INSERT INTO mobile_action_log ...")` line right after stays unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_mobile_actions.py -v`
Expected: PASS (all tests, including pre-existing ones — `apply_edit`'s old callers in tests must now pass `baseRev`; if any pre-existing test calls `apply_edit`/`apply_action` with `type: "edit"` and no `baseRev`, update that test's payload to include the asset's current `rev`, which is `0` for a freshly seeded asset).

- [ ] **Step 5: Commit**

```bash
git add mobile_actions.py tests/test_mobile_actions.py
git commit -m "Task A2: require baseRev on mobile edit, raise EditConflictError on mismatch"
```

---

### Task A3: `server.py` — `export_state` включает `rev`, `handle_mobile_action` различает конфликт (409)

**Files:**
- Modify: `server.py`
- Test: `tests/test_server_auth.py` or a new `tests/test_server_conflicts.py` (create if no existing file fits the mobile-action-endpoint test pattern — check `tests/` for an existing `test_server_mobile_action*.py` first and add there if it exists)

**Interfaces:**
- Consumes: `mobile_actions.EditConflictError`, `.current_asset` (Task A2).
- Produces: `GET /api/state` assets now carry `"rev"`; `POST /api/mobile/action` responds `409` with `{"error", "currentAsset"}` on edit conflicts.

- [ ] **Step 1: Write the failing test**

Add (to the file identified above; use its existing `live_server`/HTTP-client fixture pattern rather than reinventing one):

```python
def test_mobile_edit_conflict_returns_409_with_current_asset(live_server):
    # seed via the existing live_server fixture's admin/storekeeper token helper,
    # matching how other tests in this file create an asset and a paired token
    ...
    resp1 = post_mobile_action(..., {"type": "edit", "assetId": asset_id, "baseRev": 0, "name": "A", ...})
    assert resp1.status_code == 200
    # second edit still claims baseRev=0 (stale — resp1 bumped it to 1)
    resp2 = post_mobile_action(..., {"type": "edit", "assetId": asset_id, "baseRev": 0, "name": "B", ...})
    assert resp2.status_code == 409
    body = resp2.json()
    assert body["currentAsset"]["rev"] == 1
    assert body["currentAsset"]["name"] == "A"


def test_get_state_includes_asset_rev(live_server):
    ...
    state = get_state(...)
    assert "rev" in state["assets"][0]
```

Read the actual existing test file first and match its exact request-helper names (e.g. `post_mobile_action`, `get_state`, however it authenticates) — do not invent helper names; use what's already there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_server_*.py -v -k "conflict_returns_409 or includes_asset_rev"`
Expected: FAIL — 409 test gets 400 (generic `MobileActionError` path), rev test gets `KeyError`/`AssertionError` (rev absent from response).

- [ ] **Step 3: Implement**

In `server.py`, `export_state()`'s asset-row SELECT and dict construction (around the `assets = []` loop) — add `rev` to both the SQL column list and the SELECT-derived dict:

```python
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
```

In `handle_mobile_action`, add a catch for `EditConflictError` BEFORE the existing `except mobile_actions.MobileActionError` clause (Python matches the first matching `except`, and `EditConflictError` is a subclass, so it MUST come first):

```python
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
```

(This replaces just the existing `except mobile_actions.MobileActionError as exc:` block — insert the new `except mobile_actions.EditConflictError` block immediately above it, inside the same `try` in `handle_mobile_action`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/ -v -k "conflict_returns_409 or includes_asset_rev"`
Expected: PASS

Run the full backend suite to check for regressions from the `export_state` shape change:

Run: `python -m pytest -q`
Expected: PASS (all tests — if any existing test asserts an exact/exhaustive set of asset dict keys, it will need `"rev"` added to its expected set; fix any such test)

- [ ] **Step 5: Commit**

```bash
git add server.py tests/
git commit -m "Task A3: expose assets.rev in /api/state, return 409 with currentAsset on edit conflict"
```

---

### Task A4: `server.py` — `import_state` бампает `rev` только при изменении охраняемых полей

**Files:**
- Modify: `server.py:263-387` (`import_state`)
- Test: existing state-import test file (check `tests/` for `test_server*.py` covering `import_state`/`POST /api/state` and add there)

**Interfaces:**
- Consumes: `assets.rev` (Task A1).
- Produces: `import_state` preserves `rev` for unchanged assets, bumps it by 1 when any of `name/category/inventory_number/serial_number/location/purchase_date/warranty_end` differs from the stored row, and sets it to `0` for a brand-new asset id.

- [ ] **Step 1: Write the failing test**

```python
def test_import_state_preserves_rev_when_editable_fields_unchanged(live_server):
    # seed one asset via a first POST /api/state, note its rev (0)
    # re-POST the identical state (same name/category/... for that asset)
    # assert rev is still 0
    ...


def test_import_state_bumps_rev_when_name_changes(live_server):
    # seed asset, re-POST with a different `name` for the same asset id
    # assert rev went from 0 to 1
    ...


def test_import_state_does_not_bump_rev_when_only_quantity_changes(live_server):
    # seed asset, re-POST with the same name/category/... but a different quantity
    # assert rev unchanged
    ...
```

Match the existing test file's actual fixtures/helpers for driving `POST /api/state` (admin/storekeeper token, payload shape) — read a neighboring existing test in the same file first.

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/ -v -k "preserves_rev or bumps_rev_when_name or not_bump_rev_when_only_quantity"`
Expected: FAIL — every re-imported asset currently gets `rev` reset to its INSERT default (0) every time, because `import_state` doesn't read the old row at all before the `DELETE FROM assets`.

- [ ] **Step 3: Implement**

In `import_state`, add a snapshot of the current `assets` table's rev-guarded fields BEFORE the `DELETE FROM assets` line (right after `connection.execute("DELETE FROM asset_allocations")`, before `connection.execute("DELETE FROM movements")` — anywhere before `DELETE FROM assets` executes is correct; placing it as the very first statement after `BEGIN` is clearest):

```python
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
```

Then in the assets loop, compute `new_rev` and add it to the INSERT:

```python
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
```

Note: `new_fields` is built in the exact order `(name, category, inventoryNumber, serialNumber, location, purchaseDate, warrantyEnd)` to match `old[:7]`'s order from the `old_assets` snapshot tuple — keep these two orders in sync if either is ever touched again.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/ -v -k "preserves_rev or bumps_rev_when_name or not_bump_rev_when_only_quantity"`
Expected: PASS

Run: `python -m pytest -q`
Expected: PASS (full suite, no regressions)

- [ ] **Step 5: Commit**

```bash
git add server.py tests/
git commit -m "Task A4: bump assets.rev in import_state only when edit-owned fields change"
```

---

### Task A5: `mobile/www/js/db.js` — колонка `rev` в локальном кэше

**Files:**
- Modify: `mobile/www/js/db.js`

**Interfaces:**
- Consumes: `rev` field on assets from `GET /api/state` (Task A3).
- Produces: `Db.getAssetById()` returns `rev`; local cache schema upgrade path for devices with an already-installed cache DB predating this column.

No automated test — `db.js` requires `window.capacitorCapacitorSQLite` at load time and cannot be `require()`d under `node --test` (confirmed: no existing test file touches it; every other module that depends on `Db` stubs it via `global.Db = {...}` instead of loading the real file). Verify by reading the diff carefully; manual on-device verification note is in Task D1/E1's manual-check list.

- [ ] **Step 1: Add `rev` to the cache schema**

In `mobile/www/js/db.js`, modify the `SCHEMA` constant's `assets` table:

```sql
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT, inventory_number TEXT,
  serial_number TEXT, status TEXT, quantity INTEGER, repair_quantity INTEGER,
  retired_quantity INTEGER, location TEXT, purchase_date TEXT, warranty_end TEXT,
  rev INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 2: Handle upgrading an already-installed cache**

`CREATE TABLE IF NOT EXISTS` only applies to a brand-new local database — a phone that already has this app installed has an `assets` table without `rev`, and the `INSERT` in `replaceState` (Step 3 below) would fail with "no such column: rev" the first time it runs post-update. In `open()`, right after `await db.execute(SCHEMA);`, add a guarded `ALTER TABLE`:

```javascript
async function open() {
  db = await sqliteConnection.createConnection(DB_NAME, false, 'no-encryption', 1, false);
  await db.open();
  await db.execute(SCHEMA);
  try {
    await db.execute('ALTER TABLE assets ADD COLUMN rev INTEGER NOT NULL DEFAULT 0');
  } catch (err) {
    // Already has the column — either a fresh install (CREATE TABLE above already
    // added it) or a device that's already been through this upgrade once. SQLite
    // has no "ADD COLUMN IF NOT EXISTS", so a failed ALTER here is the expected,
    // safe outcome on every launch after the first; a genuinely different error
    // would surface immediately on the next db.query/db.run call anyway.
  }
}
```

- [ ] **Step 3: Include `rev` in `replaceState` and `getAssetById`**

In `replaceState`, add `rev` to the assets INSERT:

```javascript
    txn.push({
      statement: `INSERT INTO assets (id, name, category, inventory_number, serial_number, status, quantity,
       repair_quantity, retired_quantity, location, purchase_date, warranty_end, rev)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      values: [a.id, a.name, a.category, a.inventoryNumber, a.serialNumber, a.status, a.quantity,
        a.repairQuantity, a.retiredQuantity, a.location, a.purchaseDate, a.warrantyEnd, a.rev || 0],
    });
```

In `getAssetById`, add `rev: row.rev,` to the returned object (after `warrantyEnd: row.warranty_end,`):

```javascript
    warrantyEnd: row.warranty_end,
    rev: row.rev,
```

- [ ] **Step 4: Commit**

```bash
git add mobile/www/js/db.js
git commit -m "Task A5: add assets.rev to mobile local cache, with upgrade path for existing installs"
```

---

### Task A6: `mobile/www/js/db.js` + `sync.js` — статус очереди `'conflict'`

**Files:**
- Modify: `mobile/www/js/db.js`, `mobile/www/js/sync.js`
- Test: `mobile/tests/sync.test.js`

**Interfaces:**
- Consumes: HTTP 409 with `{error, currentAsset}` body from `/api/mobile/action` (Task A3); `assets.rev` on the local cache (Task A5).
- Produces: `Db.markActionConflict(clientActionId, currentAsset)`, `Db.retryActionOnTop(clientActionId, newBaseRev)`, `Db.cancelAction(clientActionId)`; `Sync.flushQueue` returns `{flushed, failed, conflicted, needsReauth}` (added `conflicted`).

- [ ] **Step 1: Write the failing tests**

Add to `mobile/tests/sync.test.js` (matching the file's existing `test(...)`/`global.Db =`/`global.fetch =` style):

```javascript
test('flushQueue marks a 409 edit conflict with status "conflict", not "failed"', async () => {
  const marked = [];
  global.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: 'Карточка была изменена на сервере.', currentAsset: { rev: 3, name: 'X' } }),
  });
  global.Db = {
    listPendingActions: async () => ([
      { client_action_id: 'a1', status: 'pending', payload: { type: 'edit', assetId: 'ast_1', baseRev: 0 } },
    ]),
    markActionConflict: async (id, currentAsset) => marked.push({ id, currentAsset }),
  };
  const result = await Sync.flushQueue({ serverUrl: 'http://x', token: 't' });
  assert.equal(result.conflicted, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(marked, [{ id: 'a1', currentAsset: { rev: 3, name: 'X' } }]);
});

test('flushQueue still marks a plain 400 as "failed", unaffected by conflict handling', async () => {
  global.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'Недостаточно остатка.' }),
  });
  const failed = [];
  global.Db = {
    listPendingActions: async () => ([
      { client_action_id: 'a1', status: 'pending', payload: { type: 'issue', assetId: 'ast_1' } },
    ]),
    markActionFailed: async (id, error) => failed.push({ id, error }),
  };
  const result = await Sync.flushQueue({ serverUrl: 'http://x', token: 't' });
  assert.equal(result.failed, 1);
  assert.equal(result.conflicted, 0);
  assert.deepEqual(failed, [{ id: 'a1', error: 'Недостаточно остатка.' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test mobile/tests/sync.test.js`
Expected: FAIL — `result.conflicted` is `undefined`, `Db.markActionConflict` never called (409 currently falls into the generic `else` branch and calls `markActionFailed`).

- [ ] **Step 3: Implement**

In `mobile/www/js/db.js`, add three functions (near `markActionFailed`/`retryAction`):

```javascript
async function markActionConflict(clientActionId, currentAsset) {
  await db.run(
    "UPDATE pending_actions SET status = 'conflict', server_error = ? WHERE client_action_id = ?",
    [JSON.stringify(currentAsset), clientActionId]
  );
}

async function retryActionOnTop(clientActionId, newBaseRev) {
  const result = await db.query('SELECT payload_json FROM pending_actions WHERE client_action_id = ?', [clientActionId]);
  if (!result.values.length) return;
  const payload = JSON.parse(result.values[0].payload_json);
  payload.baseRev = newBaseRev;
  await db.run(
    "UPDATE pending_actions SET status = 'pending', server_error = NULL, payload_json = ? WHERE client_action_id = ?",
    [JSON.stringify(payload), clientActionId]
  );
}

async function cancelAction(clientActionId) {
  await db.run('DELETE FROM pending_actions WHERE client_action_id = ?', [clientActionId]);
}
```

Add the three new names to the `window.Db = { ... }` export list at the bottom of `db.js`.

In `mobile/www/js/sync.js`, replace `flushQueue`'s per-item handling:

```javascript
async function flushQueue(settings) {
  const pending = await Db.listPendingActions();
  let flushed = 0;
  let failed = 0;
  let conflicted = 0;
  let needsReauth = false;
  for (const row of pending) {
    if (row.status === 'failed' || row.status === 'conflict') continue; // surfaced, retried explicitly
    try {
      const bodyText = JSON.stringify(row.payload);
      const headers = { 'Content-Type': 'application/json', ...(await signedHeaders(settings, 'POST', '/api/mobile/action', bodyText)) };
      const response = await fetch(`${settings.serverUrl}/api/mobile/action`, {
        method: 'POST',
        headers,
        body: bodyText,
      });
      if (response.ok) {
        await Db.markActionSynced(row.client_action_id);
        flushed += 1;
      } else if (response.status === 401) {
        needsReauth = true;
        break;
      } else if (response.status === 409) {
        const body = await response.json().catch(() => ({ currentAsset: {} }));
        await Db.markActionConflict(row.client_action_id, body.currentAsset || {});
        conflicted += 1;
      } else {
        const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        await Db.markActionFailed(row.client_action_id, body.error || `HTTP ${response.status}`);
        failed += 1;
      }
    } catch (err) {
      break;
    }
  }
  return { flushed, failed, conflicted, needsReauth };
}
```

`run()`'s return value doesn't need to change — `flushQueue`'s result is already destructured field-by-field there; leave `run()` as-is (it doesn't currently surface `conflicted` to its own caller, and no caller needs it yet — `screens.js`'s queue screen reads straight from `Db.listPendingActions()`'s `status` field, not from `run()`'s return value).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test mobile/tests/sync.test.js`
Expected: PASS (all tests)

Run: `node --test mobile/tests/*.test.js`
Expected: PASS (full mobile suite, no regressions)

- [ ] **Step 5: Commit**

```bash
git add mobile/www/js/db.js mobile/www/js/sync.js mobile/tests/sync.test.js
git commit -m "Task A6: add 'conflict' queue status, distinct from 'failed', on 409 edit responses"
```

---

### Task A7: `mobile/www/js/screens.js` — `baseRev` в `submitEdit`, UI конфликта в очереди

**Files:**
- Modify: `mobile/www/js/screens.js`

**Interfaces:**
- Consumes: `currentAsset.rev` (module-level, set by `openAssetScreen` via `Db.getAssetById`, Task A5); `Db.retryActionOnTop`, `Db.cancelAction` (Task A6).
- Produces: no new exports — UI-only change.

No automated test (screens.js has no test file — DOM-only module, same precedent as `db.js`). Verify by reading the diff; this is also covered by Task E1's manual on-device check.

- [ ] **Step 1: Send `baseRev` from `submitEdit`**

In `mobile/www/js/screens.js`, `submitEdit`'s payload object — add `baseRev: currentAsset.rev,`:

```javascript
  const payload = {
    type: 'edit',
    assetId: currentAssetId,
    baseRev: currentAsset.rev,
    name: document.getElementById('editName').value,
    category: document.getElementById('editCategory').value,
    inventoryNumber: document.getElementById('editInventoryNumber').value,
    serialNumber: document.getElementById('editSerialNumber').value,
    location: document.getElementById('editLocation').value,
    purchaseDate: document.getElementById('editPurchaseDate').value,
    warrantyEnd: document.getElementById('editWarrantyEnd').value,
  };
```

- [ ] **Step 2: Render conflict items with two buttons in `openQueueScreen`**

Replace `openQueueScreen`'s per-row loop body:

```javascript
    for (const row of pending) {
      const li = document.createElement('li');
      let statusText;
      if (row.status === 'conflict') {
        statusText = 'Конфликт: карточка изменена на сервере';
      } else if (row.status === 'failed') {
        statusText = `Ошибка: ${row.server_error}`;
      } else {
        statusText = 'Ждёт отправки';
      }
      li.textContent = `${MOVEMENT_LABELS[row.payload.type]} · ${row.payload.assetId} · ${statusText}`;
      if (row.status === 'failed') {
        const retryBtn = document.createElement('button');
        retryBtn.textContent = 'Повторить';
        retryBtn.addEventListener('click', async () => {
          await Db.retryAction(row.client_action_id);
          await openQueueScreen();
          Sync.run().then((r) => { refreshQueueCount(); ConnStatus.report(r.pulled, r.needsReauth); });
        });
        li.appendChild(retryBtn);
      } else if (row.status === 'conflict') {
        const currentAssetSnapshot = JSON.parse(row.server_error || '{}');
        const retryOnTopBtn = document.createElement('button');
        retryOnTopBtn.textContent = 'Повторить поверх';
        retryOnTopBtn.addEventListener('click', async () => {
          await Db.retryActionOnTop(row.client_action_id, currentAssetSnapshot.rev);
          await openQueueScreen();
          Sync.run().then((r) => { refreshQueueCount(); ConnStatus.report(r.pulled, r.needsReauth); });
        });
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Отменить';
        cancelBtn.addEventListener('click', async () => {
          await Db.cancelAction(row.client_action_id);
          await openQueueScreen();
          await refreshQueueCount();
        });
        li.appendChild(retryOnTopBtn);
        li.appendChild(cancelBtn);
      }
      listEl.appendChild(li);
    }
```

- [ ] **Step 3: Manual verification**

Since this is DOM-only code with no test harness, verify by re-reading the full diff of `openQueueScreen`, confirming: `'conflict'` and `'failed'` render distinct text and distinct button sets, and `currentAssetSnapshot.rev` is read from the same JSON shape `Db.markActionConflict` (Task A6) stores into `server_error`.

- [ ] **Step 4: Commit**

```bash
git add mobile/www/js/screens.js
git commit -m "Task A7: send baseRev on mobile edit, add conflict resolution UI to the queue screen"
```

---

## Задача B — целостность БД

### Task B1: WAL-режим

**Files:**
- Modify: `server.py:153-157` (`get_connection`)
- Test: `tests/test_server_migrations.py` or a new small test in an existing server test file

**Interfaces:**
- Produces: every connection from `get_connection()` runs in `journal_mode=WAL`.

- [ ] **Step 1: Write the failing test**

```python
def test_get_connection_enables_wal_mode(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "warehouse.db")
    server.init_db()
    connection = server.get_connection()
    mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode.lower() == "wal"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/ -v -k enables_wal_mode`
Expected: FAIL — default SQLite journal mode is `delete`, not `wal`.

- [ ] **Step 3: Implement**

In `server.py`, `get_connection()`:

```python
def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/ -v -k enables_wal_mode`
Expected: PASS

Run: `python -m pytest -q`
Expected: PASS (full suite — WAL mode doesn't change SQL semantics, only the journal file; a `:memory:` connection used by other tests' fixtures is unaffected since `get_connection()` is only exercised by tests that go through `server.py`, not the in-memory `migrations.py`/`auth.py` unit tests)

- [ ] **Step 5: Commit**

```bash
git add server.py tests/
git commit -m "Task B1: enable WAL journal mode on every connection"
```

---

### Task B2: `PRAGMA integrity_check` при старте — не стартовать при провале

**Files:**
- Modify: `server.py` (`init_db`, new `list_backups()` helper)
- Test: relevant `tests/test_server_migrations.py` (or wherever `init_db()` is already tested)

**Interfaces:**
- Produces: `server.list_backups() -> list[dict]` (`{filename, createdAt, sizeBytes}`, newest first); `init_db()` raises `SystemExit` with a Russian, actionable message when `PRAGMA integrity_check` doesn't return `"ok"`.

- [ ] **Step 1: Write the failing tests**

```python
def test_list_backups_returns_files_sorted_newest_first(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BACKUP_DIR", tmp_path)
    (tmp_path / "warehouse_20260101_000000.db").write_bytes(b"a")
    (tmp_path / "pre_migration_20260102_000000.db").write_bytes(b"b")
    backups = server.list_backups()
    assert [b["filename"] for b in backups] == ["pre_migration_20260102_000000.db", "warehouse_20260101_000000.db"]
    assert backups[0]["sizeBytes"] == 1


def test_init_db_refuses_to_start_on_corrupt_database(tmp_path, monkeypatch):
    db_path = tmp_path / "warehouse.db"
    db_path.write_bytes(b"not a real sqlite file")
    monkeypatch.setattr(server, "DB_PATH", db_path)
    monkeypatch.setattr(server, "BACKUP_DIR", tmp_path / "backups")
    with pytest.raises(SystemExit):
        server.init_db()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/ -v -k "list_backups or refuses_to_start"`
Expected: FAIL — `list_backups` doesn't exist; corrupt-DB case currently either silently "succeeds" or raises a raw `sqlite3.DatabaseError` instead of a clean `SystemExit`.

- [ ] **Step 3: Implement**

Add to `server.py` (near `auto_backup`/`pre_migration_backup`):

```python
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
```

Modify `init_db()` — add an integrity check after migrations run:

```python
def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    is_fresh_install = not DB_PATH.exists()
    with get_connection() as connection:
        connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        if not is_fresh_install and migrations.pending_migrations(connection):
            pre_migration_backup()
        migrations.run_migrations(connection)
        result = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            available = "\n".join(f"  - {b['filename']} ({b['createdAt']})" for b in list_backups())
            raise SystemExit(
                "ОШИБКА: проверка целостности базы данных не пройдена "
                f"({result}).\n"
                f"База данных: {DB_PATH}\n"
                "Доступные резервные копии в backups/:\n"
                f"{available or '  (нет резервных копий)'}\n"
                "Скопируйте один из файлов поверх warehouse.db вручную и запустите сервер снова."
            )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/ -v -k "list_backups or refuses_to_start"`
Expected: PASS

Run: `python -m pytest -q`
Expected: PASS (full suite)

- [ ] **Step 5: Commit**

```bash
git add server.py tests/
git commit -m "Task B2: refuse to start on failed integrity_check, add list_backups() helper"
```

---

## Задача C — восстановление из бэкапа в один клик

### Task C1: Единая ротация бэкапов + `pre_restore_backup()`

**Files:**
- Modify: `server.py` (`auto_backup`, add `pre_restore_backup`)
- Test: existing backup-related test (or add to the file created/extended in B2)

**Interfaces:**
- Consumes: `BACKUP_DIR`, `MAX_BACKUPS` (existing module constants).
- Produces: `server.pre_restore_backup() -> str | None`; `auto_backup`'s pruning now covers every `backups/*.db` file, not just `warehouse_*.db`. Task C2's `list_backups()` (Task B2) and this task's `_prune_backups()` glob the same directory independently — no shared call between them, just consistent globbing.

- [ ] **Step 1: Write the failing test**

```python
def test_auto_backup_prunes_across_all_backup_prefixes(tmp_path, monkeypatch):
    db_path = tmp_path / "warehouse.db"
    db_path.write_bytes(b"x")
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()
    monkeypatch.setattr(server, "DB_PATH", db_path)
    monkeypatch.setattr(server, "BACKUP_DIR", backup_dir)
    monkeypatch.setattr(server, "MAX_BACKUPS", 2)
    # Two pre-existing files of a DIFFERENT prefix than auto_backup() writes.
    (backup_dir / "pre_migration_20260101_000000.db").write_bytes(b"a")
    (backup_dir / "pre_restore_20260102_000000.db").write_bytes(b"b")
    server.auto_backup()
    remaining = {p.name for p in backup_dir.glob("*.db")}
    assert len(remaining) == 2  # MAX_BACKUPS=2 total, across ALL prefixes together


def test_pre_restore_backup_creates_a_labeled_file(tmp_path, monkeypatch):
    db_path = tmp_path / "warehouse.db"
    db_path.write_bytes(b"x")
    monkeypatch.setattr(server, "DB_PATH", db_path)
    monkeypatch.setattr(server, "BACKUP_DIR", tmp_path / "backups")
    dest = server.pre_restore_backup()
    assert dest is not None
    assert "pre_restore_" in dest
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/ -v -k "prunes_across_all_backup_prefixes or pre_restore_backup_creates"`
Expected: FAIL — `auto_backup()`'s current prune only globs `warehouse_*.db`, leaving the two seeded files untouched (3 total remain, not 2); `pre_restore_backup` doesn't exist.

- [ ] **Step 3: Implement**

Add a shared prune helper and use it from both `auto_backup` and the new `pre_restore_backup`:

```python
def _prune_backups() -> None:
    files = sorted(BACKUP_DIR.glob("*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[MAX_BACKUPS:]:
        old.unlink(missing_ok=True)


def auto_backup() -> str | None:
    """Create a timestamped backup of the database file."""
    if not DB_PATH.exists():
        return None
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"warehouse_{stamp}.db"
    shutil.copy2(DB_PATH, dest)
    _prune_backups()
    return str(dest)


def pre_migration_backup() -> str | None:
    """Separate, clearly-labeled backup taken only when migrations are about to run."""
    if not DB_PATH.exists():
        return None
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"pre_migration_{stamp}.db"
    shutil.copy2(DB_PATH, dest)
    _prune_backups()
    return str(dest)


def pre_restore_backup() -> str | None:
    """Snapshot of the current DB taken right before a one-click restore overwrites it."""
    if not DB_PATH.exists():
        return None
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"pre_restore_{stamp}.db"
    shutil.copy2(DB_PATH, dest)
    _prune_backups()
    return str(dest)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/ -v -k "prunes_across_all_backup_prefixes or pre_restore_backup_creates"`
Expected: PASS

Run: `python -m pytest -q`
Expected: PASS (full suite)

- [ ] **Step 5: Commit**

```bash
git add server.py tests/
git commit -m "Task C1: unify backup rotation across all prefixes, add pre_restore_backup()"
```

---

### Task C2: `GET /api/backups`

**Files:**
- Modify: `server.py` (`do_GET`, new `handle_list_backups`)
- Test: server auth/role test file

**Interfaces:**
- Consumes: `list_backups` (Task B2).
- Produces: `GET /api/backups` → `{"backups": [...]}`, role `admin` only.

- [ ] **Step 1: Write the failing tests**

```python
def test_get_backups_requires_admin_role(live_server):
    # using a storekeeper or viewer token, matching this file's existing
    # role-matrix test pattern
    response = get(..., "/api/backups", token=storekeeper_token)
    assert response.status_code == 403


def test_get_backups_returns_list_for_admin(live_server, tmp_path):
    response = get(..., "/api/backups", token=admin_token)
    assert response.status_code == 200
    assert "backups" in response.json()
```

Match this file's existing helper names for making an authenticated `GET` and for obtaining tokens of each role — read a neighboring test first.

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/ -v -k get_backups`
Expected: FAIL — `404 Not Found` (no route yet).

- [ ] **Step 3: Implement**

In `server.py`, add a handler:

```python
    def handle_list_backups(self) -> None:
        self.send_json({"backups": list_backups()})
```

In `do_GET`, add a route (alongside the existing `/api/users` admin-gated route):

```python
        if parsed.path == "/api/backups":
            if not self.require_role(user, ("admin",)):
                return
            self.handle_list_backups()
            return
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/ -v -k get_backups`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server.py tests/
git commit -m "Task C2: add GET /api/backups (admin)"
```

---

### Task C3: `POST /api/backups/restore`

**Files:**
- Modify: `server.py` (`do_POST`, new `handle_restore_backup`)
- Test: server auth/role test file

**Interfaces:**
- Consumes: `list_backups`, `pre_restore_backup` (Tasks B2/C1), `migrations.run_migrations`.
- Produces: `POST /api/backups/restore {"filename"}` → `{"ok": true}`, role `admin` only; rejects unknown/unlisted filenames and corrupt candidate files before touching `warehouse.db`.

- [ ] **Step 1: Write the failing tests**

```python
def test_restore_backup_requires_admin_role(live_server):
    response = post(..., "/api/backups/restore", {"filename": "x.db"}, token=storekeeper_token)
    assert response.status_code == 403


def test_restore_backup_rejects_unlisted_filename(live_server):
    response = post(..., "/api/backups/restore", {"filename": "../../etc/passwd"}, token=admin_token)
    assert response.status_code == 400


def test_restore_backup_rejects_corrupt_candidate_without_touching_warehouse_db(live_server, tmp_path):
    # write a corrupt .db file directly into the live_server's BACKUP_DIR,
    # matching the exact filename shape list_backups() would report
    ...
    original_bytes = server.DB_PATH.read_bytes()
    response = post(..., "/api/backups/restore", {"filename": "warehouse_corrupt.db"}, token=admin_token)
    assert response.status_code == 400
    assert server.DB_PATH.read_bytes() == original_bytes


def test_restore_backup_round_trips_a_real_snapshot(live_server, tmp_path):
    # create an asset, take a snapshot via server.auto_backup(), change the
    # asset's name, restore from the snapshot, assert the old name is back
    # and that a pre_restore_*.db now exists in BACKUP_DIR
    ...
```

Follow this file's existing pattern for constructing a `live_server` fixture with a real `BACKUP_DIR`/`DB_PATH` — read a neighboring fixture rather than inventing one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/ -v -k restore_backup`
Expected: FAIL — `404 Not Found` (no route yet).

- [ ] **Step 3: Implement**

Add to `server.py`:

```python
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
                check_connection = sqlite3.connect(tmp_path)
                result = check_connection.execute("PRAGMA integrity_check").fetchone()[0]
                check_connection.close()
                if result != "ok":
                    self.send_json_error(HTTPStatus.BAD_REQUEST, "Файл резервной копии повреждён.")
                    return
                pre_restore_backup()
                shutil.copy2(tmp_path, DB_PATH)
            finally:
                tmp_path.unlink(missing_ok=True)
            with get_connection() as connection:
                migrations.run_migrations(connection)
        self.send_json({"ok": True})
```

In `do_POST`, add a route (alongside `/api/pair/generate`):

```python
        if parsed.path == "/api/backups/restore":
            if not self.require_role(user, ("admin",)):
                return
            self.handle_restore_backup(body)
            return
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/ -v -k restore_backup`
Expected: PASS

Run: `python -m pytest -q`
Expected: PASS (full suite)

- [ ] **Step 5: Commit**

```bash
git add server.py tests/
git commit -m "Task C3: add POST /api/backups/restore with pre-restore snapshot and integrity check"
```

---

### Task C4: Десктоп — модалка "Резервные копии" (admin)

**Files:**
- Modify: `index.html`, `app.js`

**Interfaces:**
- Consumes: `GET /api/backups`, `POST /api/backups/restore` (Tasks C2/C3); `apiFetch`, `escapeHtml`, `data-requires-role` (Этап 1).

No automated test — `app.js`/`index.html` have no test harness (same precedent as Task B7 in Этап 1: verified via `curl`/hand-trace against a live server, not a browser tool). Manual verification steps are listed below; also covered by Task E1.

- [ ] **Step 1: Add markup to `index.html`**

Add a new sidebar button next to `logoutBtn` (inside the "Сеанс" `sidebar-actions` block, gated to admin):

```html
<button id="showBackupsBtn" class="secondary" data-requires-role="admin">Резервные копии</button>
```

Add a new overlay near `usersOverlay`:

```html
<div id="backupsOverlay" class="modal-overlay hidden">
  <div class="operation-modal wide">
    <div class="modal-header">
      <h3>Резервные копии</h3>
      <button type="button" class="modal-close" id="closeBackupsBtn">Закрыть</button>
    </div>
    <table class="data-table">
      <thead><tr><th>Файл</th><th>Дата</th><th>Размер</th><th></th></tr></thead>
      <tbody id="backupsTableBody"></tbody>
    </table>
  </div>
</div>
```

- [ ] **Step 2: Add rendering + event wiring in `app.js`**

Add near `renderUsersTable`/`openUsersModal`:

```javascript
async function openBackupsModal() {
  document.getElementById("backupsOverlay").classList.remove("hidden");
  await renderBackupsTable();
}

function closeBackupsModal() {
  document.getElementById("backupsOverlay").classList.add("hidden");
}

function formatBytes(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / (1024 * 1024)).toFixed(1)} МБ`;
}

async function renderBackupsTable() {
  const response = await apiFetch("/api/backups");
  const data = await response.json();
  document.getElementById("backupsTableBody").innerHTML = data.backups.map((b) => `
    <tr data-filename="${escapeHtml(b.filename)}">
      <td>${escapeHtml(b.filename)}</td>
      <td>${escapeHtml(new Date(b.createdAt).toLocaleString("ru-RU"))}</td>
      <td>${formatBytes(b.sizeBytes)}</td>
      <td><button type="button" data-action="restore-backup">Восстановить</button></td>
    </tr>
  `).join("");
}
```

Add event bindings inside `bindEvents()` (same function that already wires `showLanQrBtn`/`closeUsersBtn`):

```javascript
  document.getElementById("showBackupsBtn")?.addEventListener("click", openBackupsModal);
  document.getElementById("closeBackupsBtn")?.addEventListener("click", closeBackupsModal);
  document.getElementById("backupsOverlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("backupsOverlay")) closeBackupsModal();
  });
  document.getElementById("backupsTableBody")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action='restore-backup']");
    if (!btn) return;
    const filename = btn.closest("tr").dataset.filename;
    if (!confirm(`Восстановить базу данных из «${filename}»? Текущее состояние будет сохранено как резервная копия перед откатом.`)) return;
    const response = await apiFetch("/api/backups/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      alert(data.error || "Не удалось восстановить базу данных.");
      return;
    }
    closeBackupsModal();
    await boot();
  });
```

- [ ] **Step 3: Manual verification**

Start the server locally (`python server.py` or however this project's dev workflow runs it), log in as admin, open "Резервные копии", confirm the list renders with real files from `backups/`, click "Восстановить" on one, confirm the confirm() dialog appears, confirm the app reloads state afterward. Repeat as a non-admin (storekeeper) and confirm the sidebar button is hidden (`applyRoleVisibility`'s existing `data-requires-role` mechanism, unchanged).

- [ ] **Step 4: Commit**

```bash
git add index.html app.js
git commit -m "Task C4: add desktop 'Резервные копии' admin UI for one-click restore"
```

---

## Задача D — человеческие сообщения вместо alert() (мобильное)

### Task D1: `toast.js`

**Files:**
- Create: `mobile/www/js/toast.js`
- Modify: `mobile/www/style.css`, `mobile/www/index.html`

**Interfaces:**
- Produces: `window.Toast.show(message, type)` (`type`: `'info' | 'error'`, defaults to `'info'`).

No automated test — DOM rendering only, same precedent as `status.js` (which also has no test file). Verified by manual on-device/desktop-browser check in Step 3 and again in Task E1.

- [ ] **Step 1: Implement `toast.js`**

```javascript
// mobile/www/js/toast.js
const TOAST_DURATION_MS = 4000;
let toastContainer = null;

function ensureContainer() {
  if (toastContainer) return toastContainer;
  toastContainer = document.createElement('div');
  toastContainer.id = 'toastContainer';
  document.body.appendChild(toastContainer);
  return toastContainer;
}

function show(message, type = 'info') {
  const container = ensureContainer();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), TOAST_DURATION_MS);
}

window.Toast = { show };
```

- [ ] **Step 2: Add CSS**

Append to `mobile/www/style.css`:

```css
/* ─── toasts ──────────────────────────────────────────────────── */
#toastContainer {
  position: fixed;
  bottom: 16px;
  left: 12px;
  right: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 999;
  pointer-events: none;
}
.toast {
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
  color: #fff;
  background: var(--text, #222);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}
.toast-error { background: #b3261e; }
```

(If `mobile/www/style.css` has no `--text` custom property defined at `:root` — check first — drop the `var(--text, #222)` fallback pattern and use a plain `#222` instead, to match whatever this stylesheet actually does; don't introduce a CSS variable convention this file doesn't already use.)

- [ ] **Step 3: Wire the script tag and manually verify**

In `mobile/www/index.html`, add `<script src="js/toast.js"></script>` before `<script src="js/screens.js"></script>` (screens.js will call `Toast.show` starting in Task D2, so it must load after `toast.js`).

Manually verify: open the app (or load `index.html` directly in a desktop browser for a quick visual check), run `Toast.show('test', 'error')` in the devtools console, confirm a red toast appears bottom-of-screen and disappears after ~4 seconds, and that calling it twice quickly stacks two toasts rather than one replacing the other.

- [ ] **Step 4: Commit**

```bash
git add mobile/www/js/toast.js mobile/www/style.css mobile/www/index.html
git commit -m "Task D1: add dependency-free toast component"
```

---

### Task D2: Заменить `alert()` на тосты, `describeError()`, тост "Действие в очереди"

**Files:**
- Modify: `mobile/www/js/screens.js`
- Test: `mobile/tests/screens.test.js` (new — first test file for this module; only the pure `describeError` function and a static grep-check are testable, per this module's DOM-heavy nature)

**Interfaces:**
- Consumes: `Toast.show` (Task D1).
- Produces: `describeScanError(err, fallback)` (pure, exported for the module.exports test harness) — used at every call site that previously called `alert(error...)`.

All six existing `alert()` calls are either a scanner/camera-operation failure (four call sites: `catch (error) { alert(error && error.message ? ... ) }`) or a plain informational message with no `Error` object at all (two call sites: the "asset not in cache" message and the label-recognition-failed message). There is no network-error call site among the six — network/connectivity state is already surfaced separately via `ConnStatus` (the "● Офлайн" pill), never through `alert()`. So this task needs exactly one small pure helper (for the four error-object call sites), not a generic "network vs. server" classifier — a second function with no real caller would be dead code.

- [ ] **Step 1: Write the failing tests**

```javascript
// mobile/tests/screens.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('describeScanError returns the error message when present', () => {
  const { describeScanError } = require('../www/js/screens.js');
  assert.equal(describeScanError(new Error('Камера недоступна.')), 'Камера недоступна.');
});

test('describeScanError falls back to the given default when there is no message', () => {
  const { describeScanError } = require('../www/js/screens.js');
  assert.equal(describeScanError(null, 'Не удалось выполнить сканирование.'), 'Не удалось выполнить сканирование.');
  assert.equal(describeScanError(new Error(''), 'Не удалось распознать этикетку.'), 'Не удалось распознать этикетку.');
});

test('screens.js contains no alert( calls', () => {
  const source = fs.readFileSync(path.join(__dirname, '../www/js/screens.js'), 'utf8');
  assert.ok(!source.includes('alert('), 'alert( found in screens.js — replace with Toast.show');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test mobile/tests/screens.test.js`
Expected: FAIL — `require('../www/js/screens.js')` throws (the file is a plain browser script referencing `document`/`window` at module scope with no `module.exports`, and currently contains six `alert(` calls, failing the grep test regardless).

- [ ] **Step 3: Make `screens.js` requireable and add `describeScanError`**

At the very top of `mobile/www/js/screens.js`, before `NAV_SCREEN_MAP`, add the pure helper:

```javascript
function describeScanError(err, fallback) {
  return (err && err.message) ? err.message : fallback;
}
```

At the very bottom of `mobile/www/js/screens.js`, add a Node-only export guard (matching the exact pattern already used in `sync.js`, so `node --test` can `require()` this file without it trying to touch a real `document`/`window` — `describeScanError` itself never touches the DOM, so this export is safe even though the rest of the file does):

```javascript
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { describeScanError };
}
```

- [ ] **Step 4: Replace all six `alert(` calls with `Toast.show(...)`**

The two plain-message sites (no `Error` object) get their literal text passed straight through:

```javascript
// openAssetScreen — was: alert('Этот QR не найден в кэше...')
    Toast.show('Этот QR не найден в кэше. Подключитесь к сети склада и повторите синхронизацию.', 'error');
```

```javascript
// editPhotoBtn handler, "not applied" branch — was: alert(recognized ? `...` : '...')
      if (!applied) {
        const recognized = [parsed.name, parsed.serialNumber].filter(Boolean).join(' · ');
        Toast.show(recognized
          ? `Распознано: ${recognized}. Поля уже заполнены — очистите нужное поле и повторите, чтобы подставить.`
          : 'Не удалось распознать данные на этикетке — попробуйте снять ближе и при лучшем свете.', 'info');
      }
```

The four `catch (error)` sites route through `describeScanError` with each site's own existing fallback text:

```javascript
// scanBtn handler
      Toast.show(describeScanError(error, 'Не удалось выполнить сканирование.'), 'error');
```

```javascript
// settingsScanBtn handler
      Toast.show(describeScanError(error, 'Не удалось выполнить сканирование.'), 'error');
```

```javascript
// editScanSerialBtn handler
      Toast.show(describeScanError(error, 'Не удалось выполнить сканирование.'), 'error');
```

```javascript
// editPhotoBtn handler, catch block
    } catch (error) {
      Toast.show(describeScanError(error, 'Не удалось распознать этикетку.'), 'error');
    }
```

- [ ] **Step 5: Add "Действие в очереди" confirmation toast**

In both `submitAction` and `submitEdit` (each already calls `await Db.enqueueAction(payload);`), add a toast immediately after:

```javascript
  await Db.enqueueAction(payload);
  Toast.show('Действие в очереди', 'info');
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test mobile/tests/screens.test.js`
Expected: PASS

Run: `node --test mobile/tests/*.test.js`
Expected: PASS (full mobile suite)

- [ ] **Step 7: Grep-verify no `alert(` remains anywhere in mobile JS**

Run: `grep -rn "alert(" mobile/www/js/`
Expected: no output (empty)

- [ ] **Step 8: Commit**

```bash
git add mobile/www/js/screens.js mobile/tests/screens.test.js
git commit -m "Task D2: replace alert() with toasts, add describeError/describeScanError, queue confirmation toast"
```

---

## Задача E — финальная верификация этапа

### Task E1: Полный прогон тестов, пересборка EXE и APK, сверка с критериями приёмки

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend suite**

Run: `python -m pytest -q`
Expected: all tests pass (no count given here — read the actual number reported and record it).

- [ ] **Step 2: Run the full mobile suite**

Run: `node --test mobile/tests/*.test.js`
Expected: all tests pass.

- [ ] **Step 3: Rebuild the EXE**

Run: `pyinstaller WarehouseApp_New.spec --noconfirm` (or `build_exe.bat` if that's the project's documented path)
Expected: `Build complete!`, `dist/WarehouseApp_New.exe` exists.

- [ ] **Step 4: Sync and rebuild the APK**

**Do not skip the sync step** — `mobile/android/app/src/main/assets/public` is a committed-nowhere, gitignored copy of `mobile/www/`; Gradle repackages whatever is already there and will silently produce an APK built from STALE JavaScript if `www/` changed since the last sync (this exact gap was found and fixed once already, at the end of Этап 1 — do not reintroduce it).

Run:
```bash
cd mobile
npx cap sync android
cd android
./gradlew.bat assembleDebug
```
Expected: sync reports copying web assets; Gradle build succeeds; `mobile/android/app/build/outputs/apk/debug/app-debug.apk` exists.

Verify the new code actually landed in the built artifact (don't just trust the build succeeded):

```bash
grep -c "Toast.show\|EditConflict\|conflict" mobile/android/app/src/main/assets/public/js/screens.js
```
Expected: non-zero.

- [ ] **Step 5: Manual on-device/manual-trace checks**

Since `db.js`, `screens.js`, `app.js`/`index.html`, and `toast.js` have no (or only partial) automated coverage, walk through each acceptance criterion by hand:

1. Edit the same asset's name on the desktop, then (with a phone or a second `curl` session simulating one) attempt a mobile `edit` with a stale `baseRev` on that asset — confirm `409` with the desktop's new name in `currentAsset`, and that a real device would show it queued as `'conflict'` with "Повторить поверх"/"Отменить" — confirmed already by Tasks A2/A3's automated tests; this step is only about the UI wiring, which has none.
2. Attempt an `issue` for more than the available quantity — confirm the 400 error text is human-readable and the mobile queue would show it as `'failed'` with that text (already covered by Task A2's regression test at the `mobile_actions.py` layer; this step confirms `screens.js` renders `server_error` as-is, unchanged from before this stage).
3. As admin, restore from a backup in the new UI — confirm the app reloads with the restored state and a new `pre_restore_*.db` appears in `backups/`.
4. Confirm zero `alert(` remain: `grep -rn "alert(" mobile/www/js/` → empty (already asserted by Task D2's test; this is a final belt-and-suspenders check against the actually-built artifact from Step 4, not just the source tree).

- [ ] **Step 6: Confirm acceptance criteria**

Re-read `docs/superpowers/specs/2026-08-27-stage2-conflicts-integrity-design.md`'s "Критерии приёмки" section and confirm each of the 5 items against what Steps 1-5 just demonstrated. Record any gap found — do not mark this task complete with an unaddressed gap.

- [ ] **Step 7: Commit** (only if Step 5's manual checks required a code fix; otherwise this task has no commit of its own — it is a verification gate over Tasks A1-D2's existing commits)
