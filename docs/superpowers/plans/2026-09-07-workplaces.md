# Рабочие места (столы) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Завести рабочее место (стол) как четвёртый тип получателя техники, чтобы смена сотрудника за столом не требовала перевыдачи каждой вещи.

**Architecture:** Новая таблица `workplaces` (название, текущий хозяин, объект) и колонка `asset_allocations.workplace_id`. Техника числится за столом; смена хозяина меняет одно поле и записей о выдаче не трогает. Сотрудник и его стол — разные получатели, иначе возврат от человека списал бы количество со стола.

**Tech Stack:** Python 3.12 + sqlite3 (сервер, миграции, pytest), браузерный JS без сборки (`app.js`, `asset_ops.js`), тесты JS на `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-07-workplaces-design.md`

## Global Constraints

- Запись о выдаче хранит **ровно одного** получателя: заполнено ровно одно из `employeeId` / `department` / `site` / `workplaceId`, остальные — пустая строка (у `employeeId` — `null`).
- Незаполненные поля получателя хранятся как **пустая строка**, а не `NULL` — единообразно с существующими `department` и `site`.
- Каждая миграция отвечает за одно изменение и идемпотентна; регистрируется в `MIGRATIONS` по возрастанию версии. Последняя существующая — 28.
- Комментарии и текст интерфейса — на русском, как во всём проекте.
- Python-тесты: `python -m pytest -q`. JS-тесты: `node --test mobile/tests/*.test.js tests/*.test.js`.
- Файл `_tmp_state.json` в корне репозитория — временный для браузерной проверки, **никогда не коммитить**.

---

### Task 1: Миграции схемы

**Files:**
- Modify: `migrations.py` (добавить две функции перед `MIGRATIONS`, зарегистрировать в списке после строки `(28, ...)`)
- Modify: `schema.sql` (держится в синхроне с миграциями — см. шапку файла)
- Test: `tests/test_migration_workplaces.py`

**Interfaces:**
- Produces: таблица `workplaces (id TEXT PK, name TEXT NOT NULL, employee_id TEXT, site TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '')`; колонка `asset_allocations.workplace_id TEXT NOT NULL DEFAULT ''`.

- [ ] **Step 1: Написать падающие тесты**

Создать `tests/test_migration_workplaces.py`:

```python
"""Тесты миграций рабочих мест (029 и 030)."""

import sqlite3

import pytest

import migrations


ALLOC_SCHEMA = """
CREATE TABLE asset_allocations (
  asset_id TEXT NOT NULL,
  employee_id TEXT,
  department TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 0
);
"""


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    yield connection
    connection.close()


def columns(connection, table):
    return {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}


def test_029_creates_workplaces_table(conn):
    migrations._migrate_029_workplaces_table(conn)
    assert columns(conn, "workplaces") == {"id", "name", "employee_id", "site", "notes"}


def test_029_is_idempotent(conn):
    migrations._migrate_029_workplaces_table(conn)
    conn.execute("INSERT INTO workplaces (id, name) VALUES ('w1', 'Стол 2')")
    migrations._migrate_029_workplaces_table(conn)
    assert conn.execute("SELECT COUNT(*) FROM workplaces").fetchone()[0] == 1


def test_030_adds_workplace_id_column(conn):
    conn.executescript(ALLOC_SCHEMA)
    migrations._migrate_030_allocation_workplace(conn)
    assert "workplace_id" in columns(conn, "asset_allocations")


def test_030_defaults_existing_rows_to_empty_string(conn):
    # Пустая строка, а не NULL: правило «заполнено ровно одно поле»
    # проверяется у всех получателей единообразно.
    conn.executescript(ALLOC_SCHEMA)
    conn.execute("INSERT INTO asset_allocations (asset_id, employee_id, quantity) VALUES ('a1', 'emp_1', 2)")
    migrations._migrate_030_allocation_workplace(conn)
    row = conn.execute("SELECT employee_id, workplace_id FROM asset_allocations").fetchone()
    assert (row["employee_id"], row["workplace_id"]) == ("emp_1", "")


def test_030_is_idempotent(conn):
    conn.executescript(ALLOC_SCHEMA)
    migrations._migrate_030_allocation_workplace(conn)
    migrations._migrate_030_allocation_workplace(conn)
    assert "workplace_id" in columns(conn, "asset_allocations")


def test_030_skips_database_without_allocations_table(conn):
    # Самая старая база: таблицы выдач ещё нет. Миграция 015 создаёт её
    # позже, падать здесь нельзя.
    migrations._migrate_030_allocation_workplace(conn)
    assert "asset_allocations" not in {
        row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def test_031_adds_workplace_id_to_movements(conn):
    conn.executescript(
        "CREATE TABLE movements (id TEXT PRIMARY KEY, type TEXT NOT NULL, asset_id TEXT NOT NULL,"
        " employee_id TEXT, department TEXT NOT NULL DEFAULT '', site TEXT NOT NULL DEFAULT '',"
        " quantity INTEGER NOT NULL DEFAULT 0, date TEXT NOT NULL);"
    )
    migrations._migrate_031_movement_workplace(conn)
    assert "workplace_id" in columns(conn, "movements")


def test_all_three_registered_in_order():
    versions = [version for version, _name, _func in migrations.MIGRATIONS]
    assert {29, 30, 31} <= set(versions)
    assert versions == sorted(versions)
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

Run: `python -m pytest tests/test_migration_workplaces.py -q`
Expected: FAIL — `AttributeError: module 'migrations' has no attribute '_migrate_029_workplaces_table'`

- [ ] **Step 3: Реализовать миграции**

В `migrations.py` перед объявлением `MIGRATIONS` добавить:

```python
def _migrate_029_workplaces_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS workplaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          employee_id TEXT REFERENCES employees(id),
          site TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT ''
        )
        """
    )


def _migrate_030_allocation_workplace(connection: sqlite3.Connection) -> None:
    # Таблицы выдач может ещё не быть: её создаёт миграция 015 при
    # переносе старой базы. Проверка та же, что в 015 и 016.
    table = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='asset_allocations'"
    ).fetchone()
    if table is None:
        return
    _add_column_if_missing(
        connection, "asset_allocations", "workplace_id",
        "workplace_id TEXT NOT NULL DEFAULT ''",
    )
```

Движению тоже нужна своя колонка. Без неё выдача на стол в истории
покажется как «Склад»: `movements` хранит получателя в `employee_id`,
`department` и `site`, и записать туда стол текстом значило бы загрязнить
фильтрацию по объектам.

```python
def _migrate_031_movement_workplace(c):
    _add_column_if_missing(c, "movements", "workplace_id", "workplace_id TEXT NOT NULL DEFAULT ''")
```

В списке `MIGRATIONS` после строки `(28, ...)` добавить:

```python
    (29, "workplaces table", _migrate_029_workplaces_table),
    (30, "asset_allocations.workplace_id", _migrate_030_allocation_workplace),
    (31, "movements.workplace_id", _migrate_031_movement_workplace),
```

- [ ] **Step 4: Запустить тесты и убедиться, что проходят**

Run: `python -m pytest tests/test_migration_workplaces.py -q`
Expected: PASS, 8 passed

- [ ] **Step 5: Обновить `schema.sql`**

Шапка файла требует держать его в синхроне с миграциями. Добавить в конец:

```sql
CREATE TABLE IF NOT EXISTS workplaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  employee_id TEXT REFERENCES employees(id),
  site TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);
```

И в объявлении `asset_allocations` добавить строку `workplace_id TEXT NOT NULL DEFAULT '',` после `site`.

- [ ] **Step 6: Прогнать весь набор Python-тестов**

Run: `python -m pytest -q`
Expected: PASS — ни один существующий тест не сломан.

- [ ] **Step 7: Коммит**

```bash
git add migrations.py schema.sql tests/test_migration_workplaces.py
git commit -m "feat(workplaces): таблица рабочих мест и колонка выдачи"
```

---

### Task 2: Рабочие места в состоянии сервера

**Files:**
- Modify: `server.py:529-531` (запрос `sites` — рядом добавить `workplaces`), `server.py:533-539` (экспорт выдач), `server.py:597` (словарь ответа), `server.py:625` (чтение payload), `server.py:660` (очистка таблиц), `server.py:683-686` (вставка `sites` — рядом вставка `workplaces`), `server.py:751-753` (вставка выдач)
- Test: `tests/test_server_workplaces.py`

**Interfaces:**
- Consumes: таблица `workplaces` и колонка `workplace_id` из Task 1.
- Produces: `GET /api/state` отдаёт `workplaces: [{id, name, employeeId, site, notes}]`, а каждая запись в `assets[].allocations` получает поле `workplaceId`. `import_state` принимает то же самое обратно.

- [ ] **Step 1: Написать падающие тесты**

Создать `tests/test_server_workplaces.py`:

```python
from pathlib import Path

import pytest

import server


@pytest.fixture
def db(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setattr(server, "DB_PATH", db_path)
    server.init_db()
    yield db_path


BASE_PAYLOAD = {
    "meta": {"updatedAt": "2026-09-07T00:00:00Z"},
    "employees": [], "departments": [], "sites": [], "assets": [], "movements": [],
    "auditLog": [], "kitTemplates": [], "workplaces": [],
}


def payload(**overrides):
    data = {key: list(value) if isinstance(value, list) else value for key, value in BASE_PAYLOAD.items()}
    data.update(overrides)
    return data


def test_empty_state_has_workplaces_list(db):
    assert server.export_state()["workplaces"] == []


def test_workplace_round_trip(db):
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Цой Марина"}],
        workplaces=[{"id": "w1", "name": "Стол 2", "employeeId": "emp_1", "site": "АБЗ", "notes": "у окна"}],
    ), actor="tester")
    saved = server.export_state()["workplaces"]
    assert saved == [{"id": "w1", "name": "Стол 2", "employeeId": "emp_1", "site": "АБЗ", "notes": "у окна"}]


def test_workplace_without_occupant_is_allowed(db):
    # Свободный стол — нормальное состояние, а не ошибка.
    server.import_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 3", "employeeId": None, "site": "", "notes": ""}],
    ), actor="tester")
    assert server.export_state()["workplaces"][0]["employeeId"] is None


def test_allocation_carries_workplace_id(db):
    server.import_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 2"}],
        assets=[{
            "id": "a1", "name": "Монитор", "quantity": 1,
            "allocations": [{"employeeId": None, "department": "", "site": "", "workplaceId": "w1", "quantity": 1}],
        }],
    ), actor="tester")
    allocation = server.export_state()["assets"][0]["allocations"][0]
    assert allocation["workplaceId"] == "w1"
    assert allocation["employeeId"] is None


def test_employee_allocation_has_empty_workplace_id(db):
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Цой Марина"}],
        assets=[{
            "id": "a1", "name": "Ноутбук", "quantity": 1,
            "allocations": [{"employeeId": "emp_1", "department": "", "site": "", "quantity": 1}],
        }],
    ), actor="tester")
    allocation = server.export_state()["assets"][0]["allocations"][0]
    assert (allocation["employeeId"], allocation["workplaceId"]) == ("emp_1", "")


def test_deleting_employee_keeps_the_workplace(db):
    # Стол переживает своего хозяина: техника на нём остаётся.
    server.import_state(payload(
        employees=[{"id": "emp_1", "fullName": "Цой Марина"}],
        workplaces=[{"id": "w1", "name": "Стол 2", "employeeId": "emp_1"}],
    ), actor="tester")
    server.import_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 2", "employeeId": None}],
    ), actor="tester")
    assert server.export_state()["workplaces"][0]["name"] == "Стол 2"
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

Run: `python -m pytest tests/test_server_workplaces.py -q`
Expected: FAIL — `KeyError: 'workplaces'`

- [ ] **Step 3: Реализовать экспорт**

В `export_state()` рядом с запросом `sites` (`server.py:529`) добавить:

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

Запрос выдач (`server.py:535`) дополнить колонкой:

```python
            "SELECT asset_id, employee_id, department, site, workplace_id, quantity FROM asset_allocations WHERE quantity > 0 ORDER BY asset_id, employee_id, department, site"
```

и словарь записи:

```python
                {"employeeId": row["employee_id"], "department": row["department"] or "", "site": row["site"] or "", "workplaceId": row["workplace_id"] or "", "quantity": row["quantity"]}
```

В возвращаемый словарь (`server.py:597`, рядом со `"sites": sites,`) добавить `"workplaces": workplaces,`.

- [ ] **Step 4: Реализовать импорт**

В `import_state()`: после `sites = payload.get("sites", [])` (`server.py:625`) добавить

```python
    workplaces = payload.get("workplaces", [])
```

После `connection.execute("DELETE FROM sites")` (`server.py:660`) добавить

```python
        connection.execute("DELETE FROM workplaces")
```

После цикла вставки `sites` (`server.py:683-686`) добавить:

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

Вставку выдач (`server.py:750-753`) заменить на:

```python
                connection.execute(
                    "INSERT INTO asset_allocations (asset_id, employee_id, department, site, workplace_id, quantity) VALUES (?, ?, ?, ?, ?, ?)",
                    (asset.get("id"), allocation.get("employeeId") or None, allocation.get("department") or "", allocation.get("site") or "", allocation.get("workplaceId") or "", quantity),
                )
```

- [ ] **Step 5: Провести стол через движения**

Движение выдачи на стол должно помнить, куда ушла техника, иначе история
покажет «Склад». Запрос движений в `export_state()` дополнить колонкой
`workplace_id`, а словарь записи — полем `"workplaceId"`. Вставку в
`import_state()` заменить на:

```python
            connection.execute(
                "INSERT INTO movements (id, type, asset_id, employee_id, department, site, workplace_id, act_number, quantity, date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    movement.get("id"), movement.get("type"), movement.get("assetId"),
                    movement.get("employeeId") or None, movement.get("department") or "",
                    movement.get("site") or "", movement.get("workplaceId") or "",
                    movement.get("actNumber"), int(movement.get("quantity") or 0),
                    movement.get("date") or "", movement.get("notes") or "",
                ),
            )
```

Добавить тест в `tests/test_server_workplaces.py`:

```python
def test_movement_carries_workplace_id(db):
    server.import_state(payload(
        workplaces=[{"id": "w1", "name": "Стол 2"}],
        assets=[{"id": "a1", "name": "Монитор", "quantity": 1, "allocations": []}],
        movements=[{"id": "m1", "type": "issue", "assetId": "a1", "workplaceId": "w1",
                    "quantity": 1, "date": "2026-09-07"}],
    ), actor="tester")
    assert server.export_state()["movements"][0]["workplaceId"] == "w1"
```

- [ ] **Step 6: Запустить тесты и убедиться, что проходят**

Run: `python -m pytest tests/test_server_workplaces.py -q`
Expected: PASS, 7 passed

- [ ] **Step 7: Прогнать весь набор Python-тестов**

Run: `python -m pytest -q`
Expected: PASS

- [ ] **Step 8: Коммит**

```bash
git add server.py tests/test_server_workplaces.py
git commit -m "feat(workplaces): рабочие места в состоянии сервера"
```

---

### Task 3: Четвёртый получатель в mergeAllocation

**Files:**
- Modify: `asset_ops.js` (функции `matches` и `mergeAllocation`)
- Test: `tests/asset_ops.test.js` (дописать блок в конец)

**Interfaces:**
- Consumes: ничего из предыдущих задач (чистая функция).
- Produces: `mergeAllocation(allocations, { employeeId, department, site, workplaceId, quantity })` — четвёртый ключ `workplaceId`. Созданная запись всегда содержит все четыре поля: `{ employeeId, department, site, workplaceId, quantity }`.

- [ ] **Step 1: Написать падающие тесты**

Дописать в конец `tests/asset_ops.test.js`:

```javascript

// ─── выдача на рабочее место ─────────────────────────────────────

test('первая выдача на рабочее место заводит новую запись', () => {
  const allocations = [];
  mergeAllocation(allocations, { workplaceId: 'w1', quantity: 1 });
  assert.deepEqual(allocations, [{ employeeId: null, department: '', site: '', workplaceId: 'w1', quantity: 1 }]);
});

test('повторная выдача на тот же стол увеличивает существующую запись', () => {
  const allocations = [{ employeeId: null, department: '', site: '', workplaceId: 'w1', quantity: 1 }];
  mergeAllocation(allocations, { workplaceId: 'w1', quantity: 2 });
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0].quantity, 3);
});

test('разные столы не сливаются', () => {
  const allocations = [{ employeeId: null, department: '', site: '', workplaceId: 'w1', quantity: 1 }];
  mergeAllocation(allocations, { workplaceId: 'w2', quantity: 1 });
  assert.equal(allocations.length, 2);
});

test('выдача сотруднику не вливается в запись его стола', () => {
  // Сотрудник и стол, за которым он сидит, — разные получатели: иначе
  // возврат от человека списал бы количество со стола.
  const allocations = [{ employeeId: null, department: '', site: '', workplaceId: 'w1', quantity: 1 }];
  mergeAllocation(allocations, { employeeId: 'emp_1', quantity: 1 });
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].quantity, 1, 'запись стола не должна меняться');
});

test('выдача на стол не вливается в запись сотрудника', () => {
  const allocations = [{ employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 2 }];
  mergeAllocation(allocations, { workplaceId: 'w1', quantity: 1 });
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].quantity, 2);
});

test('выдача на стол не вливается в запись отдела', () => {
  const allocations = [{ employeeId: null, department: 'Бухгалтерия', site: '', workplaceId: '', quantity: 4 }];
  mergeAllocation(allocations, { workplaceId: 'w1', quantity: 1 });
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].quantity, 4);
});

test('выдача на стол не вливается в запись объекта', () => {
  const allocations = [{ employeeId: null, department: '', site: 'АБЗ', workplaceId: '', quantity: 3 }];
  mergeAllocation(allocations, { workplaceId: 'w1', quantity: 1 });
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].quantity, 3);
});

test('старая запись без поля workplaceId считается записью сотрудника', () => {
  // Записи, пришедшие из базы до миграции 030, поля не имеют вовсе.
  const allocations = [{ employeeId: 'emp_1', department: '', site: '', quantity: 2 }];
  mergeAllocation(allocations, { employeeId: 'emp_1', quantity: 1 });
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0].quantity, 3);
});

test('выдача на стол без указанного стола отклоняется', () => {
  assert.throws(() => mergeAllocation([], { workplaceId: '', quantity: 1 }), /получател/i);
});

test('запись сотрудника создаётся с пустым workplaceId', () => {
  const allocations = [];
  mergeAllocation(allocations, { employeeId: 'emp_1', quantity: 1 });
  assert.equal(allocations[0].workplaceId, '');
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

Run: `node --test tests/asset_ops.test.js`
Expected: FAIL — 10 новых тестов падают, существующие 31 проходят.

- [ ] **Step 3: Реализовать четвёртого получателя**

В `asset_ops.js` заменить `matches` и тело `mergeAllocation`:

```javascript
function matches(entry, employeeId, department, site, workplaceId) {
  if (employeeId) return entry.employeeId === employeeId && !entry.department && !entry.site && !entry.workplaceId;
  if (department) return !entry.employeeId && !entry.site && !entry.workplaceId && entry.department === department;
  if (site) return !entry.employeeId && !entry.department && !entry.workplaceId && entry.site === site;
  return !entry.employeeId && !entry.department && !entry.site && entry.workplaceId === workplaceId;
}
```

В `mergeAllocation` изменить сигнатуру, проверку получателя, поиск и создаваемую запись:

```javascript
function mergeAllocation(allocations, { employeeId = null, department = '', site = '', workplaceId = '', quantity } = {}) {
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 1) {
    throw new TypeError(`Количество к выдаче должно быть целым числом от 1, получено: ${quantity}`);
  }
  if (!employeeId && !department && !site && !workplaceId) {
    throw new TypeError('Не указан получатель выдачи: сотрудник, отдел, объект или рабочее место.');
  }

  const existing = allocations.find((entry) => matches(entry, employeeId, department, site, workplaceId));
  if (existing) {
    existing.quantity += quantity;
    return existing;
  }
  const entry = {
    employeeId: employeeId || null,
    department: employeeId ? '' : department,
    site: employeeId || department ? '' : site,
    workplaceId: employeeId || department || site ? '' : workplaceId,
    quantity,
  };
  allocations.push(entry);
  return entry;
}
```

- [ ] **Step 4: Запустить тесты и убедиться, что проходят**

Run: `node --test tests/asset_ops.test.js`
Expected: PASS, 41 passed

- [ ] **Step 5: Коммит**

```bash
git add asset_ops.js tests/asset_ops.test.js
git commit -m "feat(workplaces): рабочее место как четвёртый получатель выдачи"
```

---

### Task 4: Возврат из ремонта через mergeAllocation

**Files:**
- Modify: `app.js:3689-3693` (ветка `target.type === "employee"` в обработчике возврата из ремонта)

**Interfaces:**
- Consumes: `mergeAllocation` с четырьмя получателями из Task 3.
- Produces: ничего нового; убирает второе, расходящееся определение формы записи.

- [ ] **Step 1: Найти место**

Run: `grep -n 'asset.allocations.push({ employeeId: target.employeeId, quantity })' app.js`
Expected: одна строка (~3692).

Проблема: запись создаётся вручную и **без полей** `department`, `site`, `workplaceId` — формы, отличной от той, что создаёт `mergeAllocation`. С четвёртым получателем такой разнобой опасен.

- [ ] **Step 2: Заменить на общую функцию**

Заменить:

```javascript
  if (target.type === "employee") {
    const existing = getEmployeeAllocation(asset, target.employeeId);
    if (existing) existing.quantity += quantity;
    else asset.allocations.push({ employeeId: target.employeeId, quantity });
  }
```

на:

```javascript
  if (target.type === "employee") {
    // Через общую функцию, а не вручную: иначе здесь появляется второе
    // определение формы записи о выдаче — эта ветка создавала её без
    // полей department, site и workplaceId.
    AssetOps.mergeAllocation(asset.allocations, { employeeId: target.employeeId, quantity });
  }
```

- [ ] **Step 3: Проверить синтаксис**

Run: `node --check app.js`
Expected: без вывода.

- [ ] **Step 4: Проверить в браузере**

Поднять статику и прогнать возврат из ремонта на реальных данных:

```bash
cp "$SCRATCH/full_payload.json" ./_tmp_state.json
python -m http.server 8790 --bind 127.0.0.1 --directory /d/warehouse &
```

В консоли страницы: загрузить состояние, отправить технику в ремонт, вернуть её сотруднику, проверить, что запись о выдаче содержит все четыре поля получателя и что количество не задвоилось.

Удалить `_tmp_state.json` и остановить сервер после проверки.

- [ ] **Step 5: Коммит**

```bash
git add app.js
git commit -m "refactor(operations): возврат из ремонта через mergeAllocation"
```

---

### Task 5: Состояние и справочники рабочих мест в app.js

**Files:**
- Modify: `app.js:1-13` (`EMPTY_STATE`), `app.js:~366` (`hydrateState`), `app.js:576-583` (`allocationLabel`), рядом с `getSiteAllocation` (добавить `getWorkplaceAllocation`)

**Interfaces:**
- Consumes: `workplaces` из состояния сервера (Task 2).
- Produces: `state.workplaces` — массив `{id, name, employeeId, site, notes}`; `getWorkplaceById(id)`; `getWorkplaceAllocation(asset, workplaceId)`; `getEmployeeWorkplace(employeeId)`; `allocationLabel` понимает записи стола.

- [ ] **Step 1: Добавить рабочие места в состояние**

В `EMPTY_STATE` (`app.js:1`) после `sites: [],` добавить `workplaces: [],`.

В `hydrateState` после блока `sites:` добавить:

```javascript
    workplaces: (parsed.workplaces || []).map((entry) => ({
      id: entry.id,
      name: entry.name || "",
      employeeId: entry.employeeId || null,
      site: entry.site || "",
      notes: entry.notes || "",
    })),
```

- [ ] **Step 2: Сохранить workplaceId при нормализации активов**

Без этой правки записи выдач на столы уничтожаются. `normalizeAsset`
(`app.js:324-332`) пересобирает каждую запись из четырёх полей и
отфильтровывает те, где не заполнен ни сотрудник, ни отдел, ни объект —
то есть выбрасывает все записи столов при загрузке, а следующее
сохранение стирает их в базе.

Заменить блок `allocations:` в `normalizeAsset` на:

```javascript
    allocations: Array.isArray(asset.allocations)
      ? asset.allocations
          .map((entry) => ({
            employeeId: entry.employeeId || null,
            department: entry.department || "",
            site: entry.site || "",
            workplaceId: entry.workplaceId || "",
            quantity: Math.max(0, Number(entry.quantity || 0)),
          }))
          .filter((entry) => (entry.employeeId || entry.department || entry.site || entry.workplaceId) && entry.quantity > 0)
```

- [ ] **Step 3: Добавить справочные функции**

Рядом с `getSiteAllocation` добавить:

```javascript
function getWorkplaceById(workplaceId) {
  return state.workplaces.find((workplace) => workplace.id === workplaceId) || null;
}

// Стол, за которым закреплён сотрудник. У стола один хозяин, поэтому
// первое совпадение и есть ответ.
function getEmployeeWorkplace(employeeId) {
  if (!employeeId) return null;
  return state.workplaces.find((workplace) => workplace.employeeId === employeeId) || null;
}

function getWorkplaceAllocation(asset, workplaceId) {
  if (!workplaceId) return null;
  return asset.allocations.find(
    (entry) => !entry.employeeId && !entry.department && !entry.site && entry.workplaceId === workplaceId
  ) || null;
}
```

- [ ] **Step 4: Научить allocationLabel записям стола**

Заменить `allocationLabel` (`app.js:576`):

```javascript
function allocationLabel(entry) {
  if (entry.employeeId) {
    const employee = getEmployeeById(entry.employeeId);
    return employee ? employee.fullName : "Неизвестный сотрудник";
  }
  if (entry.workplaceId) {
    const workplace = getWorkplaceById(entry.workplaceId);
    if (!workplace) return "Место удалено";
    const owner = workplace.employeeId ? getEmployeeById(workplace.employeeId) : null;
    return owner ? `Место: ${workplace.name} · ${owner.fullName}` : `Место: ${workplace.name}`;
  }
  if (entry.site) return `Объект: ${entry.site}`;
  return entry.department ? `Отдел: ${entry.department}` : "Неизвестно";
}
```

Порядок веток значим: стол проверяется до объекта, потому что у записи стола `site` пуст, но обратный порядок сделал бы код хрупким при появлении новых получателей.

- [ ] **Step 5: Проверить синтаксис**

Run: `node --check app.js`
Expected: без вывода.

- [ ] **Step 6: Коммит**

```bash
git add app.js
git commit -m "feat(workplaces): рабочие места в состоянии клиента"
```

---

### Task 6: Экран «Рабочие места»

**Files:**
- Modify: `index.html` (пункт меню после `data-view="sites"` — `index.html:55`; новая секция `<section id="workplaces" class="view">` после секции `#sites`, которая заканчивается около `index.html:700`)
- Modify: `app.js` (`VIEW_RENDERERS` — `app.js:192`; функции экрана; обработчики в `bindEvents`)

**Interfaces:**
- Consumes: `state.workplaces`, `getWorkplaceAllocation`, `allocationLabel` из Task 5.
- Produces: `renderWorkplaces()`, `handleWorkplaceSubmit(event)`, `deleteWorkplace(id)`, `reassignWorkplace(id, employeeId)`.

- [ ] **Step 1: Разметка**

В боковом меню после кнопки `data-view="sites"` добавить:

```html
        <button class="menu-link" data-view="workplaces">
          <svg width="17" height="17" viewBox="0 0 16 16" fill="none"><path d="M2 6.5h12M3.5 6.5V4a1 1 0 011-1h7a1 1 0 011 1v2.5M4.5 6.5v6M11.5 6.5v6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Рабочие места
        </button>
```

После закрывающего тега секции `#sites` добавить секцию по образцу `#sites`:

```html
      <section id="workplaces" class="view">
        <div class="panel form-panel">
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
        </div>
        <div class="panel">
          <div class="panel-header">
            <h3>Рабочие места</h3>
          </div>
          <div id="workplacesList" class="list"></div>
        </div>
      </section>
```

- [ ] **Step 2: Отрисовка списка**

В `app.js` добавить:

```javascript
// Техника, числящаяся за столом.
function getWorkplaceAssets(workplaceId) {
  return state.assets
    .map((asset) => ({ asset, allocation: getWorkplaceAllocation(asset, workplaceId) }))
    .filter((entry) => entry.allocation && entry.allocation.quantity > 0);
}

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

Зарегистрировать в `VIEW_RENDERERS` (`app.js:192`): `workplaces: () => { renderWorkplaces(); },`

- [ ] **Step 3: Сохранение и удаление**

```javascript
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

- [ ] **Step 4: Обработчики**

В `bindEvents` рядом с обработчиками объектов добавить:

```javascript
  document.getElementById("workplaceForm")?.addEventListener("submit", handleWorkplaceSubmit);
  document.getElementById("workplaceCancelBtn")?.addEventListener("click", resetWorkplaceForm);
  document.getElementById("workplacesList")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const id = button.dataset.workplaceId;
    if (button.dataset.action === "edit-workplace") enterWorkplaceEditMode(id);
    if (button.dataset.action === "delete-workplace") deleteWorkplace(id);
  });
```

- [ ] **Step 5: Освобождать стол при удалении сотрудника**

Спека требует: стол переживает своего хозяина. В `deleteEmployee`
(`app.js:3268`) после строки `state.employees = state.employees.filter(...)`
добавить:

```javascript
  // Стол остаётся, освобождается только хозяин: техника на нём не
  // принадлежала сотруднику и возврата не требует. Личная техника
  // удалить сотрудника и так не даёт (проверка выше).
  state.workplaces.forEach((workplace) => {
    if (workplace.employeeId === employeeId) workplace.employeeId = null;
  });
```

- [ ] **Step 6: Проверить в браузере**

Поднять статику, открыть «Рабочие места», завести стол, назначить хозяина,
убедиться что список показывает хозяина и «Техники нет». Затем удалить
этого сотрудника и убедиться, что стол остался и стал «Свободно».
Проверить, что удаление места с техникой отклоняется с подсказкой.

- [ ] **Step 7: Коммит**

```bash
git add index.html app.js
git commit -m "feat(workplaces): экран рабочих мест"
```

---

### Task 7: Рабочее место в окнах выдачи и возврата

**Files:**
- Modify: `index.html` (переключатели и поля в `#issueModal`, `#returnModal`, блок «Выдать сразу»)
- Modify: `app.js` (`getOperationPool`, `renderSelects`, `handleIssueSubmit`, `handleReturnSubmit`, `readAssetIssueRequest`, `issueAssetOnCreate`, обработчики переключателей)

**Interfaces:**
- Consumes: `mergeAllocation` с `workplaceId` (Task 3), `getWorkplaceAllocation` и `getWorkplaceById` (Task 5).
- Produces: выдача и возврат на рабочее место в трёх точках — окно выдачи, окно возврата, блок «Выдать сразу».

- [ ] **Step 1: Разметка — окно выдачи**

В `#issueModal` после варианта «На объект» добавить:

```html
          <label style="display:flex;gap:6px;align-items:center;cursor:pointer">
            <input type="radio" name="issueTarget" value="workplace"> На рабочее место
          </label>
```

После `<label id="issueSiteField" ...>` добавить:

```html
        <label id="issueWorkplaceField" style="display:none">Рабочее место<select name="workplaceId" id="issueWorkplaceSelect"></select></label>
```

- [ ] **Step 2: Разметка — окно возврата**

В `#returnModal` после варианта «На объект» добавить:

```html
          <label style="display:flex;gap:6px;align-items:center;cursor:pointer">
            <input type="radio" name="returnTarget" value="workplace"> С рабочего места
          </label>
```

После `<label id="returnSiteField" ...>` добавить:

```html
        <label id="returnWorkplaceField" style="display:none">Рабочее место<select name="workplaceId" id="returnWorkplaceSelect"></select></label>
```

- [ ] **Step 3: Разметка — блок «Выдать сразу»**

В `#assetIssueFields` после варианта «На объект» добавить:

```html
                  <label><input type="radio" name="assetIssueTarget" value="workplace"> На рабочее место</label>
```

И четвёртое поле рядом с `assetIssueSiteField`:

```html
                  <label class="form-field hidden" id="assetIssueWorkplaceField">
                    <span class="form-label">Рабочее место</span>
                    <span class="field">
                      <span class="field-icon"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2 6.5h12M3.5 6.5V4a1 1 0 011-1h7a1 1 0 011 1v2.5M4.5 6.5v6M11.5 6.5v6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
                      <select id="assetIssueWorkplaceSelect"></select>
                    </span>
                  </label>
```

- [ ] **Step 4: Пул позиций для возврата со стола**

В `getOperationPool`, в ветке возврата перед строкой с `dom.returnEmployeeSelect`, добавить:

```javascript
  if (target === "workplace") {
    const workplaceId = document.getElementById("returnWorkplaceSelect")?.value || "";
    return {
      assets: state.assets.filter((asset) => (getWorkplaceAllocation(asset, workplaceId)?.quantity || 0) > 0),
      quantity: (asset) => getWorkplaceAllocation(asset, workplaceId)?.quantity || 0,
      label: "на месте",
    };
  }
```

- [ ] **Step 5: Наполнение списков рабочих мест**

В `renderSelects` добавить:

```javascript
  // Стол показывается вместе с хозяином: «Стол 2 — Цой Марина».
  const workplaceOptions = `<option value="">— выберите место —</option>`
    + state.workplaces.map((workplace) => {
      const owner = workplace.employeeId ? getEmployeeById(workplace.employeeId) : null;
      const label = owner ? `${workplace.name} — ${owner.fullName}` : workplace.name;
      return `<option value="${escapeHtml(workplace.id)}">${escapeHtml(label)}</option>`;
    }).join("");
  ["issueWorkplaceSelect", "returnWorkplaceSelect", "assetIssueWorkplaceSelect"].forEach((id) => {
    const select = document.getElementById(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = workplaceOptions;
    select.value = current;
  });
```

- [ ] **Step 6: Выдача на рабочее место**

В `handleIssueSubmit` после чтения `siteName` добавить:

```javascript
  const workplaceId = target === "workplace" ? String(formData.get("workplaceId") || "") : "";
  if (target === "workplace" && !workplaceId) {
    showToast('Выберите рабочее место.', 'warning');
    return;
  }
```

Вызов `mergeAllocation` дополнить ключом:

```javascript
    AssetOps.mergeAllocation(asset.allocations, { employeeId, department: departmentName, site: siteName, workplaceId, quantity });
```

Движение выдачи тоже получает стол:

```javascript
    addMovement({ type: "issue", assetId: asset.id, employeeId: employeeId || null, department: departmentName, site: siteName, workplaceId, actNumber, quantity, date: formData.get("date") || today(), notes: String(formData.get("notes") || "").trim() });
```

- [ ] **Step 7: Возврат с рабочего места**

В `handleReturnSubmit` добавить чтение и проверку `workplaceId` теми же пятью строками, что в Step 6 (с `returnTarget` вместо `issueTarget`). Функцию `findAlloc` дополнить веткой стола:

```javascript
  const findAlloc = (asset) => {
    if (employeeId) return getEmployeeAllocation(asset, employeeId);
    if (workplaceId) return getWorkplaceAllocation(asset, workplaceId);
    if (siteName) return getSiteAllocation(asset, siteName);
    return getDepartmentAllocation(asset, departmentName);
  };
```

Подпись получателя в сообщении об ошибке:

```javascript
    const ownerLabel = employeeId ? "сотрудника"
      : workplaceId ? `места «${getWorkplaceById(workplaceId)?.name || ""}»`
      : (target === "site" ? `объекта «${siteName}»` : `отдела «${departmentName}»`);
```

Движение возврата тоже получает `workplaceId`.

- [ ] **Step 8: Блок «Выдать сразу»**

В `readAssetIssueRequest` добавить чтение и проверку:

```javascript
  const workplaceId = target === "workplace" ? String(document.getElementById("assetIssueWorkplaceSelect")?.value || "") : "";
  if (target === "workplace" && !workplaceId) {
    showToast("Выберите рабочее место для выдачи.", "warning");
    return "invalid";
  }
```

и вернуть `workplaceId` в объекте запроса. В `issueAssetOnCreate` передать `workplaceId: request.workplaceId` в `mergeAllocation` и в `addMovement`.

В `syncAssetIssueFields` добавить четвёртую строку переключения:

```javascript
  document.getElementById("assetIssueWorkplaceField")?.classList.toggle("hidden", target !== "workplace");
```

- [ ] **Step 9: Переключение полей в модалках**

В обработчике `issueTarget` добавить:

```javascript
      show(document.getElementById("issueWorkplaceField"), target === "workplace");
```

В обработчике `returnTarget` — то же для `returnWorkplaceField`. Оба обработчика уже вызывают нужные перерисовки.

- [ ] **Step 10: Проверить в браузере**

На реальных данных: завести стол, выдать на него монитор, убедиться что он ушёл из доступного остатка и появился в карточке стола; вернуть его и убедиться что вернулся на склад; выдать технику сотруднику и проверить, что запись стола не изменилась.

- [ ] **Step 11: Полный прогон тестов и коммит**

```bash
python -m pytest -q && node --test mobile/tests/*.test.js tests/*.test.js
git add index.html app.js
git commit -m "feat(workplaces): выдача и возврат на рабочее место"
```

---

### Task 8: Два блока в карточке сотрудника

**Files:**
- Modify: `app.js` (новая функция `getEmployeeHoldings`, `openEmployeeDetailsModal` около `app.js:1957`, `renderIssueEmployeeAssets`)

**Interfaces:**
- Consumes: `getEmployeeWorkplace` (Task 5), `getWorkplaceAssets` (Task 6).
- Produces: `getEmployeeHoldings(employeeId)` → `{ personal: [{asset, allocation}], workplace: объект стола или null, atWorkplace: [{asset, allocation}] }`.

- [ ] **Step 1: Разделить технику на два списка**

```javascript
// Техника сотрудника делится надвое: то, что числится лично за ним, и
// то, что стоит на его рабочем месте. При увольнении первое возвращается
// на склад, второе остаётся на месте — поэтому списки разные.
function getEmployeeHoldings(employeeId) {
  const personal = state.assets
    .map((asset) => ({ asset, allocation: getEmployeeAllocation(asset, employeeId) }))
    .filter((entry) => entry.allocation && entry.allocation.quantity > 0);
  const workplace = getEmployeeWorkplace(employeeId);
  return { personal, workplace, atWorkplace: workplace ? getWorkplaceAssets(workplace.id) : [] };
}
```

- [ ] **Step 2: Общая отрисовка списка**

```javascript
function renderHoldingsList(entries) {
  return `<ul class="held-list">` + entries.map(({ asset, allocation }) =>
    `<li><code>${escapeHtml(asset.inventoryNumber || "—")}</code><span>${escapeHtml(asset.name)}</span><b>${allocation.quantity} шт.</b></li>`
  ).join("") + `</ul>`;
}
```

- [ ] **Step 3: Панель в окне выдачи**

Заменить в `renderIssueEmployeeAssets` всё после получения `employeeId`:

```javascript
  const { personal, workplace, atWorkplace } = getEmployeeHoldings(employeeId);
  box.classList.remove("hidden");
  if (!personal.length && !atWorkplace.length) {
    box.innerHTML = `<div class="held-title empty">Техники за сотрудником нет</div>`;
    return;
  }
  box.innerHTML =
    (atWorkplace.length ? `<div class="held-title">На рабочем месте · ${escapeHtml(workplace.name)}</div>` + renderHoldingsList(atWorkplace) : "")
    + (personal.length ? `<div class="held-title">Лично на руках · ${personal.length}</div>` + renderHoldingsList(personal) : "");
```

- [ ] **Step 4: Карточка сотрудника**

В `openEmployeeDetailsModal` заменить блок со списком техники на те же два блока из `getEmployeeHoldings(employeeId)`. Заголовки — «На рабочем месте — {название}» и «Лично на руках». Первый блок не выводится, если стола нет.

- [ ] **Step 5: Проверить в браузере**

Сотруднику со столом и личной техникой: оба блока видны и не дублируют друг друга. Сотруднику без стола — только «Лично на руках». Сотруднику без техники вовсе — «Техники за сотрудником нет».

- [ ] **Step 6: Полный прогон тестов и коммит**

```bash
python -m pytest -q && node --test mobile/tests/*.test.js tests/*.test.js
git add app.js
git commit -m "feat(workplaces): техника рабочего места в карточке сотрудника"
```

---

### Task 9: Пересборка и проверка на боевой базе

**Files:** нет изменений кода.

- [ ] **Step 1: Резервная копия базы**

```bash
cp "C:/ProgramData/Warehouse/warehouse.db" "$SCRATCH/before_workplaces_$(date +%Y%m%d_%H%M%S).db"
```

- [ ] **Step 2: Остановить приложение**

```bash
powershell -NoProfile -Command "Get-Process -Name 'WarehouseApp' -ErrorAction SilentlyContinue | Stop-Process -Force"
```

- [ ] **Step 3: Пересобрать**

```bash
rm -rf build dist && python -m PyInstaller WarehouseApp_New.spec --clean --noconfirm
```

- [ ] **Step 4: Заменить с сохранением копии**

```bash
TS=$(date +%Y%m%d_%H%M%S) && cp WarehouseApp.exe "WarehouseApp_OLD_${TS}.exe" && cp dist/WarehouseApp_New.exe WarehouseApp.exe
```

- [ ] **Step 5: Запустить и проверить**

Запустить `WarehouseApp.exe`, дождаться порта 8765. Убедиться, что схема поднялась до версии 30, а 203 актива и их выдачи на месте:

```bash
python -c "
import sqlite3
c=sqlite3.connect(r'C:\ProgramData\Warehouse\warehouse.db')
print('схема:', c.execute('SELECT MAX(version) FROM schema_version').fetchone()[0])
print('активов:', c.execute('SELECT COUNT(*) FROM assets').fetchone()[0])
print('выдач:', c.execute('SELECT COUNT(*) FROM asset_allocations').fetchone()[0])
print('столов:', c.execute('SELECT COUNT(*) FROM workplaces').fetchone()[0])
"
```

Expected: схема 30, активов 203, выдачи на месте, столов 0.

- [ ] **Step 6: Проверить отдачу файлов**

```bash
for f in index.html app.js asset_ops.js; do diff <(curl -s http://127.0.0.1:8765/$f) $f > /dev/null && echo "$f совпадает" || echo "$f ОТЛИЧАЕТСЯ"; done
```

Expected: все совпадают.
