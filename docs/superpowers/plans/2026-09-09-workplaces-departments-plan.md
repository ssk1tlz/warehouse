# Рабочие места — разделение по отделам: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Превратить плоский список «Рабочие места» в список, сгруппированный по отделам, с собственным полем отдела у рабочего места, внутренним кодом (`WP-0001`…), поиском и статусом техники, вычисляемым из реальных данных — без REST-эндпоинтов, пагинации и новых архитектурных слоёв.

**Architecture:** Фича встраивается в существующую модель «весь стейт одним блоком» (`GET`/`POST /api/state`). Backend получает две новые колонки у `workplaces` (`department`, `code`), расширяет `validate_state`/`export_state`/`import_state`. Frontend делает всю группировку, фильтрацию, поиск и сортировку на клиенте в `app.js`, как уже сделано для отделов и сотрудников.

**Tech Stack:** Python 3 (`http.server`, `sqlite3`, `pytest`) на backend; ванильный JS/HTML/CSS на frontend без сборки и без JS-тест-раннера для DOM-рендеринга — в проекте такого нет ни для одной существующей секции (`renderDepartments`, `renderEmployees` и т.д. тоже не покрыты автотестами), поэтому frontend-задачи проверяются вручную через запущенное приложение, а не новым тестовым фреймворком.

**Spec:** `docs/superpowers/specs/2026-09-09-workplaces-departments-design.md` (и предыдущий этап — `docs/superpowers/specs/2026-09-07-workplaces-design.md`)

## Global Constraints

- Никаких новых REST-эндпоинтов, пагинации или backend-поиска — всё идёт через существующие `GET`/`POST /api/state`.
- `workplaces.department` — обычный текст (`TEXT NOT NULL DEFAULT ''`), НЕ `department_id`/FK — как `employees.department`.
- `workplaces.code` — сквозной номер вида `WP-0001`, генерируется и владеется сервером; клиент никогда его не отправляет и не редактирует.
- `workplaces.site` переиспользуется как поле «Объект/локация» (текст, не FK) — новой колонки `location` не заводить.
- Дубль рабочего места блокируется только в пределах одного отдела (`name`+`department`); одинаковое имя в разных отделах разрешено. Текст ошибки ровно: `Рабочее место с таким названием уже существует в этом отделе.`
- Сохраняется существующая бизнес-логика: один сотрудник — одно рабочее место (переназначение снимает с прежнего места); удаление места с закреплённой техникой запрещено; удаление сотрудника не удаляет место, только освобождает `employee_id`.
- Тёмная тема не переизобретается — используются существующие CSS-переменные (`--bg`, `--surface`, `--line`, `--brand`, `--r*`, `--shadow*`) и классы (`.panel`, `.chip`, `.emp-modern-table`, `.table-wrap`, `.search`, `.asset-form`, `.form-row`, `.form-field`, `showToast`, `showConfirm`).
- Права доступа не меняются — сохранение по-прежнему требует `require_role(user, ("admin", "storekeeper"))` на `/api/state`.

---

## Task 1: Схема — `workplaces.department`, `workplaces.code`, генерация кода

**Files:**
- Create: `workplace_codes.py`
- Test: `tests/test_workplace_codes.py`
- Modify: `migrations.py`
- Modify: `tests/test_migration_workplaces.py`
- Modify: `schema.sql`

**Interfaces:**
- Produces: `workplace_codes.next_number(connection: sqlite3.Connection) -> int`, `workplace_codes.assign_code(number: int) -> str` — используются в Task 2 (`server.py`) и здесь же (миграция 034).
- Produces: миграции `_migrate_033_workplaces_department`, `_migrate_034_workplaces_code`, зарегистрированные в `migrations.MIGRATIONS` под версиями 33 и 34.

- [ ] **Step 1: Написать падающий тест для `workplace_codes.py`**

Создать `tests/test_workplace_codes.py`:

```python
import sqlite3

import pytest

import workplace_codes


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute(
        "CREATE TABLE workplaces (id TEXT PRIMARY KEY, code TEXT NOT NULL DEFAULT '')"
    )
    yield connection
    connection.close()


def test_next_number_starts_at_one_when_empty(conn):
    assert workplace_codes.next_number(conn) == 1


def test_next_number_is_max_plus_one(conn):
    conn.execute("INSERT INTO workplaces (id, code) VALUES ('w1', 'WP-0003')")
    conn.execute("INSERT INTO workplaces (id, code) VALUES ('w2', 'WP-0007')")
    assert workplace_codes.next_number(conn) == 8


def test_next_number_ignores_blank_codes(conn):
    conn.execute("INSERT INTO workplaces (id, code) VALUES ('w1', '')")
    assert workplace_codes.next_number(conn) == 1


def test_next_number_ignores_codes_in_a_different_format(conn):
    # На случай ручной правки базы — не должно падать и не должно
    # считать это число.
    conn.execute("INSERT INTO workplaces (id, code) VALUES ('w1', 'NB-0099')")
    assert workplace_codes.next_number(conn) == 1


def test_assign_code_formats_with_leading_zeros():
    assert workplace_codes.assign_code(1) == "WP-0001"
    assert workplace_codes.assign_code(42) == "WP-0042"
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `py -m pytest tests/test_workplace_codes.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'workplace_codes'`

- [ ] **Step 3: Реализовать `workplace_codes.py`**

```python
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
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `py -m pytest tests/test_workplace_codes.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add workplace_codes.py tests/test_workplace_codes.py
git commit -m "feat(workplaces): add workplace_codes module for WP-NNNN generation"
```

- [ ] **Step 6: Написать падающие тесты миграций 033/034**

Добавить в конец `tests/test_migration_workplaces.py` (после существующего `test_all_three_registered_in_order`):

```python
def test_033_adds_department_column(conn):
    migrations._migrate_029_workplaces_table(conn)
    migrations._migrate_033_workplaces_department(conn)
    assert "department" in columns(conn, "workplaces")


def test_033_is_idempotent(conn):
    migrations._migrate_029_workplaces_table(conn)
    migrations._migrate_033_workplaces_department(conn)
    migrations._migrate_033_workplaces_department(conn)
    assert "department" in columns(conn, "workplaces")


def test_034_adds_code_column(conn):
    migrations._migrate_029_workplaces_table(conn)
    migrations._migrate_034_workplaces_code(conn)
    assert "code" in columns(conn, "workplaces")


def test_034_backfills_existing_rows_sequentially(conn):
    migrations._migrate_029_workplaces_table(conn)
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w1', 'Стол 2')")
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w2', 'Стол 1')")
    migrations._migrate_034_workplaces_code(conn)
    rows = {row["id"]: row["code"] for row in conn.execute("SELECT id, code FROM workplaces")}
    # Бэкофилл идёт в порядке "name, id" — "Стол 1" (w2) раньше "Стол 2" (w1).
    assert rows == {"w2": "WP-0001", "w1": "WP-0002"}


def test_034_does_not_touch_rows_with_existing_code(conn):
    migrations._migrate_029_workplaces_table(conn)
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w1', 'Стол 2')")
    migrations._migrate_034_workplaces_code(conn)
    conn.execute("UPDATE workplaces SET code = 'WP-0009' WHERE id = 'w1'")
    migrations._migrate_034_workplaces_code(conn)
    assert conn.execute("SELECT code FROM workplaces WHERE id='w1'").fetchone()["code"] == "WP-0009"


def test_034_is_idempotent(conn):
    migrations._migrate_029_workplaces_table(conn)
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w1', 'Стол 2')")
    migrations._migrate_034_workplaces_code(conn)
    first = conn.execute("SELECT code FROM workplaces WHERE id='w1'").fetchone()["code"]
    migrations._migrate_034_workplaces_code(conn)
    second = conn.execute("SELECT code FROM workplaces WHERE id='w1'").fetchone()["code"]
    assert first == second


def test_033_and_034_registered_in_order():
    versions = [version for version, _name, _func in migrations.MIGRATIONS]
    assert {33, 34} <= set(versions)
    assert versions == sorted(versions)
```

- [ ] **Step 7: Убедиться, что новые тесты падают**

Run: `py -m pytest tests/test_migration_workplaces.py -v`
Expected: FAIL — `AttributeError: module 'migrations' has no attribute '_migrate_033_workplaces_department'`

- [ ] **Step 8: Добавить миграции 033 и 034 в `migrations.py`**

В `migrations.py:8`, сразу после `import asset_codes`, добавить:

```python
import workplace_codes
```

В `migrations.py`, сразу после `_migrate_032_warranty_reminder_off` (заканчивается на строке 364, перед `MIGRATIONS: list[Migration] = [`), добавить:

```python
def _migrate_033_workplaces_department(c):
    _add_column_if_missing(c, "workplaces", "department", "department TEXT NOT NULL DEFAULT ''")


def _migrate_034_workplaces_code(connection: sqlite3.Connection) -> None:
    _add_column_if_missing(connection, "workplaces", "code", "code TEXT NOT NULL DEFAULT ''")
    rows = list(connection.execute(
        "SELECT id FROM workplaces WHERE code = '' ORDER BY name, id"
    ))
    if not rows:
        return
    next_num = workplace_codes.next_number(connection)
    for row in rows:
        connection.execute(
            "UPDATE workplaces SET code = ? WHERE id = ?",
            (workplace_codes.assign_code(next_num), row["id"]),
        )
        next_num += 1
```

В списке `MIGRATIONS`, сразу после строки `(32, "assets.warranty_reminder_off", _migrate_032_warranty_reminder_off),`, добавить:

```python
    (33, "workplaces.department", _migrate_033_workplaces_department),
    (34, "workplaces.code: бэкофилл WP-NNNN", _migrate_034_workplaces_code),
```

- [ ] **Step 9: Убедиться, что тесты проходят**

Run: `py -m pytest tests/test_migration_workplaces.py tests/test_workplace_codes.py tests/test_server_migrations.py -v`
Expected: все PASS

- [ ] **Step 10: Обновить `schema.sql`**

В `schema.sql:156-162` заменить блок `workplaces`:

```sql
CREATE TABLE IF NOT EXISTS workplaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  employee_id TEXT REFERENCES employees(id),
  site TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);
```

на:

```sql
CREATE TABLE IF NOT EXISTS workplaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  employee_id TEXT REFERENCES employees(id),
  site TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  -- Собственный отдел рабочего места (не department сотрудника — он
  -- может временно сидеть на месте другого подразделения). Текст, а не
  -- FK на departments.id — как employees.department. См. миграцию 033.
  department TEXT NOT NULL DEFAULT '',
  -- Внутренний идентификатор вида WP-0001, назначается сервером
  -- (workplace_codes.py), клиент не редактирует. См. миграцию 034.
  code TEXT NOT NULL DEFAULT ''
);
```

- [ ] **Step 11: Прогнать полный набор тестов миграций и убедиться, что ничего не сломано**

Run: `py -m pytest tests/ -k "migration or workplace_codes" -v`
Expected: все PASS

- [ ] **Step 12: Commit**

```bash
git add migrations.py tests/test_migration_workplaces.py schema.sql
git commit -m "feat(workplaces): add department and code columns via migrations 33-34"
```

---

## Task 2: Backend — `server.py` (валидация, генерация кода, export/import)

**Files:**
- Modify: `server.py`
- Modify: `tests/test_server_workplaces.py`

**Interfaces:**
- Consumes: `workplace_codes.next_number(connection)`, `workplace_codes.assign_code(number)` (Task 1).
- Produces: `export_state()["workplaces"]` items now include `"code"` и `"department"` keys; `validate_state(payload)` rejects workplaces with empty `department`, empty `name`, or a duplicate `(name, department)` pair within the same payload.

- [ ] **Step 1: Написать падающие тесты в `tests/test_server_workplaces.py`**

Заменить существующий `test_workplace_round_trip`:

```python
def test_workplace_round_trip(db):
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Цой Марина"}],
        workplaces=[{"id": "w1", "name": "Стол 2", "department": "Бухгалтерия",
                      "employeeId": "emp_1", "site": "АБЗ", "notes": "у окна"}],
    ), actor="tester")
    saved = server.export_state()["workplaces"]
    assert saved == [{
        "id": "w1", "name": "Стол 2", "code": "WP-0001", "department": "Бухгалтерия",
        "employeeId": "emp_1", "site": "АБЗ", "notes": "у окна",
    }]
```

Добавить в конец файла:

```python
def test_workplace_gets_assigned_code_on_creation(db):
    server.import_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 2", "department": "Бухгалтерия"}],
    ), actor="tester")
    assert server.export_state()["workplaces"][0]["code"] == "WP-0001"


def test_workplace_code_is_preserved_across_edits(db):
    server.import_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 2", "department": "Бухгалтерия"}],
    ), actor="tester")
    first_code = server.export_state()["workplaces"][0]["code"]
    # Клиент никогда не должен уметь переписать код, даже если пришлёт своё значение.
    server.import_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 2 (у окна)", "department": "Бухгалтерия", "code": "WP-9999"}],
    ), actor="tester")
    assert server.export_state()["workplaces"][0]["code"] == first_code


def test_second_new_workplace_in_same_save_gets_next_code(db):
    server.import_state(payload(
        workplaces=[
            {"id": "w1", "name": "Стол 1", "department": "Бухгалтерия"},
            {"id": "w2", "name": "Стол 2", "department": "Бухгалтерия"},
        ],
    ), actor="tester")
    codes = {w["id"]: w["code"] for w in server.export_state()["workplaces"]}
    assert codes == {"w1": "WP-0001", "w2": "WP-0002"}


def test_validate_state_requires_department():
    error = server.validate_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 2", "department": ""}],
    ))
    assert error == "Укажите отдел для рабочего места «Стол 2»."


def test_validate_state_rejects_duplicate_name_in_same_department():
    error = server.validate_state(payload(
        workplaces=[
            {"id": "w1", "name": "Стол 2", "department": "Бухгалтерия"},
            {"id": "w2", "name": "стол 2", "department": "Бухгалтерия"},
        ],
    ))
    assert error == "Рабочее место с таким названием уже существует в этом отделе."


def test_validate_state_allows_same_name_in_different_departments():
    error = server.validate_state(payload(
        workplaces=[
            {"id": "w1", "name": "Стол 2", "department": "Бухгалтерия"},
            {"id": "w2", "name": "Стол 2", "department": "IT"},
        ],
    ))
    assert error is None
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `py -m pytest tests/test_server_workplaces.py -v`
Expected: несколько FAIL — `test_workplace_round_trip` (ключей `code`/`department` нет в ответе), новые тесты про код и про валидацию.

- [ ] **Step 3: Добавить импорт `workplace_codes` в `server.py`**

В `server.py:28`, сразу после `import asset_codes`, добавить:

```python
import workplace_codes
```

- [ ] **Step 4: Обновить `export_state()` — добавить `code`/`department`**

В `server.py:538-549` заменить:

```python
        workplaces = [
            {
                "id": row["id"],
                "name": row["name"],
                "employeeId": row["employee_id"],
                "site": row["site"] or "",
                "notes": row["notes"] or "",
            }
            for row in connection.execute(
                "SELECT id, name, employee_id, site, notes FROM workplaces ORDER BY name"
            )
        ]
```

на:

```python
        workplaces = [
            {
                "id": row["id"],
                "name": row["name"],
                "code": row["code"] or "",
                "department": row["department"] or "",
                "employeeId": row["employee_id"],
                "site": row["site"] or "",
                "notes": row["notes"] or "",
            }
            for row in connection.execute(
                "SELECT id, name, code, department, employee_id, site, notes FROM workplaces ORDER BY name"
            )
        ]
```

- [ ] **Step 5: Обновить `import_state()` — сохранение/назначение кода и отдела**

В `server.py`, сразу после блока `old_assets = { ... }` (заканчивается перед `connection.execute("DELETE FROM asset_allocations")`, см. `server.py:665-676`), добавить:

```python
        old_workplace_codes = {
            row["id"]: row["code"] or ""
            for row in connection.execute("SELECT id, code FROM workplaces")
        }
        # Вызывается до DELETE FROM workplaces ниже, пока таблица ещё хранит
        # прежние строки — иначе next_number увидел бы пустую таблицу и
        # начал бы нумерацию заново на каждом сохранении.
        next_workplace_num = workplace_codes.next_number(connection)
```

В `server.py:711-721` заменить цикл вставки рабочих мест:

```python
        for workplace in workplaces:
            connection.execute(
                "INSERT INTO workplaces (id, name, employee_id, site, notes) VALUES (?, ?, ?, ?, ?)",
                (
                    workplace.get("id"),
                    workplace.get("name") or "",
                    workplace.get("employeeId") or None,
                    workplace.get("site") or "",
                    workplace.get("notes") or "",
                ),
            )
```

на:

```python
        for workplace in workplaces:
            workplace_id = workplace.get("id")
            old_code = old_workplace_codes.get(workplace_id)
            if old_code:
                code = old_code
            else:
                code = workplace_codes.assign_code(next_workplace_num)
                next_workplace_num += 1
            connection.execute(
                "INSERT INTO workplaces (id, name, code, department, employee_id, site, notes) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    workplace_id,
                    workplace.get("name") or "",
                    code,
                    workplace.get("department") or "",
                    workplace.get("employeeId") or None,
                    workplace.get("site") or "",
                    workplace.get("notes") or "",
                ),
            )
```

- [ ] **Step 6: Расширить `validate_state()`**

В `server.py:381-387` заменить хвост функции:

```python
    for mov in payload.get("movements", []):
        if not mov.get("id"):
            return "Each movement must have an id."
        mtype = mov.get("type", "")
        if mtype not in VALID_MOVEMENT_TYPES:
            return f"Invalid movement type: {mtype}"
    return None
```

на:

```python
    for mov in payload.get("movements", []):
        if not mov.get("id"):
            return "Each movement must have an id."
        mtype = mov.get("type", "")
        if mtype not in VALID_MOVEMENT_TYPES:
            return f"Invalid movement type: {mtype}"
    seen_workplace_keys = set()
    for workplace in payload.get("workplaces", []):
        if not workplace.get("id") or not str(workplace.get("name", "")).strip():
            return "У каждого рабочего места должны быть id и название."
        department = str(workplace.get("department", "")).strip()
        if not department:
            return f"Укажите отдел для рабочего места «{workplace.get('name')}»."
        key = (str(workplace.get("name", "")).strip().lower(), department)
        if key in seen_workplace_keys:
            return "Рабочее место с таким названием уже существует в этом отделе."
        seen_workplace_keys.add(key)
    return None
```

- [ ] **Step 7: Убедиться, что тесты проходят**

Run: `py -m pytest tests/test_server_workplaces.py -v`
Expected: все PASS

- [ ] **Step 8: Прогнать весь backend-набор тестов, чтобы убедиться, что ничего не сломано**

Run: `py -m pytest tests/ -v`
Expected: все PASS (в т.ч. `test_server_attention.py`, `test_server_audit.py` и остальные — они не трогают `workplaces`, но должны остаться зелёными)

- [ ] **Step 9: Commit**

```bash
git add server.py tests/test_server_workplaces.py
git commit -m "feat(workplaces): department field, server-owned code, and duplicate validation"
```

---

## Task 3: Frontend — форма (отдел, комбобокс объекта/локации, валидация, аудит)

**Files:**
- Modify: `index.html`
- Modify: `app.js`

**Interfaces:**
- Consumes: `state.workplaces[].department`, `state.workplaces[].code` (Task 2, через `hydrateState`).
- Produces: форма `#workplaceForm` сохраняет/редактирует рабочее место с полем `department`; `state.workplaces` элементы теперь несут `code`/`department` — потребляется Task 4 (рендер списка).

- [ ] **Step 1: Обновить `hydrateState()` — добавить `code`/`department` в нормализацию рабочих мест**

В `app.js:386-392` заменить:

```js
    workplaces: (parsed.workplaces || []).map((entry) => ({
      id: entry.id,
      name: entry.name || "",
      employeeId: entry.employeeId || null,
      site: entry.site || "",
      notes: entry.notes || "",
    })),
```

на:

```js
    workplaces: (parsed.workplaces || []).map((entry) => ({
      id: entry.id,
      name: entry.name || "",
      // code — server-owned (workplace_codes.py), клиент его не
      // редактирует, только отображает.
      code: entry.code || "",
      department: entry.department || "",
      employeeId: entry.employeeId || null,
      site: entry.site || "",
      notes: entry.notes || "",
    })),
```

- [ ] **Step 2: Обновить форму в `index.html`**

В `index.html:727-756` заменить заголовок панели и форму целиком (добавляется недостающее по промпту §2 описание под заголовком):

```html
          <div class="panel-header">
            <h3 id="workplaceFormTitle">Добавить рабочее место</h3>
          </div>
          <form id="workplaceForm" class="asset-form">
            <input type="hidden" name="workplaceId">
            <div class="form-row">
              <label class="form-field">
                <span class="form-label">Название <span class="req">*</span></span>
                <input name="name" required placeholder="Стол 2 / Каб. 305, окно">
              </label>
              <label class="form-field">
                <span class="form-label">Сотрудник</span>
                <select name="employeeId" id="workplaceEmployeeSelect"></select>
              </label>
            </div>
            <div class="form-row">
              <label class="form-field">
                <span class="form-label">Объект</span>
                <select name="site" id="workplaceSiteSelect"></select>
              </label>
              <label class="form-field">
                <span class="form-label">Комментарий</span>
                <input name="notes" placeholder="Примечание…">
              </label>
            </div>
            <div class="form-actions">
              <button type="submit" id="workplaceSubmitBtn">Сохранить место</button>
              <button type="button" id="workplaceCancelBtn" class="secondary hidden">Отменить</button>
            </div>
          </form>
```

на:

```html
          <div class="panel-header">
            <h3 id="workplaceFormTitle">Добавить рабочее место</h3>
          </div>
          <p class="muted" style="margin:-8px 0 14px;">Укажите отдел, сотрудника и основные данные о рабочем месте.</p>
          <form id="workplaceForm" class="asset-form">
            <input type="hidden" name="workplaceId">
            <div class="form-row">
              <label class="form-field">
                <span class="form-label">Отдел <span class="req">*</span></span>
                <select name="department" id="workplaceDepartmentSelect" required></select>
              </label>
              <label class="form-field">
                <span class="form-label">Сотрудник</span>
                <select name="employeeId" id="workplaceEmployeeSelect"></select>
              </label>
            </div>
            <div class="form-row">
              <label class="form-field">
                <span class="form-label">Название <span class="req">*</span></span>
                <input name="name" required placeholder="Стол 2 / Каб. 305, окно">
              </label>
              <label class="form-field">
                <span class="form-label">Объект / локация</span>
                <input name="site" id="workplaceSiteInput" list="workplaceSiteOptions" placeholder="Укажите объект / локацию">
                <datalist id="workplaceSiteOptions"></datalist>
              </label>
            </div>
            <div class="form-row">
              <label class="form-field">
                <span class="form-label">Комментарий</span>
                <input name="notes" placeholder="Примечание…">
              </label>
            </div>
            <div class="form-actions">
              <button type="submit" id="workplaceSubmitBtn">Сохранить место</button>
              <button type="button" id="workplaceCancelBtn" class="secondary hidden">Отменить</button>
            </div>
          </form>
```

- [ ] **Step 3: Переписать `renderWorkplaceFormSelects()`**

В `app.js:2601-2617` заменить:

```js
function renderWorkplaceFormSelects() {
  const employeeSelect = document.getElementById("workplaceEmployeeSelect");
  if (employeeSelect) {
    const current = employeeSelect.value;
    employeeSelect.innerHTML = `<option value="">— свободно —</option>`
      + getActiveEmployees(state.employees).map((employee) =>
        `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.fullName)}</option>`).join("");
    employeeSelect.value = current;
  }
  const siteSelect = document.getElementById("workplaceSiteSelect");
  if (siteSelect) {
    const current = siteSelect.value;
    siteSelect.innerHTML = `<option value="">— не указан —</option>`
      + state.sites.map((site) => `<option value="${escapeHtml(site.name)}">${escapeHtml(site.name)}</option>`).join("");
    siteSelect.value = current;
  }
}
```

на:

```js
function renderWorkplaceFormSelects() {
  const departmentSelect = document.getElementById("workplaceDepartmentSelect");
  if (departmentSelect) {
    const current = departmentSelect.value;
    departmentSelect.innerHTML = `<option value="">Выберите отдел</option>`
      + state.departments.map((dept) => `<option value="${escapeHtml(dept.name)}">${escapeHtml(dept.name)}</option>`).join("");
    departmentSelect.value = current;
  }
  const employeeSelect = document.getElementById("workplaceEmployeeSelect");
  if (employeeSelect) {
    const current = employeeSelect.value;
    employeeSelect.innerHTML = `<option value="">— свободно —</option>`
      + getActiveEmployees(state.employees).map((employee) =>
        `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.fullName)}${employee.department ? ` — ${escapeHtml(employee.department)}` : ""}</option>`).join("");
    employeeSelect.value = current;
  }
  const siteOptions = document.getElementById("workplaceSiteOptions");
  if (siteOptions) {
    siteOptions.innerHTML = state.sites.map((site) => `<option value="${escapeHtml(site.name)}"></option>`).join("");
  }
}
```

- [ ] **Step 4: Переписать `handleWorkplaceSubmit()`**

В `app.js:2619-2658` заменить всю функцию:

```js
async function handleWorkplaceSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const workplaceId = String(formData.get("workplaceId") || "").trim();
  const name = String(formData.get("name") || "").trim();
  if (!name) { showToast("Введите название рабочего места.", "warning"); return; }
  const employeeId = String(formData.get("employeeId") || "") || null;
  const site = String(formData.get("site") || "");
  const notes = String(formData.get("notes") || "").trim();

  // Один сотрудник — один стол: иначе «его техника» перестаёт быть
  // однозначной. Прежний стол освобождается.
  if (employeeId) {
    state.workplaces.forEach((other) => {
      if (other.id !== workplaceId && other.employeeId === employeeId) other.employeeId = null;
    });
  }

  if (workplaceId) {
    const workplace = getWorkplaceById(workplaceId);
    if (!workplace) return;
    const previousOwner = workplace.employeeId;
    Object.assign(workplace, { name, employeeId, site, notes });
    if (previousOwner !== employeeId) {
      addAuditEntry("workplace", workplace.id, "reassign", {
        from: previousOwner ? getEmployeeById(previousOwner)?.fullName : "свободно",
        to: employeeId ? getEmployeeById(employeeId)?.fullName : "свободно",
      });
    }
  } else {
    const duplicate = state.workplaces.find((w) => w.name.toLowerCase() === name.toLowerCase());
    if (duplicate) showToast(`Место с названием «${name}» уже есть — создано ещё одно.`, "warning");
    const workplace = { id: createId("wp"), name, employeeId, site, notes };
    state.workplaces.push(workplace);
    addAuditEntry("workplace", workplace.id, "create", { name });
  }
  resetWorkplaceForm();
  await persist();
  renderWorkplaces();
}
```

на:

```js
async function handleWorkplaceSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const workplaceId = String(formData.get("workplaceId") || "").trim();
  const name = String(formData.get("name") || "").trim();
  if (!name) { showToast("Введите название рабочего места.", "warning"); return; }
  const department = String(formData.get("department") || "").trim();
  if (!department) { showToast("Выберите отдел.", "warning"); return; }
  const employeeId = String(formData.get("employeeId") || "") || null;
  const site = String(formData.get("site") || "").trim();
  const notes = String(formData.get("notes") || "").trim();

  const duplicate = state.workplaces.find((w) =>
    w.id !== workplaceId && w.name.toLowerCase() === name.toLowerCase() && w.department === department
  );
  if (duplicate) {
    showToast("Рабочее место с таким названием уже существует в этом отделе.", "warning");
    return;
  }

  // Один сотрудник — один стол: иначе «его техника» перестаёт быть
  // однозначной. Прежний стол освобождается.
  if (employeeId) {
    state.workplaces.forEach((other) => {
      if (other.id !== workplaceId && other.employeeId === employeeId) other.employeeId = null;
    });
  }

  if (workplaceId) {
    const workplace = getWorkplaceById(workplaceId);
    if (!workplace) return;
    const previousOwner = workplace.employeeId;
    const fieldsChanged = workplace.name !== name || workplace.department !== department
      || workplace.site !== site || workplace.notes !== notes;
    Object.assign(workplace, { name, department, employeeId, site, notes });
    if (previousOwner !== employeeId) {
      addAuditEntry("workplace", workplace.id, "reassign", {
        from: previousOwner ? getEmployeeById(previousOwner)?.fullName : "свободно",
        to: employeeId ? getEmployeeById(employeeId)?.fullName : "свободно",
      });
    }
    if (fieldsChanged) {
      addAuditEntry("workplace", workplace.id, "update", { name, department, site, notes });
    }
    showToast("Рабочее место обновлено.", "success");
  } else {
    // code остаётся пустым до ответа сервера — persist() ниже заменяет
    // весь state результатом POST /api/state, где сервер уже назначил
    // реальный WP-NNNN (см. server.py import_state).
    const workplace = { id: createId("wp"), name, code: "", department, employeeId, site, notes };
    state.workplaces.push(workplace);
    addAuditEntry("workplace", workplace.id, "create", { name, department });
    showToast("Рабочее место успешно создано.", "success");
  }
  resetWorkplaceForm();
  await persist();
  renderWorkplaces();
}
```

(Сообщения показываются сразу, как и в `handleDepartmentSubmit` — до `persist()`, а не вместо него: общий тост «Данные сохранены» от `persist()` всё равно появится следом, это уже так работает для отделов и не меняется здесь.)

- [ ] **Step 5: Обновить `resetWorkplaceForm()` и `enterWorkplaceEditMode()`**

В `app.js:2660-2682` заменить:

```js
function resetWorkplaceForm() {
  const form = document.getElementById("workplaceForm");
  if (!form) return;
  form.reset();
  form.elements.workplaceId.value = "";
  document.getElementById("workplaceFormTitle").textContent = "Добавить рабочее место";
  document.getElementById("workplaceSubmitBtn").textContent = "Сохранить место";
  document.getElementById("workplaceCancelBtn").classList.add("hidden");
}

function enterWorkplaceEditMode(workplaceId) {
  const workplace = getWorkplaceById(workplaceId);
  if (!workplace) return;
  const form = document.getElementById("workplaceForm");
  renderWorkplaceFormSelects();
  form.elements.workplaceId.value = workplace.id;
  form.elements.name.value = workplace.name;
  form.elements.employeeId.value = workplace.employeeId || "";
  form.elements.site.value = workplace.site || "";
  form.elements.notes.value = workplace.notes || "";
  document.getElementById("workplaceFormTitle").textContent = "Изменить рабочее место";
  document.getElementById("workplaceSubmitBtn").textContent = "Сохранить изменения";
  document.getElementById("workplaceCancelBtn").classList.remove("hidden");
}
```

на:

```js
function resetWorkplaceForm() {
  const form = document.getElementById("workplaceForm");
  if (!form) return;
  form.reset();
  form.elements.workplaceId.value = "";
  const departmentSelect = document.getElementById("workplaceDepartmentSelect");
  if (departmentSelect) departmentSelect.dataset.touched = "";
  document.getElementById("workplaceFormTitle").textContent = "Добавить рабочее место";
  document.getElementById("workplaceSubmitBtn").textContent = "Сохранить место";
  document.getElementById("workplaceCancelBtn").classList.add("hidden");
}

function enterWorkplaceEditMode(workplaceId) {
  const workplace = getWorkplaceById(workplaceId);
  if (!workplace) return;
  const form = document.getElementById("workplaceForm");
  renderWorkplaceFormSelects();
  form.elements.workplaceId.value = workplace.id;
  form.elements.department.value = workplace.department || "";
  form.elements.name.value = workplace.name;
  form.elements.employeeId.value = workplace.employeeId || "";
  form.elements.site.value = workplace.site || "";
  form.elements.notes.value = workplace.notes || "";
  document.getElementById("workplaceFormTitle").textContent = workplace.code
    ? `Изменить рабочее место (${workplace.code})`
    : "Изменить рабочее место";
  document.getElementById("workplaceSubmitBtn").textContent = "Сохранить изменения";
  document.getElementById("workplaceCancelBtn").classList.remove("hidden");
}
```

- [ ] **Step 6: Добавить автоподстановку отдела из карточки сотрудника**

В `app.js`, рядом со строкой `document.getElementById("workplaceCancelBtn")?.addEventListener("click", resetWorkplaceForm);` (см. `app.js:4713`), добавить сразу после неё:

```js
  document.getElementById("workplaceEmployeeSelect")?.addEventListener("change", (event) => {
    const form = document.getElementById("workplaceForm");
    const isEditing = Boolean(form?.elements.workplaceId.value);
    const departmentSelect = document.getElementById("workplaceDepartmentSelect");
    if (!departmentSelect || isEditing || departmentSelect.dataset.touched === "1") return;
    const employee = getEmployeeById(event.target.value);
    if (employee?.department) departmentSelect.value = employee.department;
  });
  document.getElementById("workplaceDepartmentSelect")?.addEventListener("change", (event) => {
    event.target.dataset.touched = "1";
  });
```

- [ ] **Step 7: Ручная проверка через запущенное приложение**

В проекте нет автотестов для DOM-рендеринга (как и для остальных секций — `renderDepartments`, `renderEmployees` тоже без них), поэтому проверка здесь ручная. Использовать skill `run`, чтобы запустить сервер на тестовой копии базы (НЕ на живой `%ProgramData%\Warehouse\warehouse.db`), открыть раздел «Рабочие места» и проверить:

1. В форме появилось поле «Отдел» с выпадающим списком реальных отделов из БД (не захардкожено).
2. При выборе сотрудника в поле «Сотрудник» отдел автоматически подставляется из карточки сотрудника, если поле «Отдел» ещё не трогали руками.
3. После ручного изменения «Отдела» повторный выбор другого сотрудника больше не перезаписывает его.
4. Поле «Объект / локация» — это текстовое поле с подсказками (datalist) из существующих объектов, но позволяет ввести произвольный текст.
5. Создание рабочего места с тем же названием в том же отделе, что уже существует, отклоняется с сообщением «Рабочее место с таким названием уже существует в этом отделе.» — тем же именем, но в ДРУГОМ отделе создаётся без ошибки.
6. Создание без выбранного отдела отклоняется с сообщением «Выберите отдел.».
7. Открыв существующее место в редактирование, в заголовке формы виден код (`WP-0001` и т.п.), если он уже был назначен сервером.

- [ ] **Step 8: Commit**

```bash
git add index.html app.js
git commit -m "feat(workplaces): department field, object/location combobox, and stricter duplicate check"
```

---

## Task 4: Frontend — список по отделам (вкладки, счётчики, сворачиваемые группы, таблица, статус техники, поиск, сортировка)

**Files:**
- Modify: `index.html`
- Modify: `app.js`
- Modify: `styles.css`

**Interfaces:**
- Consumes: `state.workplaces[].{code,department}` (Task 3), `getWorkplaceAssets(workplaceId)`, `getEmployeeById(id)`, `matchesSearch(query, ...values)`, `state.attentionItems` (все уже существуют).
- Produces: `getWorkplaceStatus(workplaceId) -> { tone, label }` — используется и здесь, и может переиспользоваться в Task 5 (мобильные карточки).

Упрощение относительно дизайн-документа: там сортировка описана как
выпадающий список НАД КАЖДЫМ отделом (независимое состояние на группу).
Здесь — один общий контроль сортировки над всем списком, применяется ко
всем группам одинаково. Промпт (§21) требует лишь «предусмотреть
возможность сортировки по» перечисленным полям, не независимое
состояние на отдел — общий контроль это условие выполняет с меньшей
сложностью (не нужна `Map<department, sortBy>` и отдельный `<select>` в
каждой группе). Если позже понадобится независимая сортировка на
группу — это отдельное расширение поверх `sortWorkplaceRows`.

- [ ] **Step 1: Обновить контейнер списка в `index.html`**

В `index.html`, блок панели со списком (там же, где раньше был `<div id="workplacesList" class="list"></div>` — после изменений Task 3 он остался как последний блок секции `#workplaces`), заменить:

```html
        <div class="panel">
          <div class="panel-header">
            <h3>Рабочие места</h3>
          </div>
          <div id="workplacesList" class="list"></div>
        </div>
```

на:

```html
        <div class="panel">
          <div class="panel-header">
            <h3>Рабочие места</h3>
            <div class="wp-toolbar">
              <input id="workplaceSearchInput" class="search" style="max-width:240px" placeholder="🔍 Поиск по рабочим местам…">
              <select id="workplaceSortSelect" style="max-width:190px">
                <option value="name">По названию</option>
                <option value="employee">По сотруднику</option>
                <option value="location">По локации</option>
                <option value="equipment">По кол-ву техники</option>
              </select>
            </div>
          </div>
          <div id="workplaceDeptTabs" class="dept-tabs"></div>
          <div id="workplacesList"></div>
        </div>
```

- [ ] **Step 2: Добавить состояние отображения и функцию статуса техники в `app.js`**

Сразу перед `function renderWorkplaces() {` (см. `app.js:2572`) добавить:

```js
let workplaceActiveDept = "";
let workplaceSortBy = "name";
// null = ещё не инициализировано (раскрыть первый отдел с местами при
// первом рендере); дальше — набор развёрнутых отделов, который хранит
// ручные клики пользователя между рендерами.
let workplaceExpandedDepts = null;

// Статус вычисляется из реальных данных (state.attentionItems + статус
// актива), а не хранится статичной меткой — см. промпт §10.
function getWorkplaceStatus(workplaceId) {
  const items = getWorkplaceAssets(workplaceId);
  if (!items.length) return { tone: "muted", label: "Оборудование не назначено" };
  const attentionAssetIds = new Set((state.attentionItems || []).map((item) => item.assetId));
  const needsAttention = items.some(({ asset }) =>
    asset.status === "repair" || asset.status === "retired" || attentionAssetIds.has(asset.id)
  );
  return needsAttention
    ? { tone: "warn", label: "⚠ Требует проверки" }
    : { tone: "ok", label: "🟢 Всё в порядке" };
}

function workplaceMatchesQuery(workplace, query) {
  const owner = workplace.employeeId ? getEmployeeById(workplace.employeeId) : null;
  const items = getWorkplaceAssets(workplace.id);
  const assetText = items.map(({ asset }) => `${asset.inventoryNumber} ${asset.name}`).join(" ");
  return matchesSearch(query, workplace.name, workplace.code, workplace.department, workplace.site, owner?.fullName, assetText);
}

function sortWorkplaceRows(rows, sortBy) {
  const withMeta = rows.map((workplace) => ({
    workplace,
    owner: workplace.employeeId ? getEmployeeById(workplace.employeeId) : null,
    equipmentCount: getWorkplaceAssets(workplace.id).reduce((sum, e) => sum + e.allocation.quantity, 0),
  }));
  const byName = (a, b) => a.localeCompare(b, "ru");
  switch (sortBy) {
    case "employee":
      withMeta.sort((a, b) => byName(a.owner?.fullName || "￿", b.owner?.fullName || "￿"));
      break;
    case "location":
      withMeta.sort((a, b) => byName(a.workplace.site || "￿", b.workplace.site || "￿"));
      break;
    case "equipment":
      withMeta.sort((a, b) => b.equipmentCount - a.equipmentCount);
      break;
    default:
      withMeta.sort((a, b) => byName(a.workplace.name, b.workplace.name));
  }
  return withMeta;
}
```

- [ ] **Step 3: Переписать `renderWorkplaces()` и добавить рендер вкладок/групп/таблицы**

В `app.js:2572-2599` заменить всю функцию `renderWorkplaces`:

```js
function renderWorkplaces() {
  renderWorkplaceFormSelects();
  const container = document.getElementById("workplacesList");
  if (!container) return;
  if (!state.workplaces.length) {
    container.innerHTML = `<div class="empty-state"><p>Нет рабочих мест</p></div>`;
    return;
  }
  container.innerHTML = state.workplaces.map((workplace) => {
    const owner = workplace.employeeId ? getEmployeeById(workplace.employeeId) : null;
    const items = getWorkplaceAssets(workplace.id);
    const units = items.reduce((sum, entry) => sum + entry.allocation.quantity, 0);
    const itemsText = items.length
      ? items.map(({ asset, allocation }) => `${escapeHtml(asset.inventoryNumber || asset.name)} ×${allocation.quantity}`).join(", ")
      : "Техники нет";
    return `<article class="list-item" data-workplace-id="${escapeHtml(workplace.id)}">
      <div class="title-line">
        <strong>${escapeHtml(workplace.name)}</strong>
        <span class="chip ${owner ? "ok" : ""}">${owner ? escapeHtml(owner.fullName) : "Свободно"}</span>
        <div class="row-actions">
          <button type="button" class="edit-button" data-action="edit-workplace" data-workplace-id="${escapeHtml(workplace.id)}">Изменить</button>
          <button type="button" class="danger-button" data-action="delete-workplace" data-workplace-id="${escapeHtml(workplace.id)}">Удалить</button>
        </div>
      </div>
      <p class="muted">${workplace.site ? escapeHtml(workplace.site) + " · " : ""}${units} ед. · ${itemsText}</p>
    </article>`;
  }).join("");
}
```

на:

```js
function renderWorkplaces() {
  renderWorkplaceFormSelects();
  const listContainer = document.getElementById("workplacesList");
  const tabsContainer = document.getElementById("workplaceDeptTabs");
  if (!listContainer || !tabsContainer) return;

  if (!state.workplaces.length) {
    tabsContainer.innerHTML = "";
    listContainer.innerHTML = `<div class="empty-state"><p>Рабочих мест пока нет.</p><p class="muted">Создайте первое рабочее место, чтобы начать работу.</p></div>`;
    return;
  }

  const query = normalizeSearchValue(document.getElementById("workplaceSearchInput")?.value);

  // Отделы — в порядке state.departments (уже отсортированы сервером по
  // имени), плюс отделы, которых больше нет в справочнике, но за
  // которыми ещё числятся места (отдел удалили, место осталось).
  const departmentNames = state.departments.map((d) => d.name);
  state.workplaces.forEach((w) => {
    if (w.department && !departmentNames.includes(w.department)) departmentNames.push(w.department);
  });

  const groups = departmentNames.map((department) => {
    const all = state.workplaces.filter((w) => w.department === department);
    const matched = query ? all.filter((w) => workplaceMatchesQuery(w, query)) : all;
    return { department, all, matched };
  });

  if (workplaceExpandedDepts === null) {
    const firstWithResults = groups.find((g) => g.all.length)?.department;
    workplaceExpandedDepts = new Set(firstWithResults ? [firstWithResults] : []);
  }

  tabsContainer.innerHTML = renderWorkplaceDeptTabs(groups);

  const visibleGroups = groups.filter((g) => !workplaceActiveDept || g.department === workplaceActiveDept);
  const groupsWithResults = query ? visibleGroups.filter((g) => g.matched.length) : visibleGroups;

  if (query && !groupsWithResults.length) {
    listContainer.innerHTML = `<div class="empty-state"><p>По вашему запросу рабочие места не найдены.</p></div>`;
    return;
  }

  // При поиске отделы с совпадениями раскрываются автоматически (промпт
  // §13/§28); без поиска — используется набор, который крутит пользователь.
  const expandedForRender = query
    ? new Set(groupsWithResults.map((g) => g.department))
    : workplaceExpandedDepts;

  listContainer.innerHTML = visibleGroups
    .filter((group) => !query || group.matched.length)
    .map((group) => renderWorkplaceDeptGroup(group, {
      expanded: expandedForRender.has(group.department),
      rows: query ? group.matched : group.all,
    }))
    .join("");
}

function renderWorkplaceDeptTabs(groups) {
  const totalCount = groups.reduce((sum, g) => sum + g.all.length, 0);
  const allTab = `<button type="button" class="dept-tab${workplaceActiveDept ? "" : " active"}" data-dept="">Все отделы <span class="dept-tab-count">${totalCount}</span></button>`;
  const deptTabs = groups.map((g) =>
    `<button type="button" class="dept-tab${workplaceActiveDept === g.department ? " active" : ""}" data-dept="${escapeHtml(g.department)}">${escapeHtml(g.department)} <span class="dept-tab-count">${g.all.length}</span></button>`
  ).join("");
  return allTab + deptTabs;
}

function renderWorkplaceDeptGroup(group, { expanded, rows }) {
  const sortedRows = sortWorkplaceRows(rows, workplaceSortBy);
  const body = group.all.length
    ? `<div class="table-wrap wp-table-wrap">${renderWorkplaceTable(sortedRows)}</div><div class="wp-cards">${renderWorkplaceCards(sortedRows)}</div>`
    : `<div class="empty-state"><p>В этом отделе пока нет рабочих мест.</p></div>`;
  return `<div class="dept-group">
    <button type="button" class="dept-group-header" data-action="toggle-dept" data-department="${escapeHtml(group.department)}">
      <span class="dept-group-heading">
        <span class="dept-group-title">🏢 ${escapeHtml(group.department)}</span>
        <span class="dept-group-count">Рабочих мест: ${group.all.length}</span>
      </span>
      <span class="dept-group-caret">${expanded ? "▾" : "▸"}</span>
    </button>
    ${expanded ? `<div class="dept-group-body">${body}</div>` : ""}
  </div>`;
}

function renderWorkplaceTable(sortedRows) {
  return `<table class="emp-modern-table wp-table">
    <thead><tr>
      <th>Рабочее место</th>
      <th>Объект / локация</th>
      <th>Сотрудник</th>
      <th>Оборудование</th>
      <th></th>
    </tr></thead>
    <tbody>
      ${sortedRows.map(({ workplace, owner }) => {
        const items = getWorkplaceAssets(workplace.id);
        const status = getWorkplaceStatus(workplace.id);
        const equipmentText = items.length
          ? items.map(({ asset, allocation }) =>
              `${escapeHtml(asset.name)} <code>${escapeHtml(asset.inventoryNumber || "—")}</code>${allocation.quantity > 1 ? ` ×${allocation.quantity}` : ""}`
            ).join("<br>")
          : "Оборудование не назначено";
        return `<tr data-workplace-id="${escapeHtml(workplace.id)}">
          <td><strong>${escapeHtml(workplace.name)}</strong><br><code>${escapeHtml(workplace.code || "—")}</code></td>
          <td>${workplace.site ? `📍 ${escapeHtml(workplace.site)}` : "—"}</td>
          <td>${owner ? `👤 ${escapeHtml(owner.fullName)}${owner.position ? `<br><span class="muted">${escapeHtml(owner.position)}</span>` : ""}` : "👤 Свободно"}</td>
          <td>${equipmentText}<br><span class="chip ${status.tone}">${escapeHtml(status.label)}</span></td>
          <td class="row-actions">
            <button type="button" class="edit-button" data-action="edit-workplace" data-workplace-id="${escapeHtml(workplace.id)}">Изменить</button>
            <button type="button" class="danger-button" data-action="delete-workplace" data-workplace-id="${escapeHtml(workplace.id)}">Удалить</button>
          </td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>`;
}

function renderWorkplaceCards(sortedRows) {
  return sortedRows.map(({ workplace, owner }) => {
    const status = getWorkplaceStatus(workplace.id);
    return `<article class="wp-card" data-workplace-id="${escapeHtml(workplace.id)}">
      <div class="wp-card-title">🖥 ${escapeHtml(workplace.name)}</div>
      <code>${escapeHtml(workplace.code || "—")}</code>
      <div class="wp-card-row">${owner ? `👤 ${escapeHtml(owner.fullName)}` : "👤 Свободно"}</div>
      ${workplace.site ? `<div class="wp-card-row">📍 ${escapeHtml(workplace.site)}</div>` : ""}
      <div class="wp-card-row"><span class="chip ${status.tone}">${escapeHtml(status.label)}</span></div>
      <div class="wp-card-actions">
        <button type="button" class="edit-button" data-action="edit-workplace" data-workplace-id="${escapeHtml(workplace.id)}">Изменить</button>
        <button type="button" class="danger-button" data-action="delete-workplace" data-workplace-id="${escapeHtml(workplace.id)}">Удалить</button>
      </div>
    </article>`;
  }).join("");
}
```

- [ ] **Step 4: Обновить делегированные обработчики кликов**

В `app.js`, найти блок, оставленный Task 3 Step 6 (обработчик `workplaceCancelBtn`, за ним — два новых `change`-слушателя, за ним — старый обработчик кликов по `workplacesList`):

```js
  document.getElementById("workplaceCancelBtn")?.addEventListener("click", resetWorkplaceForm);
  document.getElementById("workplaceEmployeeSelect")?.addEventListener("change", (event) => {
    const form = document.getElementById("workplaceForm");
    const isEditing = Boolean(form?.elements.workplaceId.value);
    const departmentSelect = document.getElementById("workplaceDepartmentSelect");
    if (!departmentSelect || isEditing || departmentSelect.dataset.touched === "1") return;
    const employee = getEmployeeById(event.target.value);
    if (employee?.department) departmentSelect.value = employee.department;
  });
  document.getElementById("workplaceDepartmentSelect")?.addEventListener("change", (event) => {
    event.target.dataset.touched = "1";
  });
  document.getElementById("workplacesList")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const id = button.dataset.workplaceId;
    if (button.dataset.action === "edit-workplace") enterWorkplaceEditMode(id);
    if (button.dataset.action === "delete-workplace") deleteWorkplace(id);
  });
```

Заменить только последний обработчик (`workplacesList` click) и добавить перед ним три новых слушателя — сами слушатели `workplaceEmployeeSelect`/`workplaceDepartmentSelect` из Task 3 не трогать:

```js
  document.getElementById("workplaceCancelBtn")?.addEventListener("click", resetWorkplaceForm);
  document.getElementById("workplaceEmployeeSelect")?.addEventListener("change", (event) => {
    const form = document.getElementById("workplaceForm");
    const isEditing = Boolean(form?.elements.workplaceId.value);
    const departmentSelect = document.getElementById("workplaceDepartmentSelect");
    if (!departmentSelect || isEditing || departmentSelect.dataset.touched === "1") return;
    const employee = getEmployeeById(event.target.value);
    if (employee?.department) departmentSelect.value = employee.department;
  });
  document.getElementById("workplaceDepartmentSelect")?.addEventListener("change", (event) => {
    event.target.dataset.touched = "1";
  });
  document.getElementById("workplaceDeptTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-dept]");
    if (!button) return;
    workplaceActiveDept = button.dataset.dept || "";
    renderWorkplaces();
  });
  document.getElementById("workplaceSearchInput")?.addEventListener("input", debounce(renderWorkplaces));
  document.getElementById("workplaceSortSelect")?.addEventListener("change", (event) => {
    workplaceSortBy = event.target.value;
    renderWorkplaces();
  });
  document.getElementById("workplacesList")?.addEventListener("click", (event) => {
    const toggleButton = event.target.closest('[data-action="toggle-dept"]');
    if (toggleButton) {
      const department = toggleButton.dataset.department;
      if (workplaceExpandedDepts.has(department)) workplaceExpandedDepts.delete(department);
      else workplaceExpandedDepts.add(department);
      renderWorkplaces();
      return;
    }
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const id = button.dataset.workplaceId;
    if (button.dataset.action === "edit-workplace") enterWorkplaceEditMode(id);
    if (button.dataset.action === "delete-workplace") deleteWorkplace(id);
  });
```

- [ ] **Step 5: Уточнить текст подтверждения удаления**

Промпт (раздел 12) требует показывать название места в вопросе
подтверждения. В `app.js:2685-2698` заменить всю функцию `deleteWorkplace`:

```js
async function deleteWorkplace(workplaceId) {
  // Удалять место с техникой нельзя: записи о выдаче осиротеют, а
  // количество останется списанным с доступного остатка.
  const items = getWorkplaceAssets(workplaceId);
  if (items.length) {
    showToast(`На этом месте числится техника (${items.length} поз.). Сначала верните её на склад.`, "warning");
    return;
  }
  const confirmed = await showConfirm("Удалить рабочее место?");
  if (!confirmed) return;
  state.workplaces = state.workplaces.filter((w) => w.id !== workplaceId);
  await persist();
  renderWorkplaces();
}
```

на:

```js
async function deleteWorkplace(workplaceId) {
  // Удалять место с техникой нельзя: записи о выдаче осиротеют, а
  // количество останется списанным с доступного остатка.
  const workplace = getWorkplaceById(workplaceId);
  if (!workplace) return;
  const items = getWorkplaceAssets(workplaceId);
  if (items.length) {
    showToast(`На этом месте числится техника (${items.length} поз.). Сначала верните её на склад.`, "warning");
    return;
  }
  const confirmed = await showConfirm(`Вы действительно хотите удалить рабочее место «${workplace.name}»?`);
  if (!confirmed) return;
  state.workplaces = state.workplaces.filter((w) => w.id !== workplaceId);
  await persist();
  renderWorkplaces();
  showToast("Рабочее место удалено.", "success");
}
```

Кнопки диалога («Отмена» / «Удалить») уже используют нужный промптом
текст — это общий компонент `#confirmOverlay` (`index.html:1342-1346`),
менять не нужно. Тост показывается после `persist()` (как в
`handleDepartmentDelete`), а не до — удаление, в отличие от
создания/редактирования, не должно выглядеть завершённым, если
сохранение на сервере ещё не подтвердилось.

- [ ] **Step 6: Добавить CSS**

В конец `styles.css` (после `.held-item-meta { ... }`, текущая последняя строка файла) добавить:

```css
/* ─── РАБОЧИЕ МЕСТА: ГРУППЫ ПО ОТДЕЛАМ ───────────────────────── */
.wp-toolbar { display: flex; gap: 8px; align-items: center; }

.dept-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.dept-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-3);
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 600;
  padding: 7px 14px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.dept-tab:hover { border-color: var(--line-2); color: var(--text); }
.dept-tab.active { background: var(--brand-dim); border-color: rgba(59,130,246,0.35); color: var(--brand-light); }

.dept-tab-count {
  background: var(--surface-3);
  color: var(--text-3);
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 700;
}
.dept-tab.active .dept-tab-count { background: rgba(59,130,246,0.22); color: var(--brand-light); }

.dept-group {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.dept-group + .dept-group { margin-top: 12px; }

.dept-group-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: none;
  border: none;
  padding: 14px 16px;
  cursor: pointer;
  color: var(--text);
  text-align: left;
}
.dept-group-header:hover { background: var(--surface-2); }

.dept-group-heading { display: flex; align-items: center; gap: 12px; }
.dept-group-title { font-size: 13.5px; font-weight: 700; }
.dept-group-count { font-size: 12px; color: var(--text-2); }
.dept-group-caret { color: var(--text-3); font-size: 13px; }

.dept-group-body { border-top: 1px solid var(--line); }

.wp-table td { vertical-align: top; }
.wp-table code { font-family: var(--mono); font-size: 11.5px; color: var(--brand); }
```

- [ ] **Step 7: Ручная проверка через запущенное приложение**

Использовать skill `run` на тестовой копии базы:

1. Вкладки «Все отделы N» / «‹Отдел› N» показывают правильные счётчики (совпадают с реальным числом мест).
2. Клик по вкладке отдела фильтрует список до этого отдела; «Все отделы» возвращает полный список.
3. Отдел без рабочих мест виден в списке вкладок и в группах с текстом «В этом отделе пока нет рабочих мест.», счётчик 0.
4. Заголовок группы отдела сворачивает/разворачивает таблицу по клику.
5. Поиск по ФИО сотрудника, по инвентарному номеру техники и по названию места находит нужную строку и автоматически разворачивает соответствующий отдел; при пустом результате показывается «По вашему запросу рабочие места не найдены.».
6. Сортировка «По сотруднику» / «По локации» / «По кол-ву техники» меняет порядок строк во всех развёрнутых группах.
7. Статус техники — «🟢 Всё в порядке» для места без проблемной техники, «⚠ Требует проверки» для места, где есть актив в ремонте/списан/входит в «Требует внимания» на дашборде, «Оборудование не назначено» для пустого места.
8. Изменение отдела в форме редактирования переносит место в другую группу после сохранения.

- [ ] **Step 8: Commit**

```bash
git add index.html app.js styles.css
git commit -m "feat(workplaces): department-grouped list with tabs, search, sort, and equipment status"
```

---

## Task 5: Мобильная адаптация (карточки вместо таблицы)

**Files:**
- Modify: `styles.css`

**Interfaces:**
- Consumes: `.wp-table-wrap` / `.wp-cards` — уже отрисовываются parallel-структурой в Task 4's `renderWorkplaceDeptGroup` (оба блока всегда в DOM, CSS переключает видимость по ширине экрана).

- [ ] **Step 1: Добавить CSS для карточек и медиа-запрос**

В конец `styles.css` (после блока из Task 4) добавить:

```css
.wp-cards { display: none; }
.wp-card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r);
  padding: 14px;
}
.wp-card + .wp-card { margin-top: 10px; }
.wp-card-title { font-size: 13.5px; font-weight: 700; color: var(--text); margin-bottom: 2px; }
.wp-card code { font-family: var(--mono); font-size: 11.5px; color: var(--brand); }
.wp-card-row { font-size: 12.5px; color: var(--text-2); margin-top: 6px; }
.wp-card-actions { display: flex; gap: 8px; margin-top: 10px; }

@media (max-width: 720px) {
  .wp-table-wrap { display: none; }
  .wp-cards { display: block; padding: 10px; }
}
```

- [ ] **Step 2: Ручная проверка через запущенное приложение**

Через skill `run`, открыть раздел «Рабочие места» и сузить окно браузера до ≤720px (или использовать эмуляцию мобильного размера):

1. Таблица скрывается, вместо неё показываются карточки с теми же данными (название, код, сотрудник, объект/локация, статус техники, кнопки «Изменить»/«Удалить»).
2. Кнопки «Изменить»/«Удалить» на карточке работают так же, как в таблице (используют тот же делегированный обработчик на `#workplacesList`).
3. При возврате к широкому окну (>720px) карточки скрываются, возвращается таблица.

- [ ] **Step 3: Commit**

```bash
git add styles.css
git commit -m "feat(workplaces): mobile card view for the department-grouped list"
```

---

## Task 6: Финальная проверка по чек-листу промпта

**Files:** нет изменений кода — только верификация.

- [ ] **Step 1: Прогнать весь backend-набор тестов**

Run: `py -m pytest tests/ -v`
Expected: все PASS, без регрессий в остальных секциях (сотрудники, отделы, объекты, техника, движения, инвентаризация, аудит).

- [ ] **Step 2: Полный ручной прогон через skill `run`**

На тестовой копии базы (не на живой `%ProgramData%\Warehouse\warehouse.db`) пройти по чек-листу из `Промпт_Рабочие_места.md`, раздел 33:

- создание рабочего места (с отделом, сотрудником, объектом/локацией, комментарием);
- редактирование (смена названия, отдела, объекта, сотрудника, комментария);
- удаление (с подтверждением; блокировка, если на месте есть техника);
- назначение и снятие сотрудника (место остаётся «Свободно»);
- создание рабочего места без сотрудника («— свободно —»);
- смена отдела — место переезжает в другую группу;
- поиск (по названию, ФИО, коду, объекту/локации, инвентарному номеру техники) с автораскрытием;
- фильтрация по вкладке отдела;
- отображение пустых отделов (счётчик 0, текст-заглушка, отдел не скрыт);
- корректность счётчиков на вкладках;
- привязка и отображение техники на рабочем месте;
- корректное определение статуса техники (🟢/⚠/«не назначено»);
- обновление данных после каждой CRUD-операции без перезагрузки страницы;
- сохранение состояния после обновления страницы (F5);
- мобильная версия (карточки вместо таблицы);
- права доступа (пользователь с ролью viewer не может сохранять — проверить через `/api/state`, что попытка POST от viewer отклоняется);
- отсутствие дублей (тот же результат, что в Task 2, но теперь и через UI);
- отсутствие регрессий в разделах «Сотрудники», «Отделы», «Объекты», «Операции» (выдача/возврат на рабочее место по-прежнему работает), карточка сотрудника (блоки «На рабочем месте» / «Лично на руках»).

- [ ] **Step 3: Зафиксировать результат**

Если все пункты пройдены — задача считается завершённой, дополнительный коммит не требуется (Task 1-5 уже закоммичены). Если найдены расхождения — исправить их в соответствующей задаче выше и повторить релевантные шаги её тестирования перед тем, как считать план выполненным.
