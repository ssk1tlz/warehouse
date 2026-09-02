# Этап 4: инвентаризация и печать этикеток — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Режим непрерывной инвентаризации (мобильное сканирование → расхождения → акт на десктопе) и мастер пакетной печати QR-этикеток — обе фичи полностью офлайн-совместимы там, где это применимо, без новых зависимостей.

**Architecture:** Инвентаризация — новая пара таблиц (`inventory_sessions`,
`inventory_scans`) + одно новое действие `inventory_complete` в уже
существующем диспетчере `mobile_actions.apply_action`; телефон копит сканы
локально (новая таблица в мобильном SQLite) и шлёт один финальный экшен
через уже существующую офлайн-очередь. Акт инвентаризации генерируется
полностью программно (без Word-шаблона — данные не похожи на акт
выдачи/возврата, шаблон не подошёл бы). **Печать этикеток пачкой уже
полностью реализована в репозитории** (мастер, сетка, `window.print()`,
экспорт JPG/Excel, кнопка на карточке актива) — этот план добавляет только
недостающие фильтры (категория/место/непечатавшиеся) и один маленький
серверный эндпоинт отметки "напечатано".

**Tech Stack:** Python stdlib (`sqlite3`, `zipfile`, `xml.etree.ElementTree`),
pytest; ванильный JS, `node --test`; существующий
`@capacitor-mlkit/barcode-scanning` (уже установлен, новый режим API
`startScan`/`addListener`/`stopScan` вместо разового `scan()`);
существующий `qrcode-lib.js`.

**Spec:** `docs/superpowers/specs/2026-09-02-stage4-inventory-labels-design.md`

## Global Constraints

- Проект полностью бесплатный: никаких платных библиотек, подписок, облачных API. Python — только stdlib. Никаких новых npm/gradle-зависимостей.
- Русский интерфейс, сообщения об ошибках и печатные документы — на русском.
- Не трогать существующую складскую логику (`apply_issue`/`apply_return`/`apply_repair`/`apply_repair_return`/`apply_retire`/`apply_edit`), конфликт-детекцию (`rev`/`baseRev`), роли/токены/HMAC, миграции схемы БД других таблиц.
- Инвентаризация обязана работать целиком офлайн на телефоне (сканы копятся локально) и не терять сессию при закрытии приложения.
- Только `admin` может начинать/завершать инвентаризацию.
- Одна открытая сессия инвентаризации на весь сервер.
- Печать этикеток — только через окно печати браузера (`window.print()` + `@media print`), без нативных драйверов принтера.
- Коммит по завершении каждой отдельно нумерованной задачи.
- После каждой задачи: `python -m pytest -q` и `node --test mobile/tests/*.test.js`.
- Все ссылки вида `file.py:123` — по состоянию репозитория ДО начала этого плана; реальные номера сдвинутся по ходу реализации. Искать по показанному фрагменту кода/имени функции, если номер не совпал.

---

## Задача A — режим инвентаризации

### Task A1: миграция 026 — таблицы `inventory_sessions` и `inventory_scans`

**Files:**
- Modify: `migrations.py` (добавить `_migrate_026_inventory_tables`, зарегистрировать в `MIGRATIONS`)
- Modify: `schema.sql` (те же две таблицы — для чистой установки)
- Test: `tests/test_migrations.py` (уже существует — 186 строк, дописать в существующие фикстуры/тесты, не создавать параллельную инфраструктуру)

**Interfaces:**
- Produces: таблицы `inventory_sessions(id, started_at, finished_at, started_by, status)` и `inventory_scans(session_id, asset_id, status, found_location)`. Потребляется Task A2 (`mobile_actions.apply_inventory_complete`), Task A3 (`server.py` маршруты).

**Реальная структура `tests/test_migrations.py` (проверено чтением файла — использовать её как есть, не изобретать новую):** фикстура `legacy_alloc_conn` (создаёт БД по `LEGACY_ALLOCATIONS_SCHEMA`, сеет `ast_1`/`emp_1`) уже используется параметризованным тестом `test_table_creation_migrations_create_expected_tables(legacy_alloc_conn, table)` — именно этот тест уже проверяет, что миграции создают таблицы `sites`/`audit_log`/`kit_templates`/`mobile_action_log`. Новые таблицы этой задачи — того же вида (создание таблицы с нуля, без изменения существующих), так что естественное место — расширить список параметров этого теста, а не писать отдельный.

- [ ] **Step 1: Написать падающий тест**

В `tests/test_migrations.py`, найти:

```python
@pytest.mark.parametrize("table", ["sites", "audit_log", "kit_templates", "mobile_action_log"])
def test_table_creation_migrations_create_expected_tables(legacy_alloc_conn, table):
```

Расширить список параметров:

```python
@pytest.mark.parametrize("table", [
    "sites", "audit_log", "kit_templates", "mobile_action_log",
    "inventory_sessions", "inventory_scans",
])
def test_table_creation_migrations_create_expected_tables(legacy_alloc_conn, table):
```

Добавить в конец файла два теста, специфичных для формы новых таблиц (параметризованный тест выше только проверяет факт существования таблицы, не её колонки/связи):

```python
def test_migration_026_inventory_sessions_has_expected_columns(legacy_alloc_conn):
    migrations.run_migrations(legacy_alloc_conn)
    legacy_alloc_conn.execute(
        "INSERT INTO inventory_sessions (id, started_at, started_by, status) VALUES (?, ?, ?, ?)",
        ("s1", "2026-09-02T10:00:00+00:00", "alan", "open"),
    )
    row = legacy_alloc_conn.execute(
        "SELECT id, started_at, finished_at, started_by, status FROM inventory_sessions WHERE id = ?",
        ("s1",),
    ).fetchone()
    assert row["started_by"] == "alan"
    assert row["status"] == "open"
    assert row["finished_at"] is None


def test_migration_026_inventory_scans_references_existing_asset(legacy_alloc_conn):
    migrations.run_migrations(legacy_alloc_conn)
    legacy_alloc_conn.execute(
        "INSERT INTO inventory_sessions (id, started_at, started_by, status) VALUES (?, ?, ?, ?)",
        ("s1", "2026-09-02T10:00:00+00:00", "alan", "open"),
    )
    # legacy_alloc_conn fixture already seeds asset 'ast_1'.
    legacy_alloc_conn.execute(
        "INSERT INTO inventory_scans (session_id, asset_id, status, found_location) VALUES (?, ?, ?, ?)",
        ("s1", "ast_1", "found", ""),
    )
    row = legacy_alloc_conn.execute(
        "SELECT session_id, asset_id, status FROM inventory_scans WHERE session_id = ?", ("s1",)
    ).fetchone()
    assert row["asset_id"] == "ast_1"
    assert row["status"] == "found"
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

Run: `python -m pytest tests/test_migrations.py -v -k "inventory or table_creation"`
Expected: FAIL — параметризованные случаи `inventory_sessions`/`inventory_scans` падают (таблицы не существует), два новых теста падают с `sqlite3.OperationalError: no such table: inventory_sessions`.

- [ ] **Step 3: Реализация — `migrations.py`**

Добавить после `_migrate_025_assets_rev`:

```python
def _migrate_026_inventory_tables(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS inventory_sessions (
          id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          started_by TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open'
        )
        """
    )
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS inventory_scans (
          session_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          status TEXT NOT NULL,
          found_location TEXT NOT NULL DEFAULT '',
          FOREIGN KEY (session_id) REFERENCES inventory_sessions(id),
          FOREIGN KEY (asset_id) REFERENCES assets(id)
        )
        """
    )
```

Добавить в список `MIGRATIONS` последней строкой:

```python
    (26, "inventory_sessions + inventory_scans tables", _migrate_026_inventory_tables),
```

Добавить в `schema.sql` (после таблицы `pairing_codes`, то есть в самый конец файла) те же два `CREATE TABLE IF NOT EXISTS` блока дословно — так чистая установка сразу получает обе таблицы, не дожидаясь миграции.

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `python -m pytest tests/test_migrations.py -v -k "inventory or table_creation"`
Expected: PASS (все новые тесты и расширенный параметризованный тест)

Run: `python -m pytest -q`
Expected: PASS (полный набор, без регрессий)

- [ ] **Step 5: Commit**

```bash
git add migrations.py schema.sql tests/test_migrations.py
git commit -m "Task A1: add inventory_sessions and inventory_scans tables (migration 026)"
```

---

### Task A2: `mobile_actions.apply_inventory_complete` — финализация сессии одним действием

**Files:**
- Modify: `mobile_actions.py` (новый обработчик `apply_inventory_complete`, правка `apply_action` под действия без `assetId`)
- Test: `tests/test_mobile_actions.py` (дописать в существующий файл — проверить его наличие и текущие импорты перед правкой)

**Interfaces:**
- Consumes: `inventory_sessions`/`inventory_scans` (Task A1).
- Produces: `mobile_actions.apply_inventory_complete(connection, action) -> dict`; запись `"inventory_complete": apply_inventory_complete` в `_DISPATCH`. Результат: `{"sessionId": str, "foundCount": int, "wrongLocationCount": int, "missingAssetIds": list[str], "extraCodes": list[str], "replayed": bool}`. Потребляется Task A3 (маршрут `/api/inventory/start` формирует сессии, которые здесь закрываются), Task A5 (акт читает те же данные), Task A9 (мобильный клиент собирает `action` с этим `type`).

**Важно про `apply_action`:** сейчас эта функция требует `assetId` у ЛЮБОГО действия (`server.py`/`mobile_actions.py:` — проверить точную строку `if not action.get("assetId"): raise MobileActionError(...)`) и строит результат как `{"assetId": action["assetId"], "replayed": False}`, добавляя `rev`, если обработчик вернул `int`. Инвентаризация — не про один актив, а про сессию целиком, так что это надо аккуратно расширить, не трогая поведение для существующих пяти типов действий.

- [ ] **Step 1: Написать падающие тесты**

Существующая фикстура подключения к БД в этом файле называется `conn` (pytest-фикстура `conn()` в начале файла) — новые тесты ниже уже используют её под этим именем. Добавить в конец файла:

```python
def test_apply_inventory_complete_closes_the_session_and_records_scans(conn):
    # NOTE: the `conn` fixture (top of this file) already seeds one asset,
    # 'ast_1' ("Ноутбук Dell") — it will legitimately show up in
    # missingAssetIds too, since it's never scanned here. Assert membership,
    # not exact-list equality, so this test doesn't silently break if the
    # fixture's seed data changes.
    conn.execute(
        "INSERT INTO assets (id, name, location) VALUES (?, ?, ?)", ("a1", "Монитор", "Каб. 101"),
    )
    conn.execute(
        "INSERT INTO assets (id, name, location) VALUES (?, ?, ?)", ("a2", "Клавиатура", "Каб. 101"),
    )
    conn.execute(
        "INSERT INTO inventory_sessions (id, started_at, started_by, status) VALUES (?, ?, ?, 'open')",
        ("s1", "2026-09-02T10:00:00+00:00", "alan"),
    )
    action = {
        "clientActionId": "c1",
        "type": "inventory_complete",
        "sessionId": "s1",
        "scans": [{"assetId": "a1", "status": "found", "foundLocation": ""}],
        "extraCodes": ["WH1:unknown-123"],
    }
    result = mobile_actions.apply_action(conn, action)

    assert result["replayed"] is False
    assert result["sessionId"] == "s1"
    assert result["foundCount"] == 1
    assert result["wrongLocationCount"] == 0
    assert "a2" in result["missingAssetIds"]
    assert "a1" not in result["missingAssetIds"]
    assert result["extraCodes"] == ["WH1:unknown-123"]

    session = conn.execute(
        "SELECT status, finished_at FROM inventory_sessions WHERE id = ?", ("s1",)
    ).fetchone()
    assert session["status"] == "finished"
    assert session["finished_at"] is not None

    scan = conn.execute(
        "SELECT asset_id, status FROM inventory_scans WHERE session_id = ?", ("s1",)
    ).fetchone()
    assert scan["asset_id"] == "a1"
    assert scan["status"] == "found"


def test_apply_inventory_complete_records_wrong_location(conn):
    conn.execute("INSERT INTO assets (id, name, location) VALUES (?, ?, ?)", ("a1", "Монитор", "Каб. 101"))
    conn.execute(
        "INSERT INTO inventory_sessions (id, started_at, started_by, status) VALUES (?, ?, ?, 'open')",
        ("s1", "2026-09-02T10:00:00+00:00", "alan"),
    )
    action = {
        "clientActionId": "c2",
        "type": "inventory_complete",
        "sessionId": "s1",
        "scans": [{"assetId": "a1", "status": "wrong_location", "foundLocation": "Каб. 202"}],
        "extraCodes": [],
    }
    result = mobile_actions.apply_action(conn, action)
    assert result["wrongLocationCount"] == 1
    scan = conn.execute(
        "SELECT status, found_location FROM inventory_scans WHERE session_id = ?", ("s1",)
    ).fetchone()
    assert scan["status"] == "wrong_location"
    assert scan["found_location"] == "Каб. 202"


def test_apply_inventory_complete_rejects_an_unknown_session(conn):
    action = {
        "clientActionId": "c3", "type": "inventory_complete", "sessionId": "does-not-exist",
        "scans": [], "extraCodes": [],
    }
    try:
        mobile_actions.apply_action(conn, action)
        assert False, "expected MobileActionError"
    except mobile_actions.MobileActionError as exc:
        assert "не найдена" in str(exc)


def test_apply_inventory_complete_rejects_an_already_finished_session(conn):
    conn.execute(
        "INSERT INTO inventory_sessions (id, started_at, started_by, status, finished_at) "
        "VALUES (?, ?, ?, 'finished', ?)",
        ("s1", "2026-09-02T10:00:00+00:00", "alan", "2026-09-02T11:00:00+00:00"),
    )
    action = {"clientActionId": "c4", "type": "inventory_complete", "sessionId": "s1", "scans": [], "extraCodes": []}
    try:
        mobile_actions.apply_action(conn, action)
        assert False, "expected MobileActionError"
    except mobile_actions.MobileActionError as exc:
        assert "уже завершена" in str(exc)


def test_apply_inventory_complete_replay_returns_cached_result(conn):
    conn.execute("INSERT INTO assets (id, name) VALUES (?, ?)", ("a1", "Монитор"))
    conn.execute(
        "INSERT INTO inventory_sessions (id, started_at, started_by, status) VALUES (?, ?, ?, 'open')",
        ("s1", "2026-09-02T10:00:00+00:00", "alan"),
    )
    action = {
        "clientActionId": "c5", "type": "inventory_complete", "sessionId": "s1",
        "scans": [{"assetId": "a1", "status": "found", "foundLocation": ""}], "extraCodes": [],
    }
    first = mobile_actions.apply_action(conn, action)
    assert first["replayed"] is False
    second = mobile_actions.apply_action(conn, action)
    assert second["replayed"] is True
    assert second["sessionId"] == "s1"
    # Replay must not double-insert the scan row or re-close an already-closed session.
    count = conn.execute("SELECT COUNT(*) FROM inventory_scans WHERE session_id = ?", ("s1",)).fetchone()[0]
    assert count == 1


def test_existing_action_types_still_require_asset_id(conn):
    # Guards the shared apply_action() change: only inventory_complete is exempt.
    action = {"clientActionId": "c6", "type": "issue", "quantity": 1}
    try:
        mobile_actions.apply_action(conn, action)
        assert False, "expected MobileActionError"
    except mobile_actions.MobileActionError as exc:
        assert "assetId" in str(exc)
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

Run: `python -m pytest tests/test_mobile_actions.py -v -k inventory`
Expected: FAIL — `Неизвестный тип действия: "inventory_complete".`

- [ ] **Step 3: Реализация — `mobile_actions.py`**

Добавить рядом с `apply_retire`/`apply_edit` (перед `_DISPATCH`):

```python
def apply_inventory_complete(connection: sqlite3.Connection, action: dict) -> dict:
    """Закрыть открытую сессию инвентаризации и записать её результат.

    В отличие от остальных действий, не привязано к одному активу — работает
    сразу со всеми сканами сессии. "Лишнее" (нераспознанные коды) в БД не
    хранится — это не актив; список остаётся только в результате действия
    (который сохраняется в mobile_action_log.response_json для дедупликации
    и переиспользуется актом инвентаризации).
    """
    session_id = str(action.get("sessionId") or "").strip()
    if not session_id:
        raise MobileActionError("sessionId обязателен.")

    session = connection.execute(
        "SELECT id, status FROM inventory_sessions WHERE id = ?", (session_id,)
    ).fetchone()
    if session is None:
        raise MobileActionError(f'Сессия инвентаризации "{session_id}" не найдена.')
    if session["status"] != "open":
        raise MobileActionError("Эта сессия инвентаризации уже завершена.")

    scans = action.get("scans") or []
    found_count = 0
    wrong_location_count = 0
    scanned_ids: set[str] = set()
    for scan in scans:
        asset_id = str(scan.get("assetId") or "").strip()
        if not asset_id:
            continue
        status = scan.get("status") or "found"
        if status not in ("found", "wrong_location"):
            raise MobileActionError(f'Неизвестный статус скана: "{status}".')
        connection.execute(
            "INSERT INTO inventory_scans (session_id, asset_id, status, found_location) VALUES (?, ?, ?, ?)",
            (session_id, asset_id, status, str(scan.get("foundLocation") or "")),
        )
        scanned_ids.add(asset_id)
        if status == "found":
            found_count += 1
        else:
            wrong_location_count += 1

    all_asset_ids = [row["id"] for row in connection.execute("SELECT id FROM assets ORDER BY name")]
    missing_asset_ids = [asset_id for asset_id in all_asset_ids if asset_id not in scanned_ids]

    connection.execute(
        "UPDATE inventory_sessions SET status = 'finished', finished_at = ? WHERE id = ?",
        (datetime.now(timezone.utc).isoformat(), session_id),
    )

    return {
        "sessionId": session_id,
        "foundCount": found_count,
        "wrongLocationCount": wrong_location_count,
        "missingAssetIds": missing_asset_ids,
        "extraCodes": [str(code) for code in (action.get("extraCodes") or [])],
    }
```

Изменить `_DISPATCH`, добавив последней строкой:

```python
    "inventory_complete": apply_inventory_complete,
```

Изменить `apply_action` — найти блок:

```python
    if not action.get("assetId"):
        raise MobileActionError("assetId обязателен.")
```

Заменить на:

```python
    if action_type != "inventory_complete" and not action.get("assetId"):
        raise MobileActionError("assetId обязателен.")
```

Найти блок формирования результата (после `new_rev = _DISPATCH[action_type](connection, action)`):

```python
    result = {"assetId": action["assetId"], "replayed": False}
    if new_rev is not None:
        result["rev"] = new_rev
```

Заменить на:

```python
    result: dict = {"replayed": False}
    if action.get("assetId"):
        result["assetId"] = action["assetId"]
    if isinstance(new_rev, dict):
        result.update(new_rev)
    elif new_rev is not None:
        result["rev"] = new_rev
```

(Переименование локальной переменной `new_rev` не требуется — она теперь хранит либо `int | None` [rev, как раньше], либо `dict` [результат `apply_inventory_complete`]; само имя переменной не меняем, чтобы дифф был минимальным, но по смыслу это теперь "результат обработчика".)

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `python -m pytest tests/test_mobile_actions.py -v`
Expected: PASS (все тесты файла — и новые, и существующие `apply_issue`/`apply_return`/... тесты, подтверждающие, что правка `apply_action` их не сломала)

Run: `python -m pytest -q`
Expected: PASS (полный набор)

- [ ] **Step 5: Commit**

```bash
git add mobile_actions.py tests/test_mobile_actions.py
git commit -m "Task A2: add apply_inventory_complete, allow asset-less action types in apply_action"
```

---

### Task A3: `POST /api/inventory/start` + текущая сессия в `/api/state`

**Files:**
- Modify: `server.py` (`do_POST`, новый `handle_start_inventory`, `state_with_versions`/`_decorate_with_versions`)
- Modify: `app.js` (`hydrateState` — иначе десктоп получит поле от сервера и тут же его потеряет, тем же способом, каким Этап 3 терял `currentVersion`/`latestVersion`/`releaseUrl` до того, как их явно добавили в `hydrateState`)
- Test: `tests/test_server_auth.py`

**Interfaces:**
- Consumes: `inventory_sessions` (Task A1).
- Produces: `POST /api/inventory/start` (admin) → `201 {"sessionId": str, "startedAt": str}` или `409 {"error": ..., "session": {...}}`, если сессия уже открыта. `GET /api/state` дополнительно несёт `activeInventorySession: {"id": str, "startedAt": str, "startedBy": str} | None`. Потребляется Task A9 (мобильный старт-экран), Task A10 (десктоп-модалка).

- [ ] **Step 1: Написать падающие тесты**

Прочитать текущую структуру `tests/test_server_auth.py` (фикстуру `live_server`, хелпер `_create_admin`/`_request` — уже использовались в предыдущих этапах) и добавить в конец:

```python
def test_starting_inventory_requires_admin(live_server):
    admin_token = _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/users", token=admin_token,
                            json_body={"username": "sklad1", "password": "parol123", "role": "storekeeper"})
    assert status == 200, body
    status, body = _request(live_server, "POST", "/api/login",
                            json_body={"username": "sklad1", "password": "parol123"})
    storekeeper_token = body["token"]
    status, _ = _request(live_server, "POST", "/api/inventory/start", token=storekeeper_token)
    assert status == 403


def test_starting_inventory_creates_an_open_session(live_server):
    token = _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/inventory/start", token=token)
    assert status == 201, body
    assert body["sessionId"]
    assert body["startedAt"]


def test_starting_inventory_twice_returns_409_with_the_existing_session(live_server):
    token = _create_admin(live_server)
    status, first = _request(live_server, "POST", "/api/inventory/start", token=token)
    assert status == 201
    status, body = _request(live_server, "POST", "/api/inventory/start", token=token)
    assert status == 409
    assert body["session"]["id"] == first["sessionId"]


def test_state_reports_the_active_inventory_session(live_server):
    token = _create_admin(live_server)
    status, body = _request(live_server, "GET", "/api/state", token=token)
    assert body["activeInventorySession"] is None

    _request(live_server, "POST", "/api/inventory/start", token=token)
    status, body = _request(live_server, "GET", "/api/state", token=token)
    assert body["activeInventorySession"]["startedBy"] == "alan"
```

(Проверить реальный логин админа, который использует `_create_admin` — везде в существующих тестах, судя по прошлым этапам, это `"alan"`; если хелпер использует другое имя, поправить `startedBy` в тесте на реальное.)

- [ ] **Step 2: Запустить тесты, убедиться что падают**

Run: `python -m pytest tests/test_server_auth.py -v -k inventory`
Expected: FAIL — 404 (маршрута нет) на первом тесте, `KeyError: 'activeInventorySession'` на последнем.

- [ ] **Step 3: Реализация**

Добавить импорт `uuid` в `server.py`, если его там ещё нет (проверить `import uuid` в начале файла — вероятно уже есть, т.к. используется для `client_action_id`/токенов в других местах; если нет — добавить рядом с остальными stdlib-импортами).

Добавить обработчик рядом с `handle_save_settings`:

```python
    def handle_start_inventory(self) -> None:
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
                (session_id, started_at, self._current_user["username"]),
            )
        self.send_response(HTTPStatus.CREATED)
        body = json.dumps({"sessionId": session_id, "startedAt": started_at}, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
```

**Проверить перед вставкой:** как в этом файле уже принято доставать текущего залогиненного пользователя внутри метода-обработчика (`self.authenticate()` вызывается в `do_POST` ДО диспетчеризации и результат передаётся как параметр `user` в другие `handle_*`, судя по `handle_save_settings(body)`, `handle_restore_backup(body)` — они получают `body`, но не `user`, значит `user` where-то ещё нужен). Прочитать `do_POST`'s текущую диспетчеризацию перед `/api/settings`/`/api/backups/restore`, взять оттуда реальный способ получить username (скорее всего `user["username"]`, а не `self._current_user` — последнее я написал по догадке, ЭТО НАДО ПРОВЕРИТЬ И ИСПРАВИТЬ на реальный паттерн файла перед тем, как считать шаг выполненным). Поправить `handle_start_inventory`, чтобы получать `username` тем же способом, что и другие `handle_*`, - вероятно, добавив параметр `username: str` в сигнатуру и передавая `user["username"]` при вызове из `do_POST`.

В `do_POST`, рядом с маршрутом `/api/settings`:

```python
        if parsed.path == "/api/inventory/start":
            if not self.require_role(user, ("admin",)):
                return
            self.handle_start_inventory(user["username"])
            return
```

(Сигнатуру `handle_start_inventory(self, username: str)` привести в соответствие с этим вызовом.)

В `export_state()` — добавить в возвращаемый словарь (после `"kitTemplates": kits,`):

```python
        "activeInventorySession": _load_active_inventory_session(connection),
```

Добавить новую функцию рядом с `export_state`:

```python
def _load_active_inventory_session(connection: sqlite3.Connection) -> dict | None:
    row = connection.execute(
        "SELECT id, started_at, started_by FROM inventory_sessions WHERE status = 'open'"
    ).fetchone()
    if row is None:
        return None
    return {"id": row["id"], "startedAt": row["started_at"], "startedBy": row["started_by"]}
```

**Важно:** `export_state()` уже открывает `with get_connection() as connection:` и делает много запросов внутри одного `with`-блока — добавить вызов `_load_active_inventory_session(connection)` ВНУТРИ уже существующего `with`-блока (переиспользовать то же соединение), не открывать новое. Проверить точное место вставки строки в возвращаемый `dict` — она должна попасть внутрь того же `return {...}`, что и `"kitTemplates": kits`.

**Обязательно — иначе поле долетит до браузера и тут же потеряется.** `app.js`'s `hydrateState(parsed)` (уже существует, была расширена в Этапе 3 полями `currentVersion`/`latestVersion`/`releaseUrl`) строит НОВЫЙ объект по явному списку полей — то же самое правило, что уже один раз аукнулось в Этапе 3 ("любое поле, не перечисленное в ней, молча теряется"). Добавить в конец объекта, который возвращает `hydrateState`, рядом с уже существующими `currentVersion`/`latestVersion`/`releaseUrl`:

```javascript
    activeInventorySession: parsed.activeInventorySession || null,
```

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `python -m pytest tests/test_server_auth.py -v -k inventory`
Expected: PASS

Run: `python -m pytest -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server.py app.js tests/test_server_auth.py
git commit -m "Task A3: add POST /api/inventory/start, expose active session in /api/state"
```

---

### Task A4: `GET /api/inventory/sessions` — список для десктопа

**Files:**
- Modify: `server.py` (`do_GET`, новый `handle_list_inventory_sessions`)
- Test: `tests/test_server_auth.py`

**Interfaces:**
- Consumes: `inventory_sessions`, `inventory_scans` (Task A1), `mobile_action_log` (для восстановления `foundCount`/`wrongLocationCount`/`missingAssetIds`/`extraCodes` завершённой сессии — Task A2 уже пишет это в `response_json`).
- Produces: `GET /api/inventory/sessions` (admin) → `{"sessions": [{"id", "startedAt", "finishedAt", "startedBy", "status", "foundCount", "wrongLocationCount", "missingCount", "extraCount"}]}`, отсортировано по `startedAt` по убыванию.

- [ ] **Step 1: Написать падающий тест**

```python
def test_listing_inventory_sessions_requires_admin(live_server):
    admin_token = _create_admin(live_server)
    _request(live_server, "POST", "/api/users", token=admin_token,
             json_body={"username": "viewer1", "password": "parol123", "role": "viewer"})
    status, body = _request(live_server, "POST", "/api/login",
                            json_body={"username": "viewer1", "password": "parol123"})
    viewer_token = body["token"]
    status, _ = _request(live_server, "GET", "/api/inventory/sessions", token=viewer_token)
    assert status == 403


def test_listing_inventory_sessions_includes_a_finished_session_with_counts(live_server):
    token = _create_admin(live_server)
    _request(live_server, "POST", "/api/users", token=token,
             json_body={"username": "sklad1", "password": "parol123", "role": "storekeeper"})
    status, body = _request(live_server, "POST", "/api/inventory/start", token=token)
    session_id = body["sessionId"]

    status, _ = _request(live_server, "POST", "/api/mobile/action", token=token, json_body={
        "clientActionId": "inv-1",
        "type": "inventory_complete",
        "sessionId": session_id,
        "scans": [],
        "extraCodes": ["WH1:unknown"],
    })
    assert status == 200

    status, body = _request(live_server, "GET", "/api/inventory/sessions", token=token)
    assert status == 200
    assert len(body["sessions"]) == 1
    session = body["sessions"][0]
    assert session["id"] == session_id
    assert session["status"] == "finished"
    assert session["startedBy"] == "alan"
    assert session["extraCount"] == 1
```

(Как и в Task A3 — сверить реальный логин администратора в `_create_admin` перед финальной проверкой `startedBy`.)

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `python -m pytest tests/test_server_auth.py -v -k listing_inventory`
Expected: FAIL — 404.

- [ ] **Step 3: Реализация**

Добавить обработчик рядом с `handle_start_inventory`:

```python
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
```

**Проверка перед вставкой:** `LIKE '%"sessionId": "..."%` — это хрупкий способ найти нужную запись в `mobile_action_log` (полагается на точный JSON-форматтинг `json.dumps`, который по умолчанию пишет `"sessionId": "..."` с пробелом после двоеточия — свериться, что `apply_action`/`handle_mobile_action` действительно сохраняет `response_json` через `json.dumps(result)` без `separators=` — если так, пробел после `:` там будет, и `LIKE`-паттерн верен). Если это кажется слишком хрупким — альтернатива понадёжнее: хранить `found_count`/`wrong_location_count`/`missing_count`/`extra_count` прямо в `inventory_sessions` как отдельные INTEGER-колонки, заполняемые в `apply_inventory_complete` (Task A2) через `UPDATE inventory_sessions SET found_count = ?, ... WHERE id = ?` — **это надёжнее и предпочтительнее** `LIKE`-поиска по JSON. Если реализующий агент видит это на Step 3 — сделать именно так (добавить 4 колонки в миграцию 026 из Task A1, тогда придётся вернуться и поправить ту задачу до коммита A4, либо сделать отдельную мелкую миграцию 026b/027 — на усмотрение реализующего, но `LIKE`-поиск по JSON не должен уйти в коммит как единственный механизм).

В `do_GET`, рядом с маршрутом `/api/settings`:

```python
        if parsed.path == "/api/inventory/sessions":
            if not self.require_role(user, ("admin",)):
                return
            self.handle_list_inventory_sessions()
            return
```

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `python -m pytest tests/test_server_auth.py -v -k inventory`
Expected: PASS

Run: `python -m pytest -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server.py tests/test_server_auth.py migrations.py schema.sql
git commit -m "Task A4: add GET /api/inventory/sessions for the desktop list"
```

---

### Task A5: акт инвентаризации — `act_generator.generate_inventory_act` + `GET /api/inventory/sessions/<id>/act`

**Files:**
- Modify: `act_generator.py` (новая функция `generate_inventory_act`)
- Modify: `server.py` (`do_GET`, новый `handle_inventory_act`)
- Test: `tests/test_act_generator.py` (создать, если не существует — проверить)

**Interfaces:**
- Consumes: результат `apply_inventory_complete` (Task A2), список активов (для имён `missingAssetIds`).
- Produces: `act_generator.generate_inventory_act(*, session: dict, missing_assets: list[dict], wrong_location: list[dict], extra_codes: list[str]) -> bytes` (валидный `.docx`); `GET /api/inventory/sessions/<id>/act` (admin) → скачивание.

**Почему без Word-шаблона:** `generate_act()` (акт выдачи/возврата) читает готовый `.docx`-шаблон и подставляет значения в готовую таблицу — структура заточена под "сотрудник получил/сдал список позиций". У инвентаризации нет сотрудника-получателя и три разных списка (не найдено / не на месте / лишнее) вместо одной таблицы позиций — шаблон `act_template.docx` для этого не подходит, а рисовать новый шаблон в Word — не код и не автоматизируется этим планом. Вместо этого `generate_inventory_act` строит валидный `.docx` полностью программно (тот же приём: zip с `word/document.xml`, но без чтения внешнего файла) — самодостаточно, не требует ручной подготовки бинарного шаблона человеком.

- [ ] **Step 1: Написать падающие тесты**

Create `tests/test_act_generator.py` (или дописать, если файл уже есть — сначала проверить):

```python
import zipfile
from io import BytesIO

import act_generator


def test_generate_inventory_act_returns_a_valid_docx_zip():
    data = act_generator.generate_inventory_act(
        session={"id": "s1", "startedAt": "2026-09-02T10:00:00+00:00",
                 "finishedAt": "2026-09-02T11:30:00+00:00", "startedBy": "alan"},
        missing_assets=[{"name": "Монитор Dell", "inventoryNumber": "INV-010"}],
        wrong_location=[{"name": "Клавиатура", "inventoryNumber": "INV-011",
                          "expectedLocation": "Каб. 101", "foundLocation": "Каб. 202"}],
        extra_codes=["WH1:unknown-999"],
    )
    assert isinstance(data, bytes)
    zf = zipfile.ZipFile(BytesIO(data))
    names = zf.namelist()
    assert "word/document.xml" in names
    assert "[Content_Types].xml" in names
    assert "_rels/.rels" in names
    # zipfile.testzip() returns None when every member's CRC checks out.
    assert zf.testzip() is None


def test_generate_inventory_act_embeds_the_key_facts_as_readable_text():
    data = act_generator.generate_inventory_act(
        session={"id": "s1", "startedAt": "2026-09-02T10:00:00+00:00",
                 "finishedAt": "2026-09-02T11:30:00+00:00", "startedBy": "alan"},
        missing_assets=[{"name": "Монитор Dell", "inventoryNumber": "INV-010"}],
        wrong_location=[],
        extra_codes=[],
    )
    zf = zipfile.ZipFile(BytesIO(data))
    document_xml = zf.read("word/document.xml").decode("utf-8")
    assert "alan" in document_xml
    assert "Монитор Dell" in document_xml
    assert "INV-010" in document_xml


def test_generate_inventory_act_handles_empty_lists_without_crashing():
    data = act_generator.generate_inventory_act(
        session={"id": "s1", "startedAt": "2026-09-02T10:00:00+00:00",
                 "finishedAt": "2026-09-02T11:00:00+00:00", "startedBy": "alan"},
        missing_assets=[], wrong_location=[], extra_codes=[],
    )
    zf = zipfile.ZipFile(BytesIO(data))
    assert zf.testzip() is None
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

Run: `python -m pytest tests/test_act_generator.py -v -k inventory`
Expected: FAIL — `AttributeError: module 'act_generator' has no attribute 'generate_inventory_act'`.

- [ ] **Step 3: Реализация — `act_generator.py`**

Добавить в конец файла (переиспользует уже существующие `W_NS`/`W`/`_make_run`/`MONTHS_RU`/`parse_iso_date` из этого же модуля — не дублировать их):

```python
_CONTENT_TYPES_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '</Types>'
)

_ROOT_RELS_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/>'
    '</Relationships>'
)


def _inventory_heading(text: str) -> ET.Element:
    p = ET.Element(f"{W}p")
    pPr = ET.SubElement(p, f"{W}pPr")
    ET.SubElement(pPr, f"{W}b")
    p.append(_make_run(text, bold=True))
    return p


def _inventory_paragraph(text: str) -> ET.Element:
    p = ET.Element(f"{W}p")
    p.append(_make_run(text))
    return p


def _inventory_list_paragraphs(items: list[str], empty_text: str) -> list[ET.Element]:
    if not items:
        return [_inventory_paragraph(empty_text)]
    return [_inventory_paragraph(f"— {text}") for text in items]


def generate_inventory_act(
    *,
    session: dict,
    missing_assets: list[dict],
    wrong_location: list[dict],
    extra_codes: list[str],
) -> bytes:
    """Собрать .docx акт инвентаризации полностью программно (без внешнего шаблона).

    В отличие от generate_act() (акт выдачи/возврата), у инвентаризации нет
    подходящего готового шаблона — три разных списка расхождений вместо одной
    таблицы позиций. Строим минимальный, но валидный OOXML-пакет напрямую:
    [Content_Types].xml + _rels/.rels + word/document.xml — этого достаточно,
    чтобы Word/LibreOffice открыли файл.
    """
    body = ET.Element(f"{W}body")
    body.append(_inventory_heading(f"Акт инвентаризации № {session['id'][:8]}"))
    body.append(_inventory_paragraph(f"Начата: {session.get('startedAt') or ''}"))
    body.append(_inventory_paragraph(f"Завершена: {session.get('finishedAt') or ''}"))
    body.append(_inventory_paragraph(f"Исполнитель: {session.get('startedBy') or ''}"))

    body.append(_inventory_heading("Не найдено"))
    missing_texts = [
        f"{item.get('name', '')} ({item.get('inventoryNumber', '') or 'без инв. номера'})"
        for item in missing_assets
    ]
    for p in _inventory_list_paragraphs(missing_texts, "Все позиции найдены."):
        body.append(p)

    body.append(_inventory_heading("Не на своём месте"))
    wrong_location_texts = [
        f"{item.get('name', '')} ({item.get('inventoryNumber', '') or 'без инв. номера'}): "
        f"учтено «{item.get('expectedLocation', '')}», найдено «{item.get('foundLocation', '')}»"
        for item in wrong_location
    ]
    for p in _inventory_list_paragraphs(wrong_location_texts, "Расхождений по местоположению нет."):
        body.append(p)

    body.append(_inventory_heading("Лишнее (нераспознанные коды)"))
    for p in _inventory_list_paragraphs(list(extra_codes), "Лишних кодов не обнаружено."):
        body.append(p)

    ET.SubElement(body, f"{W}sectPr")

    document = ET.Element(f"{W}document")
    document.set(
        "xmlns:w",
        W_NS,
    )
    document.append(body)

    document_xml = (
        b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + ET.tostring(document, encoding="UTF-8")
    )

    out_buffer = io.BytesIO()
    with zipfile.ZipFile(out_buffer, "w", zipfile.ZIP_DEFLATED) as out_zip:
        out_zip.writestr("[Content_Types].xml", _CONTENT_TYPES_XML)
        out_zip.writestr("_rels/.rels", _ROOT_RELS_XML)
        out_zip.writestr("word/document.xml", document_xml)
    return out_buffer.getvalue()
```

**Проверить перед коммитом:** открыть сгенерированный тестовый `.docx` в Word/LibreOffice (или хотя бы прогнать через `python -c "import zipfile; zipfile.ZipFile('...').testzip()"`, что уже делают тесты) — если открытие в реальном офисном приложении недоступно в среде выполнения, явно отметить это в отчёте по задаче как непроверенное вживую (аналогично тому, как в Этапе 3 отмечалась установка на реальный телефон), но не пропускать сам шаг проверки автотестами.

- [ ] **Step 4: Реализация — `server.py`**

Добавить обработчик:

```python
    def handle_inventory_act(self, session_id: str) -> None:
        with get_connection() as connection:
            session_row = connection.execute(
                "SELECT id, started_at, finished_at, started_by, status FROM inventory_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            if session_row is None:
                self.send_json_error(HTTPStatus.NOT_FOUND, "Сессия инвентаризации не найдена.")
                return
            asset_names = {
                row["id"]: {"name": row["name"], "inventoryNumber": row["inventory_number"] or "", "location": row["location"] or ""}
                for row in connection.execute("SELECT id, name, inventory_number, location FROM assets")
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
            scanned_ids = {
                row["asset_id"]
                for row in connection.execute(
                    "SELECT asset_id FROM inventory_scans WHERE session_id = ?", (session_id,)
                )
            }
            missing_assets = [
                {"name": info["name"], "inventoryNumber": info["inventoryNumber"]}
                for asset_id, info in asset_names.items()
                if asset_id not in scanned_ids
            ]
            cached = connection.execute(
                "SELECT response_json FROM mobile_action_log WHERE response_json LIKE ? ORDER BY created_at DESC LIMIT 1",
                (f'%"sessionId": "{session_id}"%',),
            ).fetchone()
            extra_codes = []
            if cached is not None:
                extra_codes = json.loads(cached["response_json"]).get("extraCodes") or []
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
```

Добавить импорт `from act_generator import generate_inventory_act` рядом с существующим `from act_generator import generate_act` (тем же импорт-блоком, тем же `try`/`except` на случай отсутствия модуля — свериться с текущим видом этого импорта в файле).

В `do_GET`, рядом с маршрутом `/api/inventory/sessions` (маршрут с параметром в пути — по аналогии с `/api/users/<id>` в `do_PATCH`, если такой паттерн уже есть, либо через `parsed.path.startswith(...)`):

```python
        if parsed.path.startswith("/api/inventory/sessions/") and parsed.path.endswith("/act"):
            if not self.require_role(user, ("admin",)):
                return
            session_id = parsed.path[len("/api/inventory/sessions/"):-len("/act")]
            self.handle_inventory_act(session_id)
            return
```

(Разместить этот маршрут ПЕРЕД `/api/inventory/sessions` без параметра, если сравнение точным равенством идёт первым в текущем коде — иначе `/api/inventory/sessions/<id>/act` может ошибочно попасть под более общий `if parsed.path == "/api/inventory/sessions":`. Проверить порядок веток `if` при вставке.)

- [ ] **Step 5: Запустить тесты, убедиться что проходят**

Run: `python -m pytest tests/test_act_generator.py -v`
Expected: PASS

Run: `python -m pytest -q`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add act_generator.py server.py tests/test_act_generator.py
git commit -m "Task A5: generate a self-contained .docx inventory act, serve it over the API"
```

---

### Task A6: мобильный непрерывный скан — `scanner.js`

**Files:**
- Modify: `mobile/www/js/scanner.js`
- Test: `mobile/tests/scanner.test.js` (создать, если не существует — проверить)

**Interfaces:**
- Consumes: `Capacitor.Plugins.BarcodeScanner.startScan/addListener/stopScan` (плагин уже установлен).
- Produces: `Scanner.startInventoryScan(onBarcode: (rawValue: string) => void) -> Promise<void>`, `Scanner.stopInventoryScan() -> Promise<void>`. Потребляется Task A9 (экран скана инвентаризации).

**Важно:** нативный непрерывный режим рисует камеру ЗА WebView — приложение должно спрятать свою обычную разметку на время скана классом на `<body>` (официальный паттерн плагина). Это часть Task A9 (HTML/CSS), а не этой задачи — здесь только сама функция открытия/закрытия потока и подписки на событие.

- [ ] **Step 1: Написать падающий тест**

Create `mobile/tests/scanner.test.js` (или дописать, если файл уже есть):

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');

// scanner.js обращается к глобальным Capacitor.Plugins и window.capacitorBarcodeScanner
// на верхнем уровне модуля — подготовить их ДО require().
global.Capacitor = {
  Plugins: {
    BarcodeScanner: {
      requestPermissions: async () => ({ camera: 'granted' }),
      isGoogleBarcodeScannerModuleAvailable: async () => ({ available: true }),
      startScan: async () => {},
      stopScan: async () => {},
      addListener: async (eventName, callback) => {
        global.__lastBarcodeListener = callback;
        return { remove: async () => {} };
      },
      removeAllListeners: async () => {},
      scan: async () => ({ barcodes: [] }),
    },
  },
};
global.capacitorBarcodeScanner = { BarcodeFormat: { QrCode: 'QR_CODE', Code128: 'CODE_128', Code39: 'CODE_39', Code93: 'CODE_93', Codabar: 'CODABAR', Ean13: 'EAN_13', Ean8: 'EAN_8', UpcA: 'UPC_A', UpcE: 'UPC_E', Itf: 'ITF', DataMatrix: 'DATA_MATRIX' } };
global.window = global.window || {};
window.capacitorBarcodeScanner = global.capacitorBarcodeScanner;

const scanner = require('../www/js/scanner.js');

test('startInventoryScan starts the native continuous scan and forwards barcodes', async () => {
  const seen = [];
  await scanner.startInventoryScan((rawValue) => seen.push(rawValue));
  assert.equal(typeof global.__lastBarcodeListener, 'function');
  global.__lastBarcodeListener({ barcode: { rawValue: 'WH1:asset-1' } });
  assert.deepEqual(seen, ['WH1:asset-1']);
});

test('stopInventoryScan removes listeners and stops the native scan without throwing', async () => {
  await scanner.startInventoryScan(() => {});
  await assert.doesNotReject(() => scanner.stopInventoryScan());
});
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `node --test mobile/tests/scanner.test.js`
Expected: FAIL — `scanner.startInventoryScan is not a function` (текущий экспорт `window.Scanner = { scanOnce, scanConnectQr, scanLabelBarcode, scanLabelPhoto }` не содержит новых функций, а сам файл ничего не экспортирует через `module.exports` — это нужно добавить).

- [ ] **Step 3: Реализация**

Добавить в `scanner.js`, рядом с `scanLabelPhoto`:

```javascript
// Непрерывный скан для инвентаризации: камера рисуется за WebView (не
// модальным окном), каждый распознанный код прилетает в onBarcode сразу,
// без остановки потока. Вызывающий сам решает, что считать дублем.
async function startInventoryScan(onBarcode) {
  await ensureScannerReady();
  await BarcodeScanner.addListener('barcodeScanned', (result) => {
    if (result && result.barcode && typeof result.barcode.rawValue === 'string') {
      onBarcode(result.barcode.rawValue);
    }
  });
  await BarcodeScanner.startScan();
}

async function stopInventoryScan() {
  await BarcodeScanner.removeAllListeners();
  await BarcodeScanner.stopScan();
}
```

Изменить последнюю строку файла:

```javascript
window.Scanner = { scanOnce, scanConnectQr, scanLabelBarcode, scanLabelPhoto, startInventoryScan, stopInventoryScan };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { startInventoryScan, stopInventoryScan };
}
```

(Экспорт `module.exports` — новый для этого файла; проверить, что добавление этого блока не ломает загрузку файла в реальном мобильном WebView, где `module` не определён — конструкция `typeof module !== 'undefined'` уже используется точно так же в `screens.js`, скопирован существующий в проекте паттерн.)

- [ ] **Step 4: Запустить тест, убедиться что проходит**

Run: `node --test mobile/tests/scanner.test.js`
Expected: PASS

Run: `node --test mobile/tests/*.test.js`
Expected: PASS (весь мобильный набор, без регрессий)

- [ ] **Step 5: Commit**

```bash
git add mobile/www/js/scanner.js mobile/tests/scanner.test.js
git commit -m "Task A6: add continuous-scan mode to scanner.js for inventory mode"
```

---

### Task A7: локальное состояние сессии — `db.js`

**Files:**
- Modify: `mobile/www/js/db.js`
- Test: `mobile/tests/db.test.js` (проверить, есть ли уже тесты для `db.js`; если файла нет — узнать, как вообще тестируется `db.js` в этом проекте, т.к. он завязан на реальный SQLite-плагин, недоступный в `node --test`. Скорее всего для `db.js` тестов нет вовсе — тогда эта задача не пишет автотест на CRUD-функции, только на то, что можно вынести в чистую логику, см. Task A8).

**Interfaces:**
- Consumes: SCHEMA (существующая константа), `db.execute`/`db.query`/`db.run` (существующие обёртки плагина), `replaceState(state)` (существующая функция синхронизации — проверено: пишет `latestVersion`/`releaseUrl` в таблицу `meta` тем же приёмом, что здесь нужен для `activeInventorySession`).
- Produces: `Db.saveInventoryScan(sessionId, assetId, status, foundLocation) -> Promise<void>`, `Db.getInventoryScans(sessionId) -> Promise<Array<{assetId, status, foundLocation}>>`, `Db.clearInventoryScans(sessionId) -> Promise<void>`, `Db.getAllAssets() -> Promise<Array<{id, name, category, inventoryNumber, location}>>` (в проекте уже есть `getAssetById(id)`/`searchAssets(query, limit)`, но НЕТ функции "все активы без фильтра" — нужна для сверки расхождений). Потребляется Task A9.

- [ ] **Step 1: Проверить существующий подход к тестированию `db.js`**

Run: `ls mobile/tests/ | grep -i db`

Если тестов на `db.js` в проекте нет вообще (вероятно — файл целиком завязан на нативный плагин SQLite, который не поднять в `node --test`) — эта задача обходится БЕЗ TDD-цикла на сам `db.js`, только код + ручная сверка. Если тесты на `db.js` уже есть (например, через мок плагина) — повторить тот же паттерн мока для новых функций.

- [ ] **Step 2: Добавить таблицу в `SCHEMA`**

В `mobile/www/js/db.js`, в шаблонную строку `SCHEMA` (после `CREATE TABLE IF NOT EXISTS meta ...`, последней):

```sql
CREATE TABLE IF NOT EXISTS inventory_scan_state (
  session_id TEXT NOT NULL, asset_id TEXT NOT NULL, status TEXT NOT NULL,
  found_location TEXT NOT NULL DEFAULT '', scanned_at TEXT NOT NULL,
  PRIMARY KEY (session_id, asset_id)
);
```

`PRIMARY KEY (session_id, asset_id)` — повторный скан того же актива в той же сессии перезаписывает запись (не дублирует), что прямо требуется промтом задачи ("повторный скан той же — не дублируется").

- [ ] **Step 3: Добавить CRUD-функции**

Рядом с существующими функциями работы с `pending_actions` (`savePendingAction`/`getPendingActions`/...):

```javascript
async function saveInventoryScan(sessionId, assetId, status, foundLocation) {
  await db.run(
    'INSERT OR REPLACE INTO inventory_scan_state (session_id, asset_id, status, found_location, scanned_at) '
    + 'VALUES (?, ?, ?, ?, ?)',
    [sessionId, assetId, status, foundLocation || '', new Date().toISOString()],
  );
}

async function getInventoryScans(sessionId) {
  const result = await db.query(
    'SELECT asset_id, status, found_location FROM inventory_scan_state WHERE session_id = ?',
    [sessionId],
  );
  return (result.values || []).map((row) => ({
    assetId: row.asset_id,
    status: row.status,
    foundLocation: row.found_location,
  }));
}

async function clearInventoryScans(sessionId) {
  await db.run('DELETE FROM inventory_scan_state WHERE session_id = ?', [sessionId]);
}

async function getAllAssets() {
  // Тот же приём нормализации snake_case -> camelCase, что и getAssetById —
  // format.js и остальной код ниже по цепочке ожидают camelCase-поля,
  // совпадающие с JSON-формой сервера.
  const result = await db.query('SELECT * FROM assets ORDER BY name');
  return (result.values || []).map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category,
    inventoryNumber: row.inventory_number,
    location: row.location,
  }));
}
```

Добавить `saveInventoryScan`, `getInventoryScans`, `clearInventoryScans`, `getAllAssets` в список экспорта `window.Db = { ... }` (проверить точную строку экспорта — она уже есть в файле, судя по Этапу 3, где туда добавлялся `getStateMeta`).

**Ещё одна правка в этом же файле — записать активную сессию в `meta` так же, как уже пишутся `latestVersion`/`releaseUrl`.** В `replaceState(state)`, в том же месте, где уже есть:

```javascript
  txn.push({
    statement: `INSERT OR REPLACE INTO meta (key, value) VALUES ('latestVersion', ?)`,
    values: [state.latestVersion || null],
  });
  txn.push({
    statement: `INSERT OR REPLACE INTO meta (key, value) VALUES ('releaseUrl', ?)`,
    values: [state.releaseUrl || null],
  });
```

добавить третью запись:

```javascript
  txn.push({
    statement: `INSERT OR REPLACE INTO meta (key, value) VALUES ('activeInventorySession', ?)`,
    values: [state.activeInventorySession ? JSON.stringify(state.activeInventorySession) : null],
  });
```

(`state.activeInventorySession` — поле, которое `/api/state` уже отдаёт после Task A3; `hydrateState`-эквивалента на мобильном нет — `replaceState` пишет прямо из сырого ответа сервера, значения не переименовываются.)

- [ ] **Step 4: Ручная проверка**

Запустить мобильное приложение (эмулятор/устройство — если недоступно в среде выполнения, отметить как непроверенное автотестами вживую, аналогично прецеденту с `app.js`/`index.html` в предыдущих этапах), убедиться, что `inventory_scan_state` создаётся при первом открытии приложения без ошибок (`db.execute(SCHEMA)` идемпотентен — новая таблица добавляется вместе со всеми остальными при следующем открытии `open()`, без guarded-`ALTER`, т.к. таблица целиком новая — тот же приём, что уже применялся для таблицы `meta` в Этапе 3).

- [ ] **Step 5: Commit**

```bash
git add mobile/www/js/db.js
git commit -m "Task A7: add local inventory_scan_state cache table and CRUD helpers"
```

---

### Task A8: сверка расхождений — чистая функция

**Files:**
- Modify: `mobile/www/js/screens.js` (новая функция `reconcileInventory`, экспорт через существующий Node-guard)
- Test: `mobile/tests/screens.test.js`

**Interfaces:**
- Consumes: ничего внешнего — чистая функция.
- Produces: `reconcileInventory(scans: Array<{assetId, status, foundLocation}>, allAssets: Array<{id, name, inventoryNumber, location}>, extraCodes: string[]) -> {missing: Array, wrongLocation: Array, foundCount: number}`. Потребляется Task A9 (экран расхождений).

- [ ] **Step 1: Написать падающие тесты**

Добавить в `mobile/tests/screens.test.js` (тот же файл, что уже содержит `describeUpdate`-тесты из Этапа 3):

```javascript
test('reconcileInventory lists assets that were never scanned as missing', () => {
  const { reconcileInventory } = require('../www/js/screens.js');
  const result = reconcileInventory(
    [{ assetId: 'a1', status: 'found', foundLocation: '' }],
    [{ id: 'a1', name: 'Монитор', inventoryNumber: 'INV-1', location: 'Каб. 101' },
     { id: 'a2', name: 'Клавиатура', inventoryNumber: 'INV-2', location: 'Каб. 101' }],
    [],
  );
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].id, 'a2');
  assert.equal(result.foundCount, 1);
});

test('reconcileInventory separates wrong-location scans from plain found ones', () => {
  const { reconcileInventory } = require('../www/js/screens.js');
  const result = reconcileInventory(
    [{ assetId: 'a1', status: 'wrong_location', foundLocation: 'Каб. 202' }],
    [{ id: 'a1', name: 'Монитор', inventoryNumber: 'INV-1', location: 'Каб. 101' }],
    [],
  );
  assert.equal(result.missing.length, 0);
  assert.equal(result.wrongLocation.length, 1);
  assert.equal(result.wrongLocation[0].foundLocation, 'Каб. 202');
  assert.equal(result.wrongLocation[0].expectedLocation, 'Каб. 101');
});

test('reconcileInventory treats a repeat scan of the same asset as one entry, not a duplicate', () => {
  const { reconcileInventory } = require('../www/js/screens.js');
  const result = reconcileInventory(
    [{ assetId: 'a1', status: 'found', foundLocation: '' },
     { assetId: 'a1', status: 'found', foundLocation: '' }],
    [{ id: 'a1', name: 'Монитор', inventoryNumber: 'INV-1', location: 'Каб. 101' }],
    [],
  );
  assert.equal(result.foundCount, 1);
});

test('reconcileInventory passes extraCodes through unchanged', () => {
  const { reconcileInventory } = require('../www/js/screens.js');
  const result = reconcileInventory([], [], ['WH1:unknown-1', 'WH1:unknown-1']);
  assert.deepEqual(result.extra, ['WH1:unknown-1', 'WH1:unknown-1']);
});
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

Run: `node --test mobile/tests/screens.test.js`
Expected: FAIL — `reconcileInventory is not a function`.

- [ ] **Step 3: Реализация**

Добавить в `screens.js`, рядом с `describeUpdate`:

```javascript
function reconcileInventory(scans, allAssets, extraCodes) {
  const byAssetId = new Map(scans.map((scan) => [scan.assetId, scan]));
  const missing = [];
  const wrongLocation = [];
  let foundCount = 0;

  for (const asset of allAssets) {
    const scan = byAssetId.get(asset.id);
    if (!scan) {
      missing.push({ id: asset.id, name: asset.name, inventoryNumber: asset.inventoryNumber });
      continue;
    }
    if (scan.status === 'wrong_location') {
      wrongLocation.push({
        id: asset.id, name: asset.name, inventoryNumber: asset.inventoryNumber,
        expectedLocation: asset.location, foundLocation: scan.foundLocation,
      });
    } else {
      foundCount += 1;
    }
  }

  return { missing, wrongLocation, foundCount, extra: extraCodes || [] };
}
```

Добавить `reconcileInventory` в существующий Node-guard в конце файла:

```javascript
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { describeScanError, describeUpdate, reconcileInventory };
}
```

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `node --test mobile/tests/screens.test.js`
Expected: PASS

Run: `node --test mobile/tests/*.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/www/js/screens.js mobile/tests/screens.test.js
git commit -m "Task A8: add reconcileInventory, a pure discrepancy-reconciliation function"
```

---

### Task A9: мобильный UI инвентаризации — навигация и экраны

**Files:**
- Modify: `mobile/www/index.html` (пункт навигации + 3 новых `<section>`)
- Modify: `mobile/www/js/screens.js` (обработчики экранов, роль после пейринга)
- Modify: `mobile/www/js/settings.js` (хранить `role` рядом с токеном)
- Modify: `mobile/www/style.css` (стили счётчика/оверлея камеры)

**Interfaces:**
- Consumes: `Scanner.startInventoryScan`/`stopInventoryScan` (Task A6), `Db.saveInventoryScan`/`getInventoryScans`/`clearInventoryScans`/`getAllAssets`/`getStateMeta` (Task A7), `reconcileInventory` (Task A8), `parseWarehouseQr` (уже существует — используется `scanOnce`), `Db.enqueueAction` (уже существует — используется экранами выдачи/возврата), `Sync.pair` (уже существует, уже возвращает `role` — сейчас отбрасывается вызывающим кодом).

Автоматических тестов нет — `index.html`/`screens.js`-обвязка экранов без юнит-обвязки (тот же прецедент, что и в предыдущих этапах для UI-кода). Ручная проверка в финальной задаче этапа (Task C1).

- [ ] **Step 1: Разметка — `index.html`**

Добавить кнопку в нижнюю навигацию (`<nav class="bottom-nav">`), рядом с существующими `navSettingsBtn`/`navQueueBtn`, **видимую только admin** — свериться, как в этом файле уже скрываются admin-only элементы на мобильном (если такого механизма ещё нет на мобильном — на десктопе это `data-requires-role`; на мобильном роль известна из локального кэша после логина, добавить проверку в JS при рендере навигации, а не в разметке):

```html
        <button id="navInventoryBtn" class="nav-btn hidden" aria-label="Инвентаризация">Инвентаризация</button>
```

Добавить три новых `<section>` (после `screen-history`, перед закрывающим `</main>` или аналогичным местом — сверить с текущей структурой файла):

```html
  <section id="screen-inventory-start" class="screen hidden" data-back="screen-scan">
    <h2>Инвентаризация</h2>
    <p id="inventoryActiveInfo" class="muted hidden"></p>
    <button id="inventoryStartBtn" class="primary">Начать инвентаризацию</button>
  </section>

  <section id="screen-inventory-scan" class="screen hidden">
    <div id="inventoryScanOverlay" class="inventory-scan-overlay">
      <p id="inventoryCounter" class="inventory-counter">Найдено 0 из 0</p>
      <button id="inventoryFinishBtn" class="primary">Завершить</button>
    </div>
  </section>

  <section id="screen-inventory-discrepancies" class="screen hidden" data-back="screen-inventory-scan">
    <h2>Расхождения</h2>
    <div id="inventoryMissingList"></div>
    <div id="inventoryWrongLocationList"></div>
    <div id="inventoryExtraList"></div>
    <button id="inventorySubmitBtn" class="primary">Отправить на сервер</button>
  </section>
```

- [ ] **Step 2: Стили — `style.css`**

Добавить:

```css
.inventory-scan-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  padding-bottom: 32px;
  pointer-events: none;
}
.inventory-scan-overlay > * { pointer-events: auto; }
.inventory-counter {
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  padding: 8px 16px;
  border-radius: 999px;
  font-weight: 600;
  margin-bottom: 16px;
}
/* Плагин сканера рисует камеру ЗА WebView в непрерывном режиме — этот класс
   прячет всё, кроме .inventory-scan-overlay, пока идёт скан (официальный
   паттерн @capacitor-mlkit/barcode-scanning). */
body.barcode-scanner-active > *:not(#screen-inventory-scan) { visibility: hidden; }
body.barcode-scanner-active #screen-inventory-scan { background: transparent; }
```

(Свериться с реальными CSS-переменными/классами этого файла — `.primary`/`.muted`/`.hidden` уже используются в других экранах, переиспользовать как есть, не вводить новые варианты кнопок.)

- [ ] **Step 3: Хранить роль пользователя локально (нужна для видимости пункта меню)**

Роль сейчас нигде не сохраняется на телефоне. `POST /api/pair` (`auth.redeem_pairing_code`, уже в проекте) уже ВОЗВРАЩАЕТ `role`/`username` в ответе — сейчас вызывающий код просто их отбрасывает. Проверено: `mobile/www/js/settings.js`'s `Settings.get/set` хранит только `serverUrl`/`token`/`deviceSecret`.

В `mobile/www/js/settings.js` добавить `role` в оба списка полей:

```javascript
async function get(preferences = getPreferences()) {
  const [urlResult, tokenResult, secretResult, roleResult] = await Promise.all([
    preferences.get({ key: 'serverUrl' }),
    preferences.get({ key: 'authToken' }),
    preferences.get({ key: 'deviceSecret' }),
    preferences.get({ key: 'role' }),
  ]);
  return {
    serverUrl: (urlResult.value || '').replace(/\/$/, ''),
    token: tokenResult.value || '',
    deviceSecret: secretResult.value || '',
    role: roleResult.value || '',
  };
}

async function set({ serverUrl, token, deviceSecret, role }, preferences = getPreferences()) {
  await preferences.set({ key: 'serverUrl', value: (serverUrl || '').replace(/\/$/, '') });
  await preferences.set({ key: 'authToken', value: token || '' });
  await preferences.set({ key: 'deviceSecret', value: deviceSecret || '' });
  await preferences.set({ key: 'role', value: role || '' });
}
```

В `screens.js`, на месте пейринга (найти строку `const { token } = await Sync.pair(result.serverUrl, result.code);` — она в `bindEvents()`, обработчик `settingsScanBtn`) — расширить деструктуризацию и передачу роли:

```javascript
      const { token, role } = await Sync.pair(result.serverUrl, result.code);
      await Settings.set({ serverUrl: result.serverUrl, token, deviceSecret: result.secret, role });
```

(Существующий вызов `Settings.set({ serverUrl: document.getElementById('settingsUrl').value, token: current.token, deviceSecret: current.deviceSecret })`, чуть выше по файлу — там, где меняют только URL сервера, — тоже поправить, добавив `role: current.role`, иначе роль потеряется при следующем сохранении настроек.)

- [ ] **Step 4: Логика экранов инвентаризации — `screens.js`**

Добавить состояние модуля и функции рядом с остальными обработчиками экранов:

```javascript
let currentInventorySessionId = null;
let inventoryAllAssets = [];
// Нераспознанные/чужие коды этой сессии — не персистентны между перезапусками
// приложения (осознанное упрощение MVP: переживать убийство приложения для
// "лишнего" не так важно, как для счётчика найденного, который восстанавливается
// из Db.getInventoryScans).
let extraCodesThisSession = [];

async function openInventoryStartScreen() {
  const meta = await Db.getStateMeta();
  const active = meta.activeInventorySession ? JSON.parse(meta.activeInventorySession) : null;
  const infoEl = document.getElementById('inventoryActiveInfo');
  if (active) {
    infoEl.textContent = `Инвентаризация уже начата (${active.startedBy}). Продолжить.`;
    infoEl.classList.remove('hidden');
    currentInventorySessionId = active.id;
  } else {
    infoEl.classList.add('hidden');
    currentInventorySessionId = null;
  }
  showScreen('screen-inventory-start');
}

async function startInventoryScanning() {
  if (!currentInventorySessionId) {
    const response = await apiFetch('/api/inventory/start', { method: 'POST' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      showToast(body.error || 'Не удалось начать инвентаризацию.', 'error');
      return;
    }
    const body = await response.json();
    currentInventorySessionId = body.sessionId;
  }

  inventoryAllAssets = await Db.getAllAssets();
  const alreadyScanned = await Db.getInventoryScans(currentInventorySessionId);
  let foundCount = alreadyScanned.length;
  const seen = new Set(alreadyScanned.map((s) => s.assetId));
  extraCodesThisSession = [];

  showScreen('screen-inventory-scan');
  document.body.classList.add('barcode-scanner-active');
  document.getElementById('inventoryCounter').textContent = `Найдено ${foundCount} из ${inventoryAllAssets.length}`;

  // parseWarehouseQr (qr.js) returns the bare asset id string (or null) — NOT
  // an object. It only validates the "WH1:" prefix, not that the id actually
  // exists — a code from a deleted/foreign asset must land in "extra", not be
  // silently recorded as "found" (inventory_scans has an FK on asset_id, so a
  // bogus id would otherwise fail server-side when the session is submitted).
  const knownAssetIds = new Set(inventoryAllAssets.map((a) => a.id));
  await Scanner.startInventoryScan(async (rawValue) => {
    const assetId = parseWarehouseQr(rawValue);
    if (!assetId || !knownAssetIds.has(assetId)) {
      extraCodesThisSession.push(rawValue);
      return;
    }
    if (seen.has(assetId)) return; // повторный скан — не дублируется
    seen.add(assetId);
    await Db.saveInventoryScan(currentInventorySessionId, assetId, 'found', '');
    foundCount += 1;
    document.getElementById('inventoryCounter').textContent = `Найдено ${foundCount} из ${inventoryAllAssets.length}`;
  });
}

async function finishInventoryScanning() {
  await Scanner.stopInventoryScan();
  document.body.classList.remove('barcode-scanner-active');
  const scans = await Db.getInventoryScans(currentInventorySessionId);
  const result = reconcileInventory(scans, inventoryAllAssets, extraCodesThisSession);
  renderInventoryDiscrepancies(result);
  showScreen('screen-inventory-discrepancies');
}

function renderInventoryDiscrepancies(result) {
  document.getElementById('inventoryMissingList').innerHTML =
    '<h3>Не найдено</h3>' + result.missing.map((a) => `<p>${escapeHtml(a.name)}</p>`).join('');
  document.getElementById('inventoryWrongLocationList').innerHTML =
    '<h3>Не на своём месте</h3>' + result.wrongLocation.map((a) =>
      `<p>${escapeHtml(a.name)}: ${escapeHtml(a.expectedLocation)} → ${escapeHtml(a.foundLocation)}</p>`).join('');
  document.getElementById('inventoryExtraList').innerHTML =
    '<h3>Лишнее</h3>' + result.extra.map((code) => `<p>${escapeHtml(code)}</p>`).join('');
}

async function submitInventoryResult() {
  const scans = await Db.getInventoryScans(currentInventorySessionId);
  // Db.enqueueAction сам генерирует clientActionId и кладёт запись в pending_actions —
  // тот же путь, которым уже идут выдача/возврат (см. вызовы этой функции выше по файлу).
  await Db.enqueueAction({
    type: 'inventory_complete',
    sessionId: currentInventorySessionId,
    scans: scans.map((s) => ({ assetId: s.assetId, status: s.status, foundLocation: s.foundLocation })),
    extraCodes: extraCodesThisSession,
  });
  await Db.clearInventoryScans(currentInventorySessionId);
  currentInventorySessionId = null;
  extraCodesThisSession = [];
  showToast('Инвентаризация отправлена в очередь синхронизации.', 'success');
  showScreen('screen-scan');
}
```

**Проверить перед вставкой:** `escapeHtml`, `showToast`, `apiFetch`, `parseWarehouseQr`, `showScreen` — все уже существуют в проекте (использовались в Этапах 2-3), сверить точные имена/сигнатуры в реальном `screens.js` перед использованием (они не менялись этим планом, только читаются).

Добавить в `bindEvents()`:

```javascript
  document.getElementById('navInventoryBtn')?.addEventListener('click', openInventoryStartScreen);
  document.getElementById('inventoryStartBtn')?.addEventListener('click', startInventoryScanning);
  document.getElementById('inventoryFinishBtn')?.addEventListener('click', finishInventoryScanning);
  document.getElementById('inventorySubmitBtn')?.addEventListener('click', submitInventoryResult);
```

Показать/скрыть `navInventoryBtn` по роли (первый случай ролевого скрытия элементов на мобильном — на десктопе это `data-requires-role`, на мобильном такого механизма ещё не было; роль теперь читаема через `Settings.get()`, Step 3). В `boot()`-эквиваленте мобильного приложения (место, где уже вызывается что-то вроде `refreshQueueCount()`/`ConnStatus.report(...)` при старте — найти реальную точку входа после успешной загрузки настроек) добавить:

```javascript
async function applyRoleVisibility() {
  const { role } = await Settings.get();
  document.getElementById('navInventoryBtn')?.classList.toggle('hidden', role !== 'admin');
}
```

Вызвать `applyRoleVisibility()` там же, где приложение читает сохранённые настройки при старте (и повторно — сразу после успешного пейринга в Step 3, т.к. до пейринга роль ещё не была известна и кнопка должна была быть скрыта по умолчанию `class="nav-btn hidden"`, как уже прописано в разметке Step 1).

- [ ] **Step 5: Ручная проверка**

Запустить мобильное приложение (эмулятор/устройство), под admin: открыть "Инвентаризация" → "Начать" → камера должна остаться открытой между сканами (без модалок) → счётчик растёт → "Завершить" → экран расхождений с реальными списками → "Отправить" → тост подтверждения. Отдельно — под storekeeper/viewer: пункта "Инвентаризация" в навигации быть не должно. Если реальное устройство/эмулятор недоступны в среде выполнения — отметить как непроверенное вживую, аналогично прецеденту предыдущих этапов, и явно перечислить, что именно проверено только чтением кода.

- [ ] **Step 6: Commit**

```bash
git add mobile/www/index.html mobile/www/js/screens.js mobile/www/js/settings.js mobile/www/style.css
git commit -m "Task A9: wire up mobile inventory screens (start, continuous scan, discrepancies, submit)"
```

---

### Task A10: десктоп — модалка "Инвентаризации"

**Files:**
- Modify: `index.html` (кнопка + модалка)
- Modify: `app.js` (`openInventoryModal`/`closeInventoryModal`/`renderInventorySessionsTable`)
- Modify: `styles.css` (при необходимости — переиспользовать существующие классы модалок/таблиц)

**Interfaces:**
- Consumes: `GET /api/inventory/sessions` (Task A4), `GET /api/inventory/sessions/<id>/act` (Task A5), `state.activeInventorySession` (Task A3), `apiFetch`/`showToast`/`escapeHtml`/`data-requires-role` (уже существуют).

Автоматических тестов нет — тот же прецедент, что и в предыдущих этапах для `app.js`/`index.html`. Ручная проверка в Task C1.

- [ ] **Step 1: Разметка — `index.html`**

Кнопка в сайдбаре, рядом с `showSettingsBtn`/`showBackupsBtn` (блок "Данные"/"Сеанс" — свериться, куда логичнее по текущей структуре сайдбара):

```html
        <button id="showInventoryBtn" class="secondary" data-requires-role="admin">Инвентаризации</button>
```

Модалка рядом с `settingsOverlay`:

```html
  <div id="inventoryOverlay" class="modal-overlay hidden">
    <div class="operation-modal wide">
      <div class="modal-header">
        <h3>Инвентаризации</h3>
        <button type="button" class="modal-close" id="closeInventoryBtn">Закрыть</button>
      </div>
      <p id="inventoryActiveBanner" class="hidden"></p>
      <table id="inventorySessionsTable">
        <thead>
          <tr><th>Дата</th><th>Исполнитель</th><th>Статус</th><th>Найдено</th><th>Не найдено</th><th>Не на месте</th><th>Лишнее</th><th></th></tr>
        </thead>
        <tbody id="inventorySessionsBody"></tbody>
      </table>
    </div>
  </div>
```

- [ ] **Step 2: Логика — `app.js`**

Добавить рядом с `openBackupsModal`/`renderBackupsTable`:

```javascript
async function openInventoryModal() {
  document.getElementById("inventoryOverlay").classList.remove("hidden");
  await renderInventorySessionsTable();
}

function closeInventoryModal() {
  document.getElementById("inventoryOverlay").classList.add("hidden");
}

async function renderInventorySessionsTable() {
  const banner = document.getElementById("inventoryActiveBanner");
  if (state.activeInventorySession) {
    banner.textContent = `Сейчас идёт инвентаризация (${state.activeInventorySession.startedBy}, начата ${state.activeInventorySession.startedAt}).`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }

  const response = await apiFetch("/api/inventory/sessions");
  if (!response.ok) {
    showToast("Не удалось загрузить список инвентаризаций.", "error");
    return;
  }
  const data = await response.json();
  const tbody = document.getElementById("inventorySessionsBody");
  tbody.innerHTML = data.sessions.map((s) => `
    <tr>
      <td>${escapeHtml(s.startedAt)}</td>
      <td>${escapeHtml(s.startedBy)}</td>
      <td>${s.status === "open" ? "Идёт" : "Завершена"}</td>
      <td>${s.foundCount}</td>
      <td>${s.missingCount}</td>
      <td>${s.wrongLocationCount}</td>
      <td>${s.extraCount}</td>
      <td>${s.status === "finished" ? `<button type="button" class="secondary download-inventory-act-btn" data-session-id="${s.id}">Акт</button>` : ""}</td>
    </tr>
  `).join("");
}

async function downloadInventoryAct(sessionId) {
  // Тот же приём, что уже используется для акта выдачи/возврата (см. вызов
  // /api/act выше по файлу): apiFetch несёт заголовок авторизации, поэтому
  // обычная <a href> ссылка не подойдёт — сервер потребует Bearer-токен,
  // которого у прямого перехода по ссылке нет.
  const response = await apiFetch(`/api/inventory/sessions/${sessionId}/act`);
  if (!response.ok) {
    showToast("Не удалось скачать акт.", "error");
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `inventory_act_${sessionId.slice(0, 8)}.docx`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
```

Добавить в `bindEvents()`:

```javascript
  document.getElementById("showInventoryBtn")?.addEventListener("click", openInventoryModal);
  document.getElementById("closeInventoryBtn")?.addEventListener("click", closeInventoryModal);
  document.getElementById("inventoryOverlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("inventoryOverlay")) closeInventoryModal();
  });
  document.getElementById("inventorySessionsBody")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".download-inventory-act-btn");
    if (btn) downloadInventoryAct(btn.dataset.sessionId);
  });
```

- [ ] **Step 3: Ручная проверка**

Запустить сервер локально, войти как admin: открыть "Инвентаризации" — пустой список (если ещё ни одной не было). Провести тестовую инвентаризацию с телефона (или через прямые запросы к API, как в Task A3/A4 тестах) — убедиться, что завершённая сессия появляется в таблице с правильными числами и акт скачивается. Если реальный телефон недоступен — прогнать через `curl`/`python -c` тот же сценарий, что в тестах Task A3/A4, и открыть модалку в браузере, указав вручную созданные тестовые данные.

- [ ] **Step 4: Commit**

```bash
git add index.html app.js styles.css
git commit -m "Task A10: add desktop 'Инвентаризации' modal with session list and act download"
```

---

## Задача B — печать QR-этикеток пачкой

### Task B1: миграция 027 — `assets.label_printed_at`

**Files:**
- Modify: `migrations.py`, `schema.sql`
- Modify: `server.py` (`export_state` — иначе колонка есть в БД, но никогда не долетает до браузера)
- Modify: `app.js` (`normalizeAsset` — та же ловушка allow-list полей, что уже была с `hydrateState` в Этапе 3, см. Task A3)
- Test: `tests/test_migrations.py`, `tests/test_server_auth.py`

**Interfaces:**
- Produces: колонка `assets.label_printed_at TEXT` (пусто, если не печаталась), поле `labelPrintedAt` в JSON-активах из `GET /api/state` и в `state.assets[]` на десктопе. Потребляется Task B2/B3 (фильтр "непечатавшиеся").

- [ ] **Step 1: Написать падающий тест**

Тот же паттерн, что уже есть в `tests/test_migrations.py` для миграции 025 (`test_migration_025_adds_assets_rev_column`/`test_migration_025_defaults_existing_rows_to_zero`, фикстура `legacy_conn` — БД по `LEGACY_SCHEMA` с уже посеянным активом `ast_1`). Добавить в конец файла:

```python
def test_migration_027_adds_label_printed_at_column(legacy_conn):
    migrations.run_migrations(legacy_conn)
    columns = {row["name"] for row in legacy_conn.execute("PRAGMA table_info(assets)")}
    assert "label_printed_at" in columns


def test_migration_027_defaults_existing_rows_to_null(legacy_conn):
    migrations.run_migrations(legacy_conn)
    row = legacy_conn.execute("SELECT label_printed_at FROM assets WHERE id='ast_1'").fetchone()
    assert row["label_printed_at"] is None
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `python -m pytest tests/test_migrations.py -v -k label_printed`
Expected: FAIL — `sqlite3.OperationalError: no such column: label_printed_at`.

- [ ] **Step 3: Реализация**

Добавить в `migrations.py`:

```python
def _migrate_027_label_printed_at(c):
    _add_column_if_missing(c, "assets", "label_printed_at", "label_printed_at TEXT")
```

Зарегистрировать в `MIGRATIONS`:

```python
    (27, "assets.label_printed_at", _migrate_027_label_printed_at),
```

Добавить `label_printed_at TEXT` в таблицу `assets` в `schema.sql` (той же колонкой, что и остальные опциональные поля — рядом с `photo_url`).

**Прокинуть колонку до браузера — без этого фильтр Task B3 не увидит значение никогда.** В `server.py`'s `export_state()`, в SQL-запросе, что читает активы (`"SELECT id, name, category, ..., photo_url, rev FROM assets ORDER BY name"`), добавить `label_printed_at` в список колонок (после `photo_url`, перед `rev`). В словаре, который строится из каждой строки (рядом с `"photoUrl": row["photo_url"] or "",`), добавить:

```python
                    "labelPrintedAt": row["label_printed_at"] or None,
```

В `app.js`'s `normalizeAsset(asset)`, рядом с `photoUrl: asset.photoUrl || "",`, добавить:

```javascript
    labelPrintedAt: asset.labelPrintedAt || null,
```

Добавить тест в `tests/test_server_auth.py`, подтверждающий, что поле реально долетает через `/api/state` (а не только существует в БД):

```python
def test_state_includes_label_printed_at_for_assets(live_server):
    token = _create_admin(live_server)
    with sqlite3.connect(server.DB_PATH) as conn:
        conn.execute("INSERT INTO assets (id, name, label_printed_at) VALUES (?, ?, ?)",
                     ("a1", "Монитор", "2026-09-02T10:00:00+00:00"))
        conn.execute("INSERT INTO assets (id, name) VALUES (?, ?)", ("a2", "Клавиатура"))
        conn.commit()
    status, body = _request(live_server, "GET", "/api/state", token=token)
    by_id = {a["id"]: a for a in body["assets"]}
    assert by_id["a1"]["labelPrintedAt"] == "2026-09-02T10:00:00+00:00"
    assert by_id["a2"]["labelPrintedAt"] is None
```

(Свериться с тем, как другие тесты в этом файле уже пишут напрямую в `server.DB_PATH` через `sqlite3.connect` — скопировать реальный уже используемый паттерн, если он отличается от показанного здесь.)

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `python -m pytest tests/test_migrations.py tests/test_server_auth.py -v -k label_printed`
Expected: PASS

Run: `python -m pytest -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add migrations.py schema.sql server.py app.js tests/test_migrations.py tests/test_server_auth.py
git commit -m "Task B1: add assets.label_printed_at (migration 027), expose it through /api/state"
```

---

### Task B2: `POST /api/assets/label-printed` — массовая отметка

**Files:**
- Modify: `server.py` (`do_POST`, новый `handle_mark_labels_printed`)
- Test: `tests/test_server_auth.py`

**Interfaces:**
- Consumes: `assets.label_printed_at` (Task B1).
- Produces: `POST /api/assets/label-printed` (admin ИЛИ storekeeper — печать этикеток не такое чувствительное действие, как инвентаризация; свериться с ролями, которым доступна работа с активами в принципе, и дать тот же уровень доступа) `{"assetIds": [str, ...]}` → `{"updated": int}`.

- [ ] **Step 1: Написать падающий тест**

```python
def test_marking_labels_printed_updates_the_timestamp(live_server):
    token = _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/act", token=token, json_body={})  # прогреть соединение, не обязательно
    with sqlite3.connect(server.DB_PATH) as conn:
        conn.execute("INSERT INTO assets (id, name) VALUES (?, ?)", ("a1", "Монитор"))
        conn.commit()
    status, body = _request(live_server, "POST", "/api/assets/label-printed", token=token,
                            json_body={"assetIds": ["a1"]})
    assert status == 200, body
    assert body["updated"] == 1
    with sqlite3.connect(server.DB_PATH) as conn:
        row = conn.execute("SELECT label_printed_at FROM assets WHERE id = 'a1'").fetchone()
    assert row[0]


def test_marking_labels_printed_ignores_unknown_ids(live_server):
    token = _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/assets/label-printed", token=token,
                            json_body={"assetIds": ["does-not-exist"]})
    assert status == 200
    assert body["updated"] == 0
```

(Убрать прогревочный `/api/act`-вызов, если он не нужен — вставлен на случай, если `get_connection()`/`server.DB_PATH` в тестах требует, чтобы БД уже была создана; свериться с тем, как другие тесты в этом файле уже пишут напрямую в `server.DB_PATH` — вероятно, там уже есть готовый паттерн прямой вставки через `sqlite3.connect(server.DB_PATH)`, скопировать его вместо придуманного выше.)

- [ ] **Step 2: Запустить тесты, убедиться что падают**

Run: `python -m pytest tests/test_server_auth.py -v -k label_printed`
Expected: FAIL — 404.

- [ ] **Step 3: Реализация**

```python
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
```

В `do_POST`, рядом с `/api/settings`:

```python
        if parsed.path == "/api/assets/label-printed":
            if not self.require_role(user, ("admin", "storekeeper")):
                return
            self.handle_mark_labels_printed(body)
            return
```

- [ ] **Step 4: Запустить тесты, убедиться что проходят**

Run: `python -m pytest tests/test_server_auth.py -v -k label_printed`
Expected: PASS

Run: `python -m pytest -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server.py tests/test_server_auth.py
git commit -m "Task B2: add POST /api/assets/label-printed for bulk label-printed marking"
```

---

### Task B3: фильтры по категории/месту и "не печатались ранее" в уже существующем мастере печати

**Важное открытие, меняющее объём Задачи B относительно спеки:** мастер печати этикеток **уже полностью реализован** в этом репозитории — `openLabelsModal`/`renderLabelGrid`/`getLabelAssets`/`getSelectedLabelItems`/`printLabels`/`quickPrintLabel` в `app.js`, разметка `#labelsOverlay` в `index.html`. Уже есть: свободный текстовый поиск (`labelSearchInput`), ручной выбор чекбоксами, "Выбрать все"/"Снять все" (работают по ТЕКУЩЕ ОТФИЛЬТРОВАННОМУ списку — `labelSelectAll` перебирает то, что `renderLabelGrid` уже отрисовал), настраиваемый размер этикетки и число колонок, печать через `window.open()` + `window.print()` (`printLabels()`), предпросмотр листа A4 (`openLabelPreview`), экспорт в JPG/Excel, и кнопка "Напечатать этикетку" на карточке актива (`quickPrintLabel`, уже подключена через `data-action="quick-label"`). Из требований промта Этапа 4 реально отсутствуют только: **фильтр по категории**, **фильтр по месту** и **"без этикетки не печатались ранее"** — это единственное, что добавляет эта задача. Task B4 (старый план — построить мастер печати с нуля) и Task B5 (кнопка на карточке) **удалены из плана как полностью дублирующие уже существующий код** — ничего строить не нужно.

**Files:**
- Modify: `index.html` (`#labelsOverlay` — 3 новых контрола рядом с `labelSearchInput`)
- Modify: `app.js` (`getLabelAssets`, плюс заполнение выпадающих списков категорий/мест)

**Interfaces:**
- Consumes: `state.assets[].category`/`.location`/`.labelPrintedAt` (последнее — Task B1 уже прокинуло поле через `normalizeAsset`).

Автоматических тестов нет — тот же прецедент, что и у остального `app.js`/`index.html` в предыдущих этапах (`getLabelAssets`/`renderLabelGrid` и так уже без тестов). Ручная проверка в Task C1.

- [ ] **Step 1: Разметка — `index.html`**

В `.label-select-actions` (рядом с существующим `labelSearchInput`, строка `<input class="search" id="labelSearchInput" placeholder="Поиск…" ...>`), добавить:

```html
        <select id="labelFilterCategory">
          <option value="">Все категории</option>
        </select>
        <select id="labelFilterLocation">
          <option value="">Все места</option>
        </select>
        <label style="gap:6px"><input type="checkbox" id="labelUnprintedCheck" style="width:15px;height:15px;accent-color:var(--brand)"> Не печатались ранее</label>
```

- [ ] **Step 2: Реализация — `app.js`**

Заменить `getLabelAssets()`:

```javascript
function getLabelAssets() {
  const q = (document.getElementById("labelSearchInput")?.value || "").trim().toLowerCase();
  const category = document.getElementById("labelFilterCategory")?.value || "";
  const location = document.getElementById("labelFilterLocation")?.value || "";
  const onlyUnprinted = document.getElementById("labelUnprintedCheck")?.checked || false;
  return state.assets.filter(a => {
    if (category && a.category !== category) return false;
    if (location && a.location !== location) return false;
    if (onlyUnprinted && a.labelPrintedAt) return false;
    if (!q) return true;
    return [a.name, a.category, a.inventoryNumber, a.serialNumber].join(" ").toLowerCase().includes(q);
  });
}

function populateLabelFilterDropdowns() {
  const categories = [...new Set(state.assets.map((a) => a.category).filter(Boolean))].sort();
  const locations = [...new Set(state.assets.map((a) => a.location).filter(Boolean))].sort();
  const categorySelect = document.getElementById("labelFilterCategory");
  const locationSelect = document.getElementById("labelFilterLocation");
  if (categorySelect) {
    categorySelect.innerHTML = '<option value="">Все категории</option>'
      + categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  }
  if (locationSelect) {
    locationSelect.innerHTML = '<option value="">Все места</option>'
      + locations.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("");
  }
}
```

В `openLabelsModal()` — вызвать заполнение выпадающих списков до рендера сетки (список категорий/мест не меняется, пока модалка открыта, поэтому достаточно один раз при открытии):

```javascript
function openLabelsModal() {
  document.getElementById("labelsOverlay").classList.remove("hidden");
  populateLabelFilterDropdowns();
  renderLabelGrid();
}
```

Добавить обработчики новых контролов рядом с существующим `labelSearchInput`'s `addEventListener("input", debounce(renderLabelGrid))`:

```javascript
  document.getElementById("labelFilterCategory")?.addEventListener("change", renderLabelGrid);
  document.getElementById("labelFilterLocation")?.addEventListener("change", renderLabelGrid);
  document.getElementById("labelUnprintedCheck")?.addEventListener("change", renderLabelGrid);
```

- [ ] **Step 3: Ручная проверка**

Открыть "Печать этикеток", выбрать категорию в новом фильтре — сетка сужается до этой категории, "Выбрать все" выбирает только отфильтрованные. То же для места. Отметить "Не печатались ранее" — активы, у которых уже проставлен `labelPrintedAt` (см. Task B4), пропадают из списка. Комбинация фильтров (категория + непечатавшиеся) работает одновременно (через логическое И, как в `getLabelAssets`).

- [ ] **Step 4: Commit**

```bash
git add index.html app.js
git commit -m "Task B3: add category/location/unprinted filters to the existing label print wizard"
```

---

### Task B4: отмечать активы напечатанными после `printLabels()`

**Files:**
- Modify: `app.js` (`printLabels`)

**Interfaces:**
- Consumes: `POST /api/assets/label-printed` (Task B2).

- [ ] **Step 1: Реализация**

Изменить существующую `printLabels()` — после того, как `labels` (плоский список активов с учётом количества на каждый) уже собран и печатное окно открыто, добавить вызов отметки (дедуплицировать id — один и тот же актив мог попасть в `labels` несколько раз при количестве > 1):

```javascript
function printLabels() {
  const items = getSelectedLabelItems();
  if (!items.length) { showToast('Выберите хотя бы одну позицию.', 'warning'); return; }
  const { w, h } = getLabelSize();
  const cols = Math.max(1, parseInt(document.getElementById("labelColsInput")?.value || 3));
  const showInv = document.getElementById("labelInvCheck")?.checked ?? true;
  const showQr = document.getElementById("labelQrCheck")?.checked ?? true;
  const showLoc = document.getElementById("labelLocCheck")?.checked ?? false;

  const labels = [];
  items.forEach(({ asset, qty }) => {
    for (let i = 0; i < qty; i++) labels.push(asset);
  });

  let tableHtml = "";
  for (let i = 0; i < labels.length; i += cols) {
    const chunk = labels.slice(i, i + cols);
    tableHtml += "<tr>" + chunk.map(a => `<td style="padding:2mm">${buildLabelHtml(a, {showInv, showQr, showLoc, width:w, height:h})}</td>`).join("") + "</tr>";
  }

  const pw = window.open("", "_blank", "width=1000,height=800");
  if (!pw) return;
  pw.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Этикетки</title>
  <style>
    @page { margin: 8mm; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: Arial, sans-serif; background: #fff; margin: 0; }
    table { border-collapse: collapse; width: 100%; }
    td { vertical-align: top; }
  </style></head><body>
  <table>${tableHtml}</table>
  <script>window.onload = () => { setTimeout(() => { window.print(); }, 800); }<\/script>
  </body></html>`);
  pw.document.close();

  markLabelsPrinted([...new Set(items.map(({ asset }) => asset.id))]);
}

async function markLabelsPrinted(assetIds) {
  try {
    await apiFetch("/api/assets/label-printed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetIds }),
    });
  } catch (err) {
    // Тихая неудача: печать уже отправлена пользователю, отметка "напечатано"
    // — вспомогательная функция для фильтра, не стоит мешать печати тостом об ошибке.
    console.error("Не удалось отметить этикетки как напечатанные:", err);
  }
}
```

(Изменения в `printLabels()` — только добавленная последняя строка `markLabelsPrinted(...)` и новая функция `markLabelsPrinted`; тело функции до этой строки переписано здесь целиком просто для контекста вставки, реально трогается только конец функции.)

**Обновление `state.assets` после отметки:** отметка происходит на сервере, но текущий `state` в браузере не узнает о новом `labelPrintedAt` до следующего цикла синхронизации (существующий поллинг `/api/state`, как и во всех остальных местах приложения) — значит фильтр "Не печатались ранее" в ЭТОЙ ЖЕ открытой модалке не обновится мгновенно после печати. Это приемлемо (тот же принцип синхронизации, что и у остального состояния в проекте) — не заводить отдельный немедленный локальный патч `state.assets` ради этого узкого случая.

- [ ] **Step 2: Ручная проверка**

Запустить сервер локально, открыть "Печать этикеток", выбрать несколько позиций, нажать "Распечатать" — открывается окно печати (как раньше), и в БД у выбранных активов проставляется `label_printed_at` (проверить `sqlite3` напрямую или дождаться следующего `/api/state` и открыть мастер заново с фильтром "Не печатались ранее" — эти позиции больше не должны попадать в список).

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "Task B4: mark assets as label-printed after printLabels()"
```

---

## Задача C — финальная верификация этапа

### Task C1: полная верификация и пересборка

**Files:** none (проверка; правки только если что-то не сойдётся)

- [ ] **Step 1: Полный серверный набор**

Run: `python -m pytest -q`
Expected: все тесты зелёные (записать фактическое число — должно быть больше 251, полученных в конце Этапа 3, минимум на новые тесты Task A1/A2/A3/A4/A5/B1/B2).

- [ ] **Step 2: Полный мобильный набор**

Run: `node --test mobile/tests/*.test.js`
Expected: все тесты зелёные.

- [ ] **Step 3: Тест выбора этикеток**

Run: `node --test tests/label-selection.test.js`
Expected: все тесты зелёные (если в Step 3 Задачи B3 тест положили в другое место — запустить оттуда).

- [ ] **Step 4: Ручной сквозной прогон — инвентаризация**

На реальном (или максимально приближённом) окружении:
1. Войти как admin на десктопе и на телефоне.
2. С телефона: "Инвентаризация" → "Начать" → отсканировать несколько известных активов подряд БЕЗ закрытия камеры между сканами — убедиться, что счётчик растёт без модальных окон.
3. Убрать сеть (авиарежим) в процессе — убедиться, что приложение не падает, сканы продолжают копиться локально.
4. Убить и снова открыть приложение — убедиться, что сессия и уже сделанные сканы никуда не делись.
5. Вернуть сеть, "Завершить" → экран расхождений показывает реальные "не найдено"/"лишнее"/"не на своём месте".
6. "Отправить" → дождаться синхронизации (до 15 секунд).
7. На десктопе открыть "Инвентаризации" → завершённая сессия видна с правильными числами → скачать "Акт" → открыть `.docx` (Word/LibreOffice, если доступно в среде — иначе зафиксировать как непроверенное вживую, но подтвердить валидность zip/OOXML автотестами Task A5).

Любое расхождение с ожидаемым — дефект, чинить до завершения задачи, не закрывать с необработанным пробелом (тот же принцип, что и в Этапе 3).

- [ ] **Step 5: Ручной сквозной прогон — печать этикеток**

На десктопе: открыть "Печать этикеток", проверить новые фильтры (категория/место/непечатавшиеся — Task B3) сужают список так, как ожидается, "Выбрать все" выбирает ровно отфильтрованное. Нажать "Распечатать" (`printLabels()`) — открывается окно печати браузера с сеткой этикеток (или как минимум открыть системный предпросмотр печати и визуально проверить, что на листе ТОЛЬКО сетка этикеток) — если есть смартфон с этим же приложением, отсканировать напечатанный/показанный на экране QR и убедиться, что он корректно открывает нужный актив. Проверить, что выбранные активы получили `label_printed_at` (Task B4) и пропали из фильтра "Не печатались ранее" при следующем открытии. Отдельно проверить кнопку "Напечатать этикетку" на карточке одного актива (`quickPrintLabel`, уже существовал до этого плана) — по-прежнему открывает мастер с этим одним активом выбранным.

- [ ] **Step 6: Пересобрать EXE и APK**

Run: `pyinstaller WarehouseApp_New.spec --noconfirm`
Expected: `dist/WarehouseApp_New.exe` собран.

Run:
```bash
cd mobile
npx cap sync android
cd android
./gradlew.bat assembleDebug
```
Expected: BUILD SUCCESSFUL (debug-сборки достаточно для этого этапа — release ещё раз пересобирать незачем, подпись не менялась; если нужен release для реального теста на устройстве — использовать существующий `keystore.properties`, ничего не регенерировать).

- [ ] **Step 7: Commit** (только если Steps 1-6 потребовали правок кода; иначе у задачи своего коммита нет — она проверочный шлюз над коммитами A1-B5)
