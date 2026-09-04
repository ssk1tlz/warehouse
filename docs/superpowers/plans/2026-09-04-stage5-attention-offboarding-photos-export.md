# Этап 5: панель внимания, обходной лист, фото, экспорт — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Панель "Требует внимания" (гарантия/остатки/ремонт) на десктопе и мобильном, экран сотрудника с обходным листом при увольнении, фото техники с телефона (офлайн-safe), экспорт CSV/`.docx`-ведомостей — всё на существующих полях схемы, без новых миграций БД.

**Architecture:** Сервер — одна новая чистая функция (`compute_attention_items`) и один новый бинарный upload-путь (`/api/assets/<id>/photo`), оба встраиваются в уже существующие `export_state()`/маршрутизацию `do_GET`/`do_POST`. Десктоп и мобильный — независимые UI поверх одних и тех же новых полей `/api/state` (`attentionItems`) и существующих (`status`, `photoUrl`). Мобильная часть Задачи C — отдельная локальная очередь (`pending_photo_uploads`), не через `pending_actions` (бинарник не JSON-действие).

**Tech Stack:** Python stdlib (`http.server`, `sqlite3`), vanilla JS (десктоп `app.js`/`index.html`), Capacitor 8 + vanilla JS (мобильный `mobile/www/js/*.js`), `pytest`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-04-stage5-attention-offboarding-photos-export-design.md`

## Global Constraints

- Полностью бесплатно, офлайн-first, без новых JS-библиотек; Python — только stdlib.
- Русский интерфейс и текст ошибок — как во всём проекте.
- Не ломать очередь мобильных действий, дедупликацию, роли, существующие миграции.
- Ни одна задача этого плана не добавляет новую таблицу/колонку в серверную БД (`schema.sql` не трогаем) — все нужные поля (`min_quantity`, `warranty_end`, `photo_url`, `employees.status`) уже есть.
- Коммит после каждой задачи; `pytest -q` и `node --test` (в `mobile/`) — зелёные после каждой.
- Фото: одно на актив (замена при повторной съёмке), сервер хранит файлы вне `/api/state` — только по запросу.
- Экран сотрудника и обходной лист на мобильном — доступны только роли `admin`.

---

## Файловая карта (что и зачем меняется)

- **`server.py`** — `compute_attention_items()` (новая, чистая), правка `import_state()` (сохранение `photo_url` как server-owned поля — Задача C), новые маршруты `/api/settings` (расширение), `POST`/`GET /api/assets/<id>/photo`, расширение `handle_act_request` опциональным `actionPhrase`.
- **`paths.py`** — `UPLOADS_DIR = DATA_DIR / "uploads"`.
- **`act_generator.py`** — `generate_act()`/`_build_placeholders()` принимают опциональный `action_phrase` (override для `ISSUE_PHRASE`/`RETURN_PHRASE`), новая константа `HANDOVER_PHRASE`.
- **`app.js`/`index.html`/`styles.css`** — блок "Требует внимания", фильтр уволенных в `issueEmployeeSelect`, замена поля "Фото (URL)" на превью, три новых CSV-экспорта, кнопка "Ведомость на подпись".
- **`mobile/www/js/db.js`** — `employees.status` (новая колонка + guarded ALTER), новая таблица `pending_photo_uploads`, новые функции `searchEmployees`, `getAllocationsForEmployee`, CRUD для очереди фото.
- **`mobile/www/js/screens.js`** + **`mobile/www/index.html`** — пункт навигации "Сотрудники", экраны поиска/списка/обходного листа, экран "Требует внимания", кнопка "Сфотографировать" на карточке актива.
- **`mobile/www/js/sync.js`** (или где живёт `Sync.run()`) — фоновая докачка `pending_photo_uploads`.

---

## Задача A — панель "Требует внимания"

### Task A1: `compute_attention_items` + встраивание в `export_state()`

**Files:**
- Modify: `server.py` (новая функция рядом с `export_state()`, ~строка 449; вызов внутри `export_state()`)
- Test: `tests/test_server_attention.py` (новый файл)

**Interfaces:**
- Consumes: список активов в формате, который уже строит `export_state()` (ключи `minQuantity`, `warrantyEnd`, `quantity`, `repairQuantity`, `status`, `repairDate`, `allocations` — см. `server.py:473-500`); `settings: dict` с ключами `attentionWarrantyDays: int`, `attentionRepairDays: int`.
- Produces: `compute_attention_items(assets: list[dict], settings: dict, *, today: date | None = None) -> list[dict]`, каждый элемент `{"type": "warranty"|"low_stock"|"long_repair", "assetId": str, "assetName": str, "detail": str}`. Потребляется Task A3 (десктоп) и A4 (мобильный) через поле `attentionItems` в `/api/state`.

- [ ] **Step 1: Написать падающий тест на пороговые даты гарантии**

```python
# tests/test_server_attention.py
from datetime import date

import server


def _asset(**overrides):
    base = {
        "id": "a1", "name": "Ноутбук", "quantity": 5, "repairQuantity": 0,
        "minQuantity": 0, "warrantyEnd": "", "status": "in_stock", "repairDate": "",
        "allocations": [],
    }
    base.update(overrides)
    return base


DEFAULT_SETTINGS = {"attentionWarrantyDays": 30, "attentionRepairDays": 14}


def test_warranty_ending_within_threshold_is_flagged():
    today = date(2026, 9, 4)
    asset = _asset(warrantyEnd="2026-09-20")  # 16 дней вперёд, порог 30
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=today)
    assert any(i["type"] == "warranty" and i["assetId"] == "a1" for i in items)


def test_warranty_already_expired_is_flagged():
    today = date(2026, 9, 4)
    asset = _asset(warrantyEnd="2026-08-01")
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=today)
    assert any(i["type"] == "warranty" and i["assetId"] == "a1" for i in items)


def test_warranty_far_in_the_future_is_not_flagged():
    today = date(2026, 9, 4)
    asset = _asset(warrantyEnd="2027-01-01")
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=today)
    assert not any(i["type"] == "warranty" for i in items)


def test_warranty_exactly_at_threshold_boundary_is_flagged():
    today = date(2026, 9, 4)
    asset = _asset(warrantyEnd="2026-10-04")  # ровно +30 дней
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=today)
    assert any(i["type"] == "warranty" for i in items)


def test_empty_warranty_end_is_never_flagged():
    today = date(2026, 9, 4)
    asset = _asset(warrantyEnd="")
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=today)
    assert not any(i["type"] == "warranty" for i in items)
```

- [ ] **Step 2: Запустить тест, убедиться что падает**

Run: `pytest tests/test_server_attention.py -v`
Expected: FAIL — `AttributeError: module 'server' has no attribute 'compute_attention_items'`

- [ ] **Step 3: Реализовать `compute_attention_items` (только warranty-часть)**

```python
# server.py, рядом с export_state()
from datetime import date  # добавить в существующий импорт "from datetime import datetime, timezone"
                            # -> "from datetime import date, datetime, timezone"


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
```

- [ ] **Step 4: Прогнать тест, убедиться что проходит**

Run: `pytest tests/test_server_attention.py -v`
Expected: PASS (5 тестов)

- [ ] **Step 5: Коммит**

```bash
git add server.py tests/test_server_attention.py
git commit -m "Task A1 step 1: compute_attention_items — warranty signal"
```

- [ ] **Step 6: Написать падающие тесты на low_stock**

```python
def test_low_stock_when_available_below_minimum():
    asset = _asset(quantity=5, repairQuantity=0, minQuantity=3,
                    allocations=[{"employeeId": "e1", "department": "", "site": "", "quantity": 3}])
    # available = 5 - 3(allocated) - 0(repair) = 2 < minQuantity(3)
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=date(2026, 9, 4))
    assert any(i["type"] == "low_stock" and i["assetId"] == "a1" for i in items)


def test_low_stock_not_flagged_when_available_equals_minimum():
    asset = _asset(quantity=5, repairQuantity=0, minQuantity=2,
                    allocations=[{"employeeId": "e1", "department": "", "site": "", "quantity": 3}])
    # available = 5 - 3 - 0 = 2 == minQuantity(2) -> не сигнал
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=date(2026, 9, 4))
    assert not any(i["type"] == "low_stock" for i in items)


def test_low_stock_accounts_for_repair_quantity():
    asset = _asset(quantity=5, repairQuantity=2, minQuantity=3, allocations=[])
    # available = 5 - 0 - 2 = 3 == minQuantity(3) -> не сигнал
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=date(2026, 9, 4))
    assert not any(i["type"] == "low_stock" for i in items)
```

- [ ] **Step 7: Запустить, убедиться что падает**

Run: `pytest tests/test_server_attention.py -v`
Expected: FAIL (низкий остаток не флагается — функция ещё не считает `low_stock`)

- [ ] **Step 8: Добавить low_stock-логику**

```python
# В compute_attention_items, после блока warranty (тот же цикл for asset in assets):
        allocated = sum(int(a.get("quantity") or 0) for a in (asset.get("allocations") or []))
        available = int(asset.get("quantity") or 0) - allocated - int(asset.get("repairQuantity") or 0)
        min_quantity = int(asset.get("minQuantity") or 0)
        if min_quantity > 0 and available < min_quantity:
            items.append({
                "type": "low_stock", "assetId": asset["id"],
                "assetName": asset.get("name") or "",
                "detail": f"Свободно {max(available, 0)} шт., минимум {min_quantity} шт.",
            })
```

- [ ] **Step 9: Прогнать тесты, убедиться что проходят**

Run: `pytest tests/test_server_attention.py -v`
Expected: PASS (8 тестов)

- [ ] **Step 10: Коммит**

```bash
git add server.py tests/test_server_attention.py
git commit -m "Task A1 step 2: compute_attention_items — low_stock signal"
```

- [ ] **Step 11: Написать падающие тесты на long_repair**

```python
def test_long_repair_flagged_past_threshold():
    asset = _asset(status="repair", repairQuantity=1, repairDate="2026-08-10")
    # 2026-09-04 - 2026-08-10 = 25 дней > 14
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=date(2026, 9, 4))
    assert any(i["type"] == "long_repair" and i["assetId"] == "a1" for i in items)


def test_long_repair_not_flagged_before_threshold():
    asset = _asset(status="repair", repairQuantity=1, repairDate="2026-09-01")
    # 3 дня < 14
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=date(2026, 9, 4))
    assert not any(i["type"] == "long_repair" for i in items)


def test_long_repair_ignores_assets_with_no_repair_quantity():
    asset = _asset(status="in_stock", repairQuantity=0, repairDate="2026-01-01")
    items = server.compute_attention_items([asset], DEFAULT_SETTINGS, today=date(2026, 9, 4))
    assert not any(i["type"] == "long_repair" for i in items)
```

- [ ] **Step 12: Запустить, убедиться что падает, затем реализовать**

```python
# В compute_attention_items, тот же цикл, после low_stock:
        repair_date = (asset.get("repairDate") or "").strip()
        if int(asset.get("repairQuantity") or 0) > 0 and repair_date:
            try:
                started = date.fromisoformat(repair_date)
            except ValueError:
                started = None
            if started is not None and (today - started).days > repair_days:
                items.append({
                    "type": "long_repair", "assetId": asset["id"],
                    "assetName": asset.get("name") or "",
                    "detail": f"В ремонте {(today - started).days} дн.",
                })
```

Run: `pytest tests/test_server_attention.py -v`
Expected: PASS (11 тестов)

- [ ] **Step 13: Встроить в `export_state()`**

```python
# server.py, export_state(), сразу после "active_inventory_session = _load_active_inventory_session(connection)"
# (до закрытия блока "with get_connection() as connection:"):
        attention_items = compute_attention_items(assets, {
            "attentionWarrantyDays": 30,
            "attentionRepairDays": 14,
        })

# и в возвращаемом dict (после "activeInventorySession": active_inventory_session):
        "attentionItems": attention_items,
```

Пороги здесь пока буквально захардкожены (30/14) — Task A2 заменит эти два литерала на вызовы `_attention_warranty_days()`/`_attention_repair_days()`, которые читают их из `config.json`. Так Task A1 остаётся самодостаточным и тестируемым независимо от Task A2.

- [ ] **Step 14: Тест на встраивание в `/api/state`**

```python
# tests/test_server_attention.py, в конце файла
import sqlite3


def test_export_state_includes_attention_items(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "DB_PATH", tmp_path / "test.db")
    server.init_db()
    with sqlite3.connect(server.DB_PATH) as conn:
        conn.execute(
            "INSERT INTO assets (id, name, quantity, warranty_end) VALUES (?, ?, ?, ?)",
            ("a1", "Монитор", 1, "2026-08-01"),
        )
        conn.commit()
    state = server.export_state()
    assert any(i["assetId"] == "a1" and i["type"] == "warranty" for i in state["attentionItems"])
```

Run: `pytest tests/test_server_attention.py -v`
Expected: PASS

- [ ] **Step 15: Коммит**

```bash
git add server.py tests/test_server_attention.py
git commit -m "Task A1 step 3: compute_attention_items — long_repair signal + wire into export_state"
```

---

### Task A2: пороги в `/api/settings` + десктоп-настройки

**Files:**
- Modify: `server.py:1286` (`handle_get_settings`), `server.py:1459` (`handle_save_settings`)
- Modify: `index.html:1201` (модалка настроек — рядом с `checkUpdatesInput`)
- Modify: `app.js:3569`, `app.js:3994` (обработчик сохранения, загрузка при открытии модалки)
- Test: `tests/test_server_auth.py` (рядом с существующими `test_settings_*`)

**Interfaces:**
- Consumes: `save_config`/`load_config` (`server.py`, уже существуют).
- Produces: `GET /api/settings` возвращает `{"checkUpdates": bool, "attentionWarrantyDays": int, "attentionRepairDays": int}`; `POST /api/settings` принимает любое подмножество этих трёх ключей. Потребляется Task A1's `export_state()` (через `_attention_warranty_days()`/`_attention_repair_days()`, определяемые здесь) и Task A3 (десктоп панель читает пороги только косвенно — через `attentionItems`, не напрямую).

- [ ] **Step 1: Написать падающий тест на дефолты и round-trip**

```python
# tests/test_server_auth.py, рядом с test_settings_default_to_update_checks_enabled
def test_settings_default_attention_thresholds(live_server):
    token = _create_admin(live_server)
    status, body = _request(live_server, "GET", "/api/settings", token=token)
    assert status == 200
    assert body["attentionWarrantyDays"] == 30
    assert body["attentionRepairDays"] == 14


def test_settings_attention_thresholds_round_trip(live_server):
    token = _create_admin(live_server)
    status, _ = _request(live_server, "POST", "/api/settings", token=token,
                          json_body={"attentionWarrantyDays": 45, "attentionRepairDays": 7})
    assert status == 200
    status, body = _request(live_server, "GET", "/api/settings", token=token)
    assert body["attentionWarrantyDays"] == 45
    assert body["attentionRepairDays"] == 7


def test_settings_rejects_non_positive_attention_threshold(live_server):
    token = _create_admin(live_server)
    status, _ = _request(live_server, "POST", "/api/settings", token=token,
                          json_body={"attentionWarrantyDays": 0})
    assert status == 400
    status, _ = _request(live_server, "POST", "/api/settings", token=token,
                          json_body={"attentionRepairDays": -5})
    assert status == 400
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `pytest tests/test_server_auth.py -k attention -v`
Expected: FAIL (KeyError на `attentionWarrantyDays` — поле ещё не возвращается)

- [ ] **Step 3: Реализовать**

```python
# server.py — рядом с check_updates_enabled() (~строка 93)
def _attention_warranty_days() -> int:
    return int(load_config().get("attentionWarrantyDays") or 30)


def _attention_repair_days() -> int:
    return int(load_config().get("attentionRepairDays") or 14)
```

```python
# server.py — handle_get_settings (заменить тело)
    def handle_get_settings(self) -> None:
        self.send_json({
            "checkUpdates": check_updates_enabled(),
            "attentionWarrantyDays": _attention_warranty_days(),
            "attentionRepairDays": _attention_repair_days(),
        })
```

```python
# server.py — handle_save_settings, после существующей проверки checkUpdates и ДО save_config(...):
        updates_to_apply: dict = {}
        if "checkUpdates" in payload:
            value = payload.get("checkUpdates")
            if not isinstance(value, bool):
                self.send_json_error(HTTPStatus.BAD_REQUEST, "Поле checkUpdates должно быть true или false.")
                return
            updates_to_apply["checkUpdates"] = value
        for key in ("attentionWarrantyDays", "attentionRepairDays"):
            if key in payload:
                value = payload.get(key)
                if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                    self.send_json_error(HTTPStatus.BAD_REQUEST, f"Поле {key} должно быть положительным числом.")
                    return
                updates_to_apply[key] = value
        save_config(updates_to_apply)
        self.send_json({"ok": True})
```

Удалить старые строки `value = payload.get("checkUpdates")` / проверку / `save_config({"checkUpdates": value})`, которые заменяются блоком выше (сохранить JSON-парсинг тела в начале функции как есть).

- [ ] **Step 4: Заменить хардкод из Task A1 Step 13 на вызовы `_attention_warranty_days()`/`_attention_repair_days()`**

```python
# server.py, export_state():
        attention_items = compute_attention_items(assets, {
            "attentionWarrantyDays": _attention_warranty_days(),
            "attentionRepairDays": _attention_repair_days(),
        })
```

- [ ] **Step 5: Прогнать тесты**

Run: `pytest tests/test_server_auth.py tests/test_server_attention.py -v`
Expected: PASS

- [ ] **Step 6: Десктоп — поля в модалке настроек**

```html
<!-- index.html, внутри #settingsOverlay, сразу после блока с checkUpdatesInput -->
<label class="form-field">
  <span class="form-label">Порог гарантии (дней)</span>
  <input type="number" id="attentionWarrantyDaysInput" min="1" step="1">
</label>
<label class="form-field">
  <span class="form-label">Порог ремонта (дней)</span>
  <input type="number" id="attentionRepairDaysInput" min="1" step="1">
</label>
```

```javascript
// app.js, рядом со строкой ~3994 (загрузка настроек при открытии модалки)
  document.getElementById("attentionWarrantyDaysInput").value = data.attentionWarrantyDays ?? 30;
  document.getElementById("attentionRepairDaysInput").value = data.attentionRepairDays ?? 14;
```

```javascript
// app.js, рядом со строкой ~3569 (обработчик checkUpdatesInput) — добавить два новых обработчика
  document.getElementById("attentionWarrantyDaysInput")?.addEventListener("change", async (e) => {
    const value = parseInt(e.target.value, 10);
    if (!Number.isFinite(value) || value <= 0) return;
    await apiFetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attentionWarrantyDays: value }),
    });
  });
  document.getElementById("attentionRepairDaysInput")?.addEventListener("change", async (e) => {
    const value = parseInt(e.target.value, 10);
    if (!Number.isFinite(value) || value <= 0) return;
    await apiFetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attentionRepairDays: value }),
    });
  });
```

- [ ] **Step 7: Ручная проверка**

Запустить десктоп (`python server.py`), открыть настройки, убедиться что поля показывают 30/14 по умолчанию, изменить значение, перезагрузить страницу — значение должно сохраниться.

- [ ] **Step 8: Коммит**

```bash
git add server.py index.html app.js tests/test_server_auth.py
git commit -m "Task A2: attention thresholds in /api/settings + desktop settings UI"
```

---

### Task A3: десктоп — блок "Требует внимания"

**Files:**
- Modify: `index.html` (новый блок на главном экране/дашборде)
- Modify: `app.js` (рендер `state.attentionItems`, обработчик клика)
- Modify: `styles.css` (стили блока)

**Interfaces:**
- Consumes: `state.attentionItems` (из `/api/state`, уже приходит после Task A1/A2), существующая функция перехода к карточке актива (найти по аналогии с `openAssetDetailsModal` / переходом из поиска — реализатор должен найти точное имя функции по grep `function openAsset` в `app.js`).

- [ ] **Step 1: Найти существующую точку перехода к карточке актива**

Run: `grep -n "function openAsset\|function showAssetDetails\|function selectAsset" app.js`

Использовать найденную функцию для клика по пункту панели (не изобретать новый механизм навигации).

- [ ] **Step 2: HTML-блок**

```html
<!-- index.html, на главном экране/дашборде, где отображается сводная статистика -->
<section id="attentionPanel" class="attention-panel hidden">
  <h3>Требует внимания</h3>
  <ul id="attentionPanelList"></ul>
</section>
```

- [ ] **Step 3: Рендер-функция**

```javascript
// app.js
function renderAttentionPanel() {
  const panel = document.getElementById("attentionPanel");
  const list = document.getElementById("attentionPanelList");
  const items = state.attentionItems || [];
  panel.classList.toggle("hidden", items.length === 0);
  if (items.length === 0) return;
  const labels = { warranty: "Гарантия", low_stock: "Мало на складе", long_repair: "Долгий ремонт" };
  list.innerHTML = items.map((item) => `
    <li class="attention-item attention-${item.type}" data-asset-id="${item.assetId}">
      <span class="attention-label">${labels[item.type] || item.type}</span>
      <span class="attention-name">${escapeHtml(item.assetName)}</span>
      <span class="attention-detail">${escapeHtml(item.detail)}</span>
    </li>
  `).join("");
  list.querySelectorAll(".attention-item").forEach((el) => {
    el.addEventListener("click", () => openAssetDetailsById(el.dataset.assetId)); // ЗАМЕНИТЬ на точное имя функции из Step 1
  });
}
```

Вызвать `renderAttentionPanel()` из существующей функции, которая перерисовывает дашборд после каждого обновления `state` (найти по grep `function renderDashboard\|function render()` — вызывается там же, где рендерятся остальные сводные блоки).

- [ ] **Step 4: Минимальные стили**

```css
/* styles.css */
.attention-panel { margin-bottom: 16px; }
.attention-item { display: flex; gap: 8px; padding: 6px 10px; cursor: pointer; border-radius: 6px; }
.attention-item:hover { background: var(--surface-hover, #f0f0f0); }
.attention-warranty { border-left: 3px solid #e0a800; }
.attention-low_stock { border-left: 3px solid #d9534f; }
.attention-long_repair { border-left: 3px solid #5bc0de; }
```

- [ ] **Step 5: Ручная проверка**

Запустить сервер, создать актив с `warrantyEnd` в прошлом (через десктоп-форму — поле `Гарантия до` уже есть), обновить `/api/state`, убедиться, что блок появляется и клик открывает карточку актива.

- [ ] **Step 6: Коммит**

```bash
git add index.html app.js styles.css
git commit -m "Task A3: desktop attention panel"
```

---

### Task A4: мобильный — бейдж и список "Требует внимания"

**Files:**
- Modify: `mobile/www/index.html` (пункт навигации + бейдж, экран списка)
- Modify: `mobile/www/js/screens.js` (рендер, обработчик)
- Test: `mobile/tests/screens.test.js`

**Interfaces:**
- Consumes: `Db.getStateMeta()`/локальный кэш `attentionItems` (нужно прокинуть через `replaceState` — см. Step 1), `NAV_SCREEN_MAP` (`screens.js:51`), `showScreen()` (`screens.js:59`).
- Produces: `renderAttentionBadge(items)` — чистая функция (count → badge text/visibility), экспортируется в `module.exports` для теста.

- [ ] **Step 1: Прокинуть `attentionItems` в мобильный кэш через `meta`**

Тот же приём, что `activeInventorySession` (Этап 4): пишем JSON-строку в таблицу `meta` внутри `replaceState()`.

```javascript
// mobile/www/js/db.js, в массиве txn внутри replaceState(state), рядом с записью activeInventorySession
  txn.push({
    statement: `INSERT OR REPLACE INTO meta (key, value) VALUES ('attentionItems', ?)`,
    values: [JSON.stringify(state.attentionItems || [])],
  });
```

- [ ] **Step 2: Написать падающий тест на чистую функцию бейджа**

```javascript
// mobile/tests/screens.test.js
test('renderAttentionBadgeText returns empty string for no items', () => {
  const { renderAttentionBadgeText } = require('../www/js/screens.js');
  assert.equal(renderAttentionBadgeText([]), '');
});

test('renderAttentionBadgeText returns the count as a string', () => {
  const { renderAttentionBadgeText } = require('../www/js/screens.js');
  assert.equal(renderAttentionBadgeText([{}, {}, {}]), '3');
});
```

- [ ] **Step 3: Запустить, убедиться что падает**

Run: `cd mobile && node --test tests/screens.test.js`
Expected: FAIL

- [ ] **Step 4: Реализовать**

```javascript
// mobile/www/js/screens.js
function renderAttentionBadgeText(items) {
  return items.length === 0 ? '' : String(items.length);
}
```

Добавить `renderAttentionBadgeText` в `module.exports` (строка ~797).

- [ ] **Step 5: Прогнать тест**

Run: `cd mobile && node --test tests/screens.test.js`
Expected: PASS

- [ ] **Step 6: Экран списка + навигация**

```html
<!-- mobile/www/index.html, в <nav class="bottom-nav">, после navInventoryBtn -->
<button id="navAttentionBtn" class="nav-item" type="button" aria-label="Внимание" title="Требует внимания">
  <span>⚠</span><span id="attentionBadge" class="badge hidden"></span>
</button>
```

```html
<!-- mobile/www/index.html, новый <section class="screen hidden" id="screen-attention"> рядом с другими screen-* -->
<section class="screen hidden" id="screen-attention">
  <h2>Требует внимания</h2>
  <ul id="attentionList"></ul>
</section>
```

```javascript
// mobile/www/js/screens.js
// 1) добавить в NAV_SCREEN_MAP: navAttentionBtn: 'screen-attention',
// 2) обработчик клика (рядом с navInventoryBtn addEventListener, ~строка 676):
document.getElementById('navAttentionBtn')?.addEventListener('click', openAttentionScreen);

async function openAttentionScreen() {
  const meta = await Db.getStateMeta();
  const items = meta.attentionItems ? JSON.parse(meta.attentionItems) : [];
  const labels = { warranty: 'Гарантия', low_stock: 'Мало на складе', long_repair: 'Долгий ремонт' };
  const list = document.getElementById('attentionList');
  list.innerHTML = items.length
    ? items.map((i) => `<li>${labels[i.type] || i.type}: ${i.assetName} — ${i.detail}</li>`).join('')
    : '<li>Нет сигналов</li>';
  showScreen('screen-attention');
}

async function refreshAttentionBadge() {
  const meta = await Db.getStateMeta();
  const items = meta.attentionItems ? JSON.parse(meta.attentionItems) : [];
  const badge = document.getElementById('attentionBadge');
  const text = renderAttentionBadgeText(items);
  badge.textContent = text;
  badge.classList.toggle('hidden', text === '');
}
```

Вызвать `refreshAttentionBadge()` там же, где сейчас вызывается `refreshQueueCount()` после синхронизации (найти по grep `refreshQueueCount()` в `screens.js` — вызвать сразу рядом).

- [ ] **Step 7: Ручная проверка**

Собрать debug APK или запустить в эмуляторе, синхронизировать с сервером, у которого есть просроченная гарантия — бейдж должен показать число, список — детали.

- [ ] **Step 8: Коммит**

```bash
git add mobile/www/index.html mobile/www/js/screens.js mobile/www/js/db.js mobile/tests/screens.test.js
git commit -m "Task A4: mobile attention badge and list screen"
```

---

## Задача B — экран сотрудника + обходной лист

### Task B1: десктоп — исключить уволенных из выпадающего списка выдачи

**Files:**
- Modify: `app.js:2117-2119` (построение `employeeOptions`), функция вокруг строки 2141 (`updateIssueAssetOptions` / где заполняется `dom.issueEmployeeSelect`)
- Test: нет автотестового харнесса для `app.js` (см. прецедент этапов 2-4) — только ручная проверка (Step 3).

**Interfaces:**
- Consumes: `state.employees` (поле `status`, уже приходит из `/api/state`, значения `'active'`/`'inactive'`).
- Produces: `getActiveEmployees(employees)` — чистая функция, `state.employees.filter(e => (e.status || 'active') !== 'inactive')`.

**Важно:** фильтровать ТОЛЬКО `issueEmployeeSelect` (выдача). `returnEmployeeSelect` и `manualActEmployeeSelect` НЕ трогать — возврат техники от уволенного сотрудника (обходной лист) требует, чтобы он оставался доступен для выбора при возврате.

- [ ] **Step 1: Найти все три использования `employeeOptions`**

Run: `grep -n "employeeOptions" app.js`

Подтвердить, что список из трёх присваиваний (`dom.issueEmployeeSelect.innerHTML`, `dom.returnEmployeeSelect.innerHTML`, `dom.manualActEmployeeSelect.innerHTML`, ~строки 2141-2143) не менялся с момента исследования плана — если менялся, скорректировать номера строк по месту.

- [ ] **Step 2: Добавить отдельный отфильтрованный список только для выдачи**

```javascript
// app.js, рядом с getAvailableQuantity (~строка 429)
function getActiveEmployees(employees) {
  return employees.filter((e) => (e.status || "active") !== "inactive");
}
```

```javascript
// app.js, там где строится employeeOptions (~строка 2117-2119) — добавить второй, отфильтрованный вариант:
  const employeeOptions = state.employees
    .map((e) => `<option value="${e.id}">${escapeHtml(e.fullName)}</option>`)
    .join("");
  const activeEmployeeOptions = getActiveEmployees(state.employees)
    .map((e) => `<option value="${e.id}">${escapeHtml(e.fullName)}</option>`)
    .join("");
```

```javascript
// app.js, ~строка 2141 — заменить ТОЛЬКО строку для issueEmployeeSelect:
  dom.issueEmployeeSelect.innerHTML = activeEmployeeOptions;
  dom.returnEmployeeSelect.innerHTML = employeeOptions;
  dom.manualActEmployeeSelect.innerHTML = employeeOptions;
```

- [ ] **Step 3: Ручная проверка**

Уволить сотрудника (переключить `employeeStatusSelect` на "Уволен" в карточке — поле уже существует), открыть модалку "Выдать технику" — уволенный не должен быть в списке. Открыть модалку "Вернуть" — уволенный должен остаться в списке (нужен для обходного листа).

- [ ] **Step 4: Коммит**

```bash
git add app.js
git commit -m "Task B1: exclude inactive employees from the issue dropdown only"
```

---

### Task B2: мобильный — статус сотрудника в кэше + экран "Сотрудники" (поиск, список, allocations)

**Files:**
- Modify: `mobile/www/js/db.js` (SCHEMA: `employees.status`; `replaceState`; новые функции `searchEmployees`, `getAllocationsForEmployee`)
- Modify: `mobile/www/index.html` (пункт навигации, экраны поиска/деталей)
- Modify: `mobile/www/js/screens.js` (логика экранов)
- Test: `mobile/tests/db.test.js` (если существует обвязка для `db.js` — см. прецедент Этапа 4 Task A7: скорее всего её нет, тогда чистые функции тестируются, CRUD — только вручную), `mobile/tests/screens.test.js`

**Interfaces:**
- Consumes: `NAV_SCREEN_MAP`, `showScreen()`, `Settings.get()` (уже содержит `role` с Этапа 4).
- Produces: `Db.searchEmployees(query, limit=30) -> Promise<Array<{id, fullName, department, position, site, status}>>`, `Db.getAllocationsForEmployee(employeeId) -> Promise<Array<{assetId, name, inventoryNumber, category, quantity}>>`. Потребляется Task B3.

- [ ] **Step 1: Добавить `status` в мобильную схему `employees`**

```javascript
// mobile/www/js/db.js, SCHEMA — заменить определение employees:
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY, full_name TEXT NOT NULL, department TEXT, site TEXT, status TEXT
);
```

```javascript
// mobile/www/js/db.js, open(), рядом с существующим guarded ALTER для assets.rev:
  try {
    await db.execute("ALTER TABLE employees ADD COLUMN status TEXT");
  } catch (err) {
    // Уже есть колонка — см. комментарий у ALTER TABLE assets ADD COLUMN rev выше.
  }
```

- [ ] **Step 2: Записывать `status` в `replaceState`**

```javascript
// mobile/www/js/db.js, replaceState(), блок "for (const e of state.employees)" (~строка 95-100):
  for (const e of state.employees) {
    txn.push({
      statement: 'INSERT INTO employees (id, full_name, department, site, status) VALUES (?,?,?,?,?)',
      values: [e.id, e.fullName, e.department, e.site, e.status || 'active'],
    });
  }
```

- [ ] **Step 3: `searchEmployees` и `getAllocationsForEmployee`**

```javascript
// mobile/www/js/db.js, рядом с searchAssets (~строка 244)
async function searchEmployees(query, limit = 30) {
  const q = `%${String(query || '').trim()}%`;
  const result = await db.query(
    'SELECT * FROM employees WHERE full_name LIKE ? ORDER BY full_name LIMIT ?',
    [q, limit]
  );
  return result.values.map((row) => ({
    id: row.id, fullName: row.full_name, department: row.department,
    site: row.site, status: row.status || 'active',
  }));
}

async function getAllocationsForEmployee(employeeId) {
  const result = await db.query(
    `SELECT allocations.asset_id AS assetId, allocations.quantity AS quantity,
            assets.name AS name, assets.inventory_number AS inventoryNumber, assets.category AS category
     FROM allocations JOIN assets ON assets.id = allocations.asset_id
     WHERE allocations.employee_id = ? AND allocations.quantity > 0
     ORDER BY assets.name`,
    [employeeId]
  );
  return result.values;
}
```

Добавить `searchEmployees, getAllocationsForEmployee` в `window.Db = { ... }` (строка ~387).

- [ ] **Step 4: Навигация — пункт "Сотрудники" (только admin)**

```html
<!-- mobile/www/index.html, в <nav class="bottom-nav">, после navInventoryBtn -->
<button id="navEmployeesBtn" class="nav-item hidden" type="button" aria-label="Сотрудники" title="Сотрудники">
  <span>Сотрудники</span>
</button>
```

```html
<!-- mobile/www/index.html, новые экраны -->
<section class="screen hidden" id="screen-employees-search">
  <h2>Сотрудники</h2>
  <input type="text" id="employeeSearchInput" placeholder="Поиск по имени">
  <ul id="employeeSearchResults"></ul>
</section>
<section class="screen hidden" id="screen-employee-detail">
  <button id="employeeDetailBackBtn" type="button">Назад</button>
  <h2 id="employeeDetailName"></h2>
  <p id="employeeDetailStatus"></p>
  <ul id="employeeAllocationsList"></ul>
</section>
```

```javascript
// mobile/www/js/screens.js
// 1) NAV_SCREEN_MAP: добавить navEmployeesBtn: 'screen-employees-search',
// 2) видимость по роли — там же, где navInventoryBtn (~строка 612):
document.getElementById('navEmployeesBtn')?.classList.toggle('hidden', role !== 'admin');
// 3) обработчик клика (рядом со строкой 676):
document.getElementById('navEmployeesBtn')?.addEventListener('click', openEmployeeSearchScreen);
document.getElementById('employeeSearchInput')?.addEventListener('input', (e) => runEmployeeSearch(e.target.value));
document.getElementById('employeeDetailBackBtn')?.addEventListener('click', openEmployeeSearchScreen);

let currentEmployeeId = null;

async function openEmployeeSearchScreen() {
  await runEmployeeSearch('');
  showScreen('screen-employees-search');
}

async function runEmployeeSearch(query) {
  const employees = await Db.searchEmployees(query);
  const list = document.getElementById('employeeSearchResults');
  list.innerHTML = employees.map((e) => `
    <li data-employee-id="${e.id}">${escapeHtmlForScreens(e.fullName)}${e.status === 'inactive' ? ' (уволен)' : ''}</li>
  `).join('');
  list.querySelectorAll('li').forEach((el) => {
    el.addEventListener('click', () => openEmployeeDetailScreen(el.dataset.employeeId));
  });
}

async function openEmployeeDetailScreen(employeeId) {
  currentEmployeeId = employeeId;
  const employees = await Db.searchEmployees('');
  const employee = employees.find((e) => e.id === employeeId);
  document.getElementById('employeeDetailName').textContent = employee ? employee.fullName : '';
  document.getElementById('employeeDetailStatus').textContent = employee && employee.status === 'inactive' ? 'Уволен(а)' : 'Активен';
  const allocations = await Db.getAllocationsForEmployee(employeeId);
  const list = document.getElementById('employeeAllocationsList');
  list.innerHTML = allocations.length
    ? allocations.map((a) => `<li data-asset-id="${a.assetId}" data-quantity="${a.quantity}">${escapeHtmlForScreens(a.name)} — ${a.quantity} шт.</li>`).join('')
    : '<li>Ничего не числится</li>';
  showScreen('screen-employee-detail');
}
```

`escapeHtmlForScreens` — проверить, есть ли уже HTML-экранирующая функция в `screens.js`/`format.js` (grep `function escapeHtml`); если есть под другим именем — использовать её, не заводить дубликат.

- [ ] **Step 5: Ручная проверка**

Собрать debug APK или запустить в эмуляторе под admin-пользователем, убедиться что пункт "Сотрудники" виден, поиск работает, список allocations соответствует десктопу. Под storekeeper — пункт должен быть скрыт.

- [ ] **Step 6: Коммит**

```bash
git add mobile/www/js/db.js mobile/www/index.html mobile/www/js/screens.js
git commit -m "Task B2: mobile employee status cache + Employees search/detail screens"
```

---

### Task B3: мобильный — быстрый возврат + обходной лист

**Files:**
- Modify: `mobile/www/index.html` (кнопка возврата на строке allocation, режим обходного листа)
- Modify: `mobile/www/js/screens.js` (`openEmployeeDetailScreen` — расширить; новая функция `summarizeOffboarding`)
- Test: `mobile/tests/screens.test.js`

**Interfaces:**
- Consumes: `Db.enqueueAction(payload)` (уже существует, `db.js:289`), `Db.getAllocationsForEmployee` (Task B2).
- Produces: `summarizeOffboarding(allocations: Array<{quantity}>) -> {total: number, remaining: number, allDone: boolean}` — чистая функция с тестом.

- [ ] **Step 1: Написать падающий тест на `summarizeOffboarding`**

```javascript
// mobile/tests/screens.test.js
test('summarizeOffboarding reports allDone true when nothing remains', () => {
  const { summarizeOffboarding } = require('../www/js/screens.js');
  const result = summarizeOffboarding([]);
  assert.equal(result.allDone, true);
  assert.equal(result.remaining, 0);
});

test('summarizeOffboarding reports remaining items when allocations exist', () => {
  const { summarizeOffboarding } = require('../www/js/screens.js');
  const result = summarizeOffboarding([{ quantity: 2 }, { quantity: 1 }]);
  assert.equal(result.allDone, false);
  assert.equal(result.total, 3);
  assert.equal(result.remaining, 3);
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd mobile && node --test tests/screens.test.js`
Expected: FAIL

- [ ] **Step 3: Реализовать**

```javascript
// mobile/www/js/screens.js
function summarizeOffboarding(allocations) {
  const total = allocations.reduce((sum, a) => sum + Number(a.quantity || 0), 0);
  return { total, remaining: total, allDone: allocations.length === 0 };
}
```

Добавить `summarizeOffboarding` в `module.exports`.

- [ ] **Step 4: Прогнать тест**

Run: `cd mobile && node --test tests/screens.test.js`
Expected: PASS

- [ ] **Step 5: UI — кнопка возврата на каждой строке + режим обходного листа**

```html
<!-- mobile/www/index.html, screen-employee-detail — добавить сводку и изменить разметку строк allocations -->
<p id="employeeOffboardingSummary" class="hidden"></p>
```

```javascript
// mobile/www/js/screens.js — заменить рендер списка allocations внутри openEmployeeDetailScreen (Task B2, Step 4)
// на версию с кнопкой возврата и сводкой обходного листа:
async function openEmployeeDetailScreen(employeeId) {
  currentEmployeeId = employeeId;
  const employees = await Db.searchEmployees('');
  const employee = employees.find((e) => e.id === employeeId);
  const isOffboarding = employee && employee.status === 'inactive';
  document.getElementById('employeeDetailName').textContent = employee ? employee.fullName : '';
  document.getElementById('employeeDetailStatus').textContent = isOffboarding ? 'Уволен(а) — обходной лист' : 'Активен';
  const allocations = await Db.getAllocationsForEmployee(employeeId);
  const list = document.getElementById('employeeAllocationsList');
  list.innerHTML = allocations.length
    ? allocations.map((a) => `
        <li data-asset-id="${a.assetId}" data-quantity="${a.quantity}">
          ${escapeHtmlForScreens(a.name)} — ${a.quantity} шт.
          <button type="button" class="employee-return-btn">Вернуть</button>
        </li>`).join('')
    : '<li>Ничего не числится</li>';
  list.querySelectorAll('.employee-return-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      quickReturnFromEmployee(employeeId, li.dataset.assetId, Number(li.dataset.quantity));
    });
  });
  const summaryEl = document.getElementById('employeeOffboardingSummary');
  if (isOffboarding) {
    const summary = summarizeOffboarding(allocations);
    summaryEl.textContent = summary.allDone ? 'Всё сдано.' : `Осталось сдать: ${summary.remaining} шт.`;
    summaryEl.classList.remove('hidden');
  } else {
    summaryEl.classList.add('hidden');
  }
  showScreen('screen-employee-detail');
}

async function quickReturnFromEmployee(employeeId, assetId, quantity) {
  await Db.enqueueAction({
    type: 'return',
    assetId,
    employeeId,
    quantity,
    date: new Date().toISOString().slice(0, 10),
  });
  Toast.show('Возврат в очереди', 'info');
  await refreshQueueCount();
  Sync.run().then((r) => { refreshQueueCount(); ConnStatus.report(r.pulled, r.needsReauth); });
  await openEmployeeDetailScreen(employeeId); // перерисовать список/сводку после постановки в очередь
}
```

- [ ] **Step 6: Ручная проверка**

Уволить сотрудника с закреплённой техникой (десктоп), синхронизировать телефон, открыть его карточку на мобильном под admin — должен показаться режим "обходной лист" со сводкой "Осталось сдать: N шт.", кнопка "Вернуть" на каждой позиции ставит возврат в очередь; после отправки очереди и повторной синхронизации — "Всё сдано."

- [ ] **Step 7: Коммит**

```bash
git add mobile/www/index.html mobile/www/js/screens.js mobile/tests/screens.test.js
git commit -m "Task B3: quick return + offboarding checklist on the employee screen"
```

---

## Задача C — фото техники

### Task C1: сохранить `photo_url` при полном сохранении с десктопа (regression-first)

**Контекст:** `import_state()` уже наступала на эти грабли с `label_printed_at` (Этап 4 финальный ревью) — то же самое произойдёт с `photo_url`, если оставить как есть: `_asset_payload()` в тестах и реальный объект актива в `app.js` НЕ гарантированно несут актуальное значение `photoUrl` на каждый полный save (риск гонки: фото загружено с телефона между двумя десктоп-сохранениями — стейл-кэш десктопа затирает `photo_url` пустой строкой). Делаем `photo_url` server-owned по той же схеме, ДО того как заводить upload-эндпоинт (Task C2), чтобы endpoint не пришлось потом переделывать.

**Files:**
- Modify: `server.py:565-575` (`old_assets` — добавить `photo_url` в SELECT и в кортеж), `server.py:610-659` (использовать `old_photo_url` вместо `asset.get("photoUrl")`)
- Test: `tests/test_server_auth.py` (рядом с `test_import_state_succeeds_after_an_inventory_scan_exists_and_preserves_label_printed_at`)

**Interfaces:**
- Consumes: ничего нового.
- Produces: `import_state()` больше не читает `photoUrl` из клиентского payload — сохраняет то, что уже есть в БД. Потребляется Task C2 (upload-эндпоинт становится единственным писателем `photo_url`).

- [ ] **Step 1: Написать падающий regression-тест**

```python
# tests/test_server_auth.py
def test_import_state_preserves_photo_url_across_a_desktop_save(live_server):
    # photo_url устанавливается вне import_state (по аналогии с label_printed_at) —
    # обычное сохранение с десктопа не должно его стирать, даже если payload
    # (как _asset_payload()) вообще не несёт ключа photoUrl.
    token = _create_admin(live_server)
    with sqlite3.connect(server.DB_PATH) as conn:
        conn.execute(
            "INSERT INTO assets (id, name, quantity, photo_url) VALUES (?, ?, ?, ?)",
            ("ast_1", "Ноутбук", 5, "uploads/ast_1.jpg"),
        )
        conn.commit()
    status, body = _request(live_server, "POST", "/api/state", token=token,
                             json_body=_state_payload(_asset_payload()))
    assert status == 200, body
    saved = next(a for a in body["assets"] if a["id"] == "ast_1")
    assert saved["photoUrl"] == "uploads/ast_1.jpg"
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `pytest tests/test_server_auth.py -k photo_url -v`
Expected: FAIL — `saved["photoUrl"] == ""`

- [ ] **Step 3: Исправить `import_state`**

```python
# server.py, old_assets dict (~строка 565) — добавить photo_url в SELECT и кортеж:
        old_assets = {
            row["id"]: (
                row["name"], row["category"] or "", row["inventory_number"] or "",
                row["serial_number"] or "", row["location"] or "", row["purchase_date"] or "",
                row["warranty_end"] or "", row["rev"], row["label_printed_at"], row["photo_url"],
            )
            for row in connection.execute(
                "SELECT id, name, category, inventory_number, serial_number, location, "
                "purchase_date, warranty_end, rev, label_printed_at, photo_url FROM assets"
            )
        }
```

```python
# server.py, внутри "for asset in assets:", рядом с old_label_printed_at (~строка 632):
            old_photo_url = old[9] if old is not None else ""
```

```python
# server.py, VALUES-кортеж INSERT INTO assets (~строка 655) — заменить:
                    asset.get("photoUrl") or "",
# на:
                    old_photo_url,
```

- [ ] **Step 4: Прогнать тест**

Run: `pytest tests/test_server_auth.py -k photo_url -v`
Expected: PASS

- [ ] **Step 5: Прогнать весь набор — убедиться, что ничего не сломано**

Run: `pytest -q`
Expected: все тесты зелёные (существующие тесты на `photoUrl` не полагаются на его запись через `import_state` — проверить `test_import_state_*` целиком, если что-то ожидало старое поведение, скорректировать тест на новое server-owned поведение)

- [ ] **Step 6: Коммит**

```bash
git add server.py tests/test_server_auth.py
git commit -m "Task C1: make photo_url server-owned, preserved across desktop saves (like label_printed_at)"
```

---

### Task C2: сервер — `POST`/`GET /api/assets/<id>/photo`

**Files:**
- Modify: `paths.py` (добавить `UPLOADS_DIR`)
- Modify: `server.py` (импорт `UPLOADS_DIR`, роутинг в `do_GET`/`do_POST`, два новых handler-метода)
- Test: `tests/test_server_auth.py`

**Interfaces:**
- Consumes: `read_body()` (уже есть, работает с любыми байтами), `get_connection()`.
- Produces: `POST /api/assets/<id>/photo` (admin/storekeeper, тело — сырые JPEG-байты, `Content-Type: image/jpeg`) → 200, обновляет `assets.photo_url`; `GET /api/assets/<id>/photo` (любая авторизованная роль) → бинарный JPEG, 404 если фото нет. Потребляется Task C3 (десктоп `<img>`), Task C5 (мобильная загрузка).

- [ ] **Step 1: `UPLOADS_DIR` в `paths.py`**

```python
# paths.py, рядом с остальными путями (~строка 44)
UPLOADS_DIR = DATA_DIR / "uploads"
```

```python
# server.py, импорт (~строка 31) — добавить UPLOADS_DIR в существующий "from paths import (...)"
from paths import (
    BACKUP_DIR,
    CONFIG_PATH,
    DB_PATH,
    LOG_DIR,
    RESOURCE_DIR,
    SCHEMA_PATH,
    UPDATE_CACHE_PATH,
    UPLOADS_DIR,
    VERSION_PATH,
)
```

- [ ] **Step 2: Написать падающий тест на upload → GET round-trip**

```python
# tests/test_server_auth.py
def test_asset_photo_upload_then_get_returns_same_bytes(live_server):
    _seed_asset(server.DB_PATH)
    token = _create_admin(live_server)
    photo_bytes = b"\xff\xd8\xff\xe0fake-jpeg-bytes"
    req = urllib.request.Request(f"{live_server}/api/assets/ast_1/photo", data=photo_bytes, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "image/jpeg")
    with urllib.request.urlopen(req) as response:
        assert response.status == 200

    status, body = _fetch_bytes(live_server, "/api/assets/ast_1/photo", token)
    assert status == 200
    assert body == photo_bytes


def test_asset_photo_upload_replaces_previous_photo(live_server):
    _seed_asset(server.DB_PATH)
    token = _create_admin(live_server)
    for content in (b"first-photo", b"second-photo"):
        req = urllib.request.Request(f"{live_server}/api/assets/ast_1/photo", data=content, method="POST")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", "image/jpeg")
        with urllib.request.urlopen(req) as response:
            assert response.status == 200
    status, body = _fetch_bytes(live_server, "/api/assets/ast_1/photo", token)
    assert body == b"second-photo"


def test_asset_photo_get_returns_404_when_no_photo_exists(live_server):
    _seed_asset(server.DB_PATH)
    token = _create_admin(live_server)
    status, _ = _fetch_bytes(live_server, "/api/assets/ast_1/photo", token)
    assert status == 404


def test_asset_photo_upload_returns_404_for_unknown_asset(live_server):
    token = _create_admin(live_server)
    req = urllib.request.Request(f"{live_server}/api/assets/unknown/photo", data=b"x", method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        urllib.request.urlopen(req)
        assert False, "expected HTTPError"
    except urllib.error.HTTPError as exc:
        assert exc.code == 404


@pytest.mark.parametrize("role,expected_status", [("admin", 200), ("storekeeper", 200), ("viewer", 403)])
def test_asset_photo_upload_role_matrix(live_server, role, expected_status):
    _seed_asset(server.DB_PATH)
    admin_token = _create_admin(live_server)
    if role == "admin":
        token = admin_token
    else:
        _request(live_server, "POST", "/api/users", token=admin_token,
                 json_body={"username": role, "password": "pass1234", "role": role})
        _, body = _request(live_server, "POST", "/api/login", json_body={"username": role, "password": "pass1234"})
        token = body["token"]
    req = urllib.request.Request(f"{live_server}/api/assets/ast_1/photo", data=b"x", method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as response:
            status = response.status
    except urllib.error.HTTPError as exc:
        status = exc.code
    assert status == expected_status
```

- [ ] **Step 3: Запустить, убедиться что падает**

Run: `pytest tests/test_server_auth.py -k asset_photo -v`
Expected: FAIL (404 — маршрут ещё не существует)

- [ ] **Step 4: Реализовать handler-методы**

```python
# server.py, рядом с handle_mark_labels_printed (~строка 1475)
    def handle_get_asset_photo(self, asset_id: str) -> None:
        with get_connection() as connection:
            row = connection.execute("SELECT photo_url FROM assets WHERE id = ?", (asset_id,)).fetchone()
        if row is None or not row["photo_url"]:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        photo_path = UPLOADS_DIR / f"{asset_id}.jpg"
        if not photo_path.exists():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        photo_bytes = photo_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(photo_bytes)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(photo_bytes)

    def handle_upload_asset_photo(self, asset_id: str, body: bytes) -> None:
        with get_connection() as connection:
            row = connection.execute("SELECT id FROM assets WHERE id = ?", (asset_id,)).fetchone()
            if row is None:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
            (UPLOADS_DIR / f"{asset_id}.jpg").write_bytes(body)
            connection.execute("UPDATE assets SET photo_url = ? WHERE id = ?", (f"uploads/{asset_id}.jpg", asset_id))
        self.send_json({"ok": True})
```

- [ ] **Step 5: Роутинг**

```python
# server.py, do_GET — добавить перед финальным self.send_error(HTTPStatus.NOT_FOUND) (~строка 819)
        if parsed.path.startswith("/api/assets/") and parsed.path.endswith("/photo"):
            asset_id = parsed.path[len("/api/assets/"):-len("/photo")]
            self.handle_get_asset_photo(asset_id)
            return
```

```python
# server.py, do_POST — добавить рядом с "/api/assets/label-printed" (~строка 875)
        if parsed.path.startswith("/api/assets/") and parsed.path.endswith("/photo"):
            if not self.require_role(user, ("admin", "storekeeper")):
                return
            asset_id = parsed.path[len("/api/assets/"):-len("/photo")]
            self.handle_upload_asset_photo(asset_id, body)
            return
```

Разместить POST-ветку ДО общей проверки `if parsed.path != "/api/state": self.send_error(...)`.

- [ ] **Step 6: Прогнать тесты**

Run: `pytest tests/test_server_auth.py -k asset_photo -v`
Expected: PASS (6 тестов)

- [ ] **Step 7: Прогнать весь набор**

Run: `pytest -q`
Expected: все тесты зелёные

- [ ] **Step 8: Коммит**

```bash
git add paths.py server.py tests/test_server_auth.py
git commit -m "Task C2: POST/GET /api/assets/<id>/photo — raw-bytes upload, replace-on-reupload"
```

---

### Task C3: десктоп — превью фото вместо ручного поля URL

**Files:**
- Modify: `index.html:206-209` (заменить `<input name="photoUrl">` на превью)
- Modify: `app.js:2383, 2575, 2707, 2729` (убрать обращения к `form.elements.photoUrl`; добавить рендер превью + кнопку загрузки)

**Interfaces:**
- Consumes: `GET /api/assets/<id>/photo` (Task C2), `asset.photoUrl`/`asset.rev` (уже приходят в `state.assets`).

**Обоснование отклонения от спеки:** существующее поле "Фото (URL)" — ручной текстовый ввод произвольного URL, никогда не отображавшийся нигде как `<img>`. После Task C1 `photo_url` становится server-owned (клиентский payload игнорируется), так что ручной ввод молча перестал бы на что-либо влиять — оставлять вводящее в заблуждение мёртвое поле нельзя. Заменяем на read-only превью с кнопкой "Загрузить фото" (файловый инпут → тот же upload-эндпоинт, что и мобильный).

- [ ] **Step 1: HTML — превью вместо текстового поля**

```html
<!-- index.html, заменить блок на строках 206-209 -->
<label class="form-field">
  <span class="form-label">Фото</span>
  <div id="assetPhotoPreview" class="asset-photo-preview">
    <img id="assetPhotoImg" class="hidden" alt="Фото актива">
    <span id="assetPhotoPlaceholder">Нет фото</span>
  </div>
  <input type="file" id="assetPhotoFileInput" accept="image/*" class="hidden">
  <button type="button" id="assetPhotoUploadBtn" class="btn-secondary">Загрузить фото</button>
</label>
```

- [ ] **Step 2: Убрать старые обращения к `form.elements.photoUrl`**

```javascript
// app.js:2383 — удалить строку "if (form.elements.photoUrl) form.elements.photoUrl.value = "";"
// app.js:2707 — удалить строку "asset.photoUrl = String(formData.get("photoUrl") || "").trim();"
// app.js:2729 — удалить строку "photoUrl: String(formData.get("photoUrl") || "").trim(),"
```

- [ ] **Step 3: Рендер превью + загрузка**

```javascript
// app.js, заменить строку 2575 ("if (dom.assetForm.elements.photoUrl) ...") на:
  renderAssetPhotoPreview(asset);
```

```javascript
// app.js, новая функция рядом с getAvailableQuantity
function renderAssetPhotoPreview(asset) {
  const img = document.getElementById("assetPhotoImg");
  const placeholder = document.getElementById("assetPhotoPlaceholder");
  if (asset.photoUrl) {
    img.src = `${apiBase()}/api/assets/${asset.id}/photo?v=${asset.rev}`; // apiBase() — проверить точное имя существующего хелпера базового URL (grep "function apiBase\|function apiFetch")
    img.classList.remove("hidden");
    placeholder.classList.add("hidden");
  } else {
    img.classList.add("hidden");
    placeholder.classList.remove("hidden");
  }
  document.getElementById("assetPhotoUploadBtn").onclick = () => document.getElementById("assetPhotoFileInput").click();
  document.getElementById("assetPhotoFileInput").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const bytes = await file.arrayBuffer();
    const response = await apiFetch(`/api/assets/${asset.id}/photo`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: bytes,
    });
    if (response.ok) {
      showToast("Фото загружено.", "info");
      asset.photoUrl = `uploads/${asset.id}.jpg`;
      asset.rev = (asset.rev || 0) + 1; // локальный кэш-бастинг; реальный rev подтянется на следующем /api/state
      renderAssetPhotoPreview(asset);
    } else {
      showToast("Не удалось загрузить фото.", "error");
    }
  };
}
```

Найти точное имя хелпера, возвращающего базовый URL API (grep `function apiBase\|const API_BASE\|location.origin` в `app.js`) — вероятно, десктоп ходит на тот же origin, и `apiBase()` не нужен вовсе (`fetch("/api/...")` уже относительный). Если так — убрать `apiBase()` из `img.src` и использовать относительный путь напрямую.

- [ ] **Step 4: Минимальные стили**

```css
/* styles.css */
.asset-photo-preview { width: 120px; height: 120px; border: 1px dashed #ccc; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.asset-photo-preview img { max-width: 100%; max-height: 100%; object-fit: cover; }
```

- [ ] **Step 5: Ручная проверка**

Загрузить фото через новую кнопку, убедиться что превью обновляется сразу, перезагрузить страницу — фото должно остаться (не зависеть от локального состояния формы).

- [ ] **Step 6: Коммит**

```bash
git add index.html app.js styles.css
git commit -m "Task C3: desktop photo preview + upload button, replacing the dead manual URL field"
```

---

### Task C4: мобильный — таблица `pending_photo_uploads` + CRUD

**Files:**
- Modify: `mobile/www/js/db.js` (SCHEMA, CRUD-функции, экспорт)
- Test: если для `db.js` есть тестовая обвязка — покрыть; если нет (см. прецедент Этапа 4 Task A7) — только ручная проверка на устройстве (Step 4 в Task C5/C6).

**Interfaces:**
- Produces: `Db.queuePhotoUpload(assetId, localPath) -> Promise<void>` (INSERT OR REPLACE по `asset_id` — новое фото того же актива заменяет ещё не докачанное старое), `Db.listPendingPhotoUploads() -> Promise<Array<{assetId, localPath, createdAt}>>`, `Db.clearPendingPhotoUpload(assetId) -> Promise<void>`. Потребляется Task C5 (запись при офлайн-съёмке), Task C6 (фоновая докачка).

- [ ] **Step 1: Таблица в SCHEMA**

```javascript
// mobile/www/js/db.js, SCHEMA, после inventory_scan_state
CREATE TABLE IF NOT EXISTS pending_photo_uploads (
  asset_id TEXT PRIMARY KEY, local_path TEXT NOT NULL, created_at TEXT NOT NULL
);
```

Идемпотентно (`CREATE TABLE IF NOT EXISTS`) — новых guarded ALTER не нужно, таблица целиком новая (тот же приём, что `inventory_scan_state` в Этапе 4).

- [ ] **Step 2: CRUD-функции**

```javascript
// mobile/www/js/db.js, рядом с clearInventoryScans
async function queuePhotoUpload(assetId, localPath) {
  await db.run(
    'INSERT OR REPLACE INTO pending_photo_uploads (asset_id, local_path, created_at) VALUES (?, ?, ?)',
    [assetId, localPath, new Date().toISOString()]
  );
}

async function listPendingPhotoUploads() {
  const result = await db.query('SELECT asset_id AS assetId, local_path AS localPath, created_at AS createdAt FROM pending_photo_uploads');
  return result.values;
}

async function clearPendingPhotoUpload(assetId) {
  await db.run('DELETE FROM pending_photo_uploads WHERE asset_id = ?', [assetId]);
}
```

- [ ] **Step 3: Экспорт**

```javascript
// mobile/www/js/db.js, window.Db = { ... } (~строка 387) — добавить:
queuePhotoUpload, listPendingPhotoUploads, clearPendingPhotoUpload,
```

- [ ] **Step 4: Ручная проверка**

Собрать debug APK, вызвать через консоль устройства (или временный кнопочный триггер) `Db.queuePhotoUpload('ast_1', '/tmp/x.jpg')`, затем `Db.listPendingPhotoUploads()` — убедиться, что запись появляется и при повторном вызове с тем же `assetId` не дублируется (REPLACE).

- [ ] **Step 5: Коммит**

```bash
git add mobile/www/js/db.js
git commit -m "Task C4: pending_photo_uploads table + CRUD in mobile db.js"
```

---

### Task C5: мобильный — камера, сжатие, загрузка/очередь на карточке актива

**Files:**
- Modify: `mobile/www/index.html` (кнопка "Сфотографировать" на `screen-asset`)
- Modify: `mobile/www/js/screens.js` (обработчик, сжатие, upload/queue)

**Interfaces:**
- Consumes: `Camera.getPhoto` (плагин `@capacitor/camera`, уже используется в `scanner.js:78` — импорт `import { Camera } from '@capacitor/camera'` или эквивалентный паттерн, скопировать точно как в `scanner.js`), `Db.queuePhotoUpload` (Task C4), `Settings.get()` (для `serverUrl`/`token` — уже используется в других запросах, grep `apiFetch` или аналог в `screens.js`/`sync.js`).

- [ ] **Step 1: Найти, как `scanner.js` вызывает `Camera.getPhoto`, и как `screens.js`/`sync.js` делают авторизованные HTTP-запросы к серверу**

Run: `grep -n "import.*Camera\|Camera.getPhoto" mobile/www/js/scanner.js`
Run: `grep -n "function apiFetch\|fetch(" mobile/www/js/sync.js`

Скопировать оба паттерна буквально — не изобретать новый способ авторизации или вызова камеры.

- [ ] **Step 2: Кнопка на карточке актива**

```html
<!-- mobile/www/index.html, screen-asset, рядом с существующими кнопками действий -->
<button id="assetPhotoBtn" type="button">Сфотографировать</button>
```

- [ ] **Step 3: Обработчик — сжатие и попытка немедленной загрузки**

```javascript
// mobile/www/js/screens.js
document.getElementById('assetPhotoBtn')?.addEventListener('click', capturePhotoForCurrentAsset);

async function capturePhotoForCurrentAsset() {
  if (!currentAssetId) return;
  let photo;
  try {
    photo = await Camera.getPhoto({ quality: 70, resultType: 'dataUrl', source: 'CAMERA' }); // ЗАМЕНИТЬ параметры точно на то, что использует scanner.js — resultType/source должны совпадать по конвенции проекта
  } catch (err) {
    Toast.show('Не удалось получить фото с камеры.', 'error');
    return;
  }
  const compressed = await compressPhotoDataUrl(photo.dataUrl, 1600, 0.7);
  await uploadOrQueuePhoto(currentAssetId, compressed);
}

function compressPhotoDataUrl(dataUrl, maxDimension, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function uploadOrQueuePhoto(assetId, dataUrl) {
  const bytes = await (await fetch(dataUrl)).blob();
  const settings = await Settings.get();
  try {
    const response = await fetch(`${settings.serverUrl}/api/assets/${assetId}/photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${settings.token}` },
      body: bytes,
    });
    if (!response.ok) throw new Error('upload failed');
    Toast.show('Фото загружено.', 'info');
  } catch (err) {
    // Офлайн или сбой сети — сохранить локально и поставить в очередь докачки.
    const localPath = await savePhotoLocally(assetId, dataUrl); // Capacitor Filesystem — см. Step 4
    await Db.queuePhotoUpload(assetId, localPath);
    Toast.show('Нет сети — фото поставлено в очередь на отправку.', 'info');
  }
}
```

- [ ] **Step 4: Локальное сохранение файла (Capacitor Filesystem)**

```javascript
// mobile/www/js/screens.js
// Проверить точный импорт: grep "Filesystem" во всех mobile/www/js/*.js — если плагин
// @capacitor/filesystem ещё не используется нигде в проекте, это НОВАЯ зависимость и
// нарушает "без новых JS-библиотек" (Global Constraints) — в таком случае вместо
// файловой системы сохранить dataUrl ЦЕЛИКОМ как TEXT в pending_photo_uploads.local_path
// (base64 data URL, не путь) и скорректировать Task C6 соответственно. Предпочтительно
// сначала выполнить эту проверку и решить на месте, какой вариант используется.
async function savePhotoLocally(assetId, dataUrl) {
  // См. комментарий выше — либо Filesystem.writeFile(...), либо просто return dataUrl.
}
```

**Важно для реализатора:** этот шаг содержит открытое техническое решение (файл на диске vs. data URL в самой очереди) — сначала проверить, установлен ли `@capacitor/filesystem` (`grep filesystem mobile/package.json`), и выбрать вариант ДО написания кода. Если плагина нет — использовать вариант "data URL в очереди", он не требует новой зависимости и полностью укладывается в уже существующий `pending_photo_uploads.local_path TEXT`.

- [ ] **Step 5: Ручная проверка**

На реальном устройстве (или эмуляторе с камерой): сделать фото на карточке актива при включённой сети — должно загрузиться сразу, превью на десктопе должно обновиться после `/api/state`. Выключить сеть, сделать фото — должно попасть в очередь (проверить через `Db.listPendingPhotoUploads()`), не падать.

- [ ] **Step 6: Коммит**

```bash
git add mobile/www/index.html mobile/www/js/screens.js
git commit -m "Task C5: camera capture, compression, upload with offline queue fallback"
```

---

### Task C6: мобильный — фоновая докачка очереди фото

**Files:**
- Modify: `mobile/www/js/sync.js` (или файл, где определён `Sync.run()` — найти через grep)

**Interfaces:**
- Consumes: `Db.listPendingPhotoUploads`, `Db.clearPendingPhotoUpload` (Task C4).

- [ ] **Step 1: Найти точное место, где `Sync.run()` уже докачивает `pending_actions`**

Run: `grep -n "async function run\|Sync.run\s*=" mobile/www/js/sync.js`

- [ ] **Step 2: Добавить докачку фото в тот же цикл**

```javascript
// mobile/www/js/sync.js, внутри run(), после обработки pending_actions (до return)
  const pendingPhotos = await Db.listPendingPhotoUploads();
  for (const photo of pendingPhotos) {
    try {
      const bytes = await (await fetch(photo.localPath)).blob(); // если localPath — data URL; если это путь Filesystem, использовать соответствующее чтение (см. Task C5 Step 4)
      const settings = await Settings.get();
      const response = await fetch(`${settings.serverUrl}/api/assets/${photo.assetId}/photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${settings.token}` },
        body: bytes,
      });
      if (response.ok) {
        await Db.clearPendingPhotoUpload(photo.assetId);
      }
    } catch (err) {
      // Сеть всё ещё недоступна — оставить в очереди, попробовать на следующем цикле.
    }
  }
```

- [ ] **Step 3: Ручная проверка**

С устройства, у которого есть фото в `pending_photo_uploads` (после Task C5, Step 5), включить сеть и подождать следующий цикл синхронизации (или вызвать `Sync.run()` вручную) — очередь должна очиститься, фото должно появиться на сервере.

- [ ] **Step 4: Коммит**

```bash
git add mobile/www/js/sync.js
git commit -m "Task C6: background retry for queued photo uploads"
```

---

## Задача D — экспорт отчётов

### Task D1: десктоп — CSV "ведомость" (по сотруднику/отделу/объекту)

**Files:**
- Modify: `app.js` (новая чистая функция + кнопки на экранах сотрудника/отдела/объекта)

**Interfaces:**
- Consumes: `state.assets` (с `allocations`), переиспользует `escape`/`triggerDownload`-паттерн из `exportRegistryCsv` (`app.js:1048-1061`).
- Produces: `buildHandoverRows(state, {employeeId} | {department} | {site}) -> {headers, data}`.

- [ ] **Step 1: Найти экраны карточек сотрудника/отдела/объекта, где логично разместить кнопку**

Run: `grep -n "function openEmployeeDetailsModal\|function openDepartment\|function openSite" app.js`

- [ ] **Step 2: Чистая функция сборки строк**

```javascript
// app.js, рядом с buildRegistryRows
function buildHandoverRows(state, filter) {
  const headers = ["Актив", "Инв. номер", "Количество", "Цена", "Сумма"];
  const rows = [];
  for (const asset of state.assets) {
    for (const alloc of asset.allocations || []) {
      const matches = filter.employeeId ? alloc.employeeId === filter.employeeId
        : filter.department ? alloc.department === filter.department
        : filter.site ? alloc.site === filter.site
        : false;
      if (!matches) continue;
      const price = Number(asset.price || 0);
      rows.push([asset.name, asset.inventoryNumber || "", alloc.quantity, price, price * alloc.quantity]);
    }
  }
  return { headers, data: rows };
}

function exportHandoverCsv(filter, filenameSuffix) {
  const { headers, data } = buildHandoverRows(state, filter);
  const escape = (v) => {
    const s = String(v == null ? "" : v);
    if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const csv = [headers, ...data].map((row) => row.map(escape).join(";")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `Ведомость_${filenameSuffix}_${stamp}.csv`);
  showToast("Ведомость выгружена в CSV.", "info");
}
```

- [ ] **Step 3: Кнопки на трёх экранах**

Добавить `<button onclick="exportHandoverCsv({employeeId: '${employee.id}'}, '${employee.fullName}')">Экспорт CSV</button>` (и аналогично для department/site) в шаблоны, найденные в Step 1 — конкретную разметку подогнать под существующую структуру каждого экрана.

- [ ] **Step 4: Ручная проверка**

Открыть карточку сотрудника с закреплённой техникой, нажать "Экспорт CSV", открыть файл в Excel — кириллица и суммы должны отображаться корректно.

- [ ] **Step 5: Коммит**

```bash
git add app.js
git commit -m "Task D1: CSV export for employee/department/site handover lists"
```

---

### Task D2: десктоп — CSV "движения за период"

**Files:**
- Modify: `app.js` (новая функция + UI выбора периода + кнопка на экране движений)

**Interfaces:**
- Consumes: `state.movements` (уже загружены), `escape`/`triggerDownload`.

- [ ] **Step 1: Найти экран списка движений**

Run: `grep -n "function renderMovements\|screen.*movement" app.js index.html`

- [ ] **Step 2: Функция экспорта**

```javascript
// app.js
function exportMovementsCsv(dateFrom, dateTo) {
  const headers = ["Дата", "Тип", "Актив", "Количество", "Сотрудник/Отдел/Объект"];
  const filtered = state.movements.filter((m) => (!dateFrom || m.date >= dateFrom) && (!dateTo || m.date <= dateTo));
  const rows = filtered.map((m) => {
    const asset = state.assets.find((a) => a.id === m.assetId);
    const target = m.employeeId ? (getEmployeeById(m.employeeId)?.fullName || m.employeeId) : (m.department || m.site || "");
    return [m.date, m.type, asset ? asset.name : m.assetId, m.quantity, target];
  });
  const escape = (v) => {
    const s = String(v == null ? "" : v);
    if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const csv = [headers, ...rows].map((row) => row.map(escape).join(";")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  triggerDownload(blob, `Движения_${dateFrom || "все"}_${dateTo || "все"}.csv`);
  showToast("Движения выгружены в CSV.", "info");
}
```

`getEmployeeById` — проверить точное имя существующего хелпера (grep `function getEmployeeById`), использовать его вместо `.find(...)`, если уже есть.

- [ ] **Step 3: UI — поля дат + кнопка на экране движений**

Добавить в существующий экран движений (найден в Step 1) два `<input type="date">` и кнопку `onclick="exportMovementsCsv(document.getElementById('movementsFrom').value, document.getElementById('movementsTo').value)"`.

- [ ] **Step 4: Ручная проверка**

Задать диапазон дат, экспортировать, сверить количество строк с фильтрованным списком на экране.

- [ ] **Step 5: Коммит**

```bash
git add app.js index.html
git commit -m "Task D2: CSV export for movements by date range"
```

---

### Task D3: десктоп — CSV "остатки со стоимостью"

**Files:**
- Modify: `app.js` (новая функция, кнопка на экране реестра — рядом с существующей `exportRegistryCsv`)

**Interfaces:**
- Consumes: `state.assets`, `getAvailableQuantity` (уже есть).

- [ ] **Step 1: Функция экспорта**

```javascript
// app.js, рядом с exportRegistryCsv
function exportBalanceCsv() {
  const headers = ["Актив", "Инв. номер", "Остаток", "Цена", "Сумма остатка"];
  const rows = state.assets.map((asset) => {
    const available = getAvailableQuantity(asset);
    const price = Number(asset.price || 0);
    return [asset.name, asset.inventoryNumber || "", available, price, available * price];
  });
  const escape = (v) => {
    const s = String(v == null ? "" : v);
    if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const csv = [headers, ...rows].map((row) => row.map(escape).join(";")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `Остатки_${stamp}.csv`);
  showToast("Остатки выгружены в CSV.", "info");
}
```

- [ ] **Step 2: Кнопка на экране реестра**

Добавить рядом с существующей кнопкой "Экспорт реестра" (найти по grep `exportRegistryCsv` в `index.html`).

- [ ] **Step 3: Ручная проверка**

Экспортировать, сверить суммы вручную по паре позиций.

- [ ] **Step 4: Коммит**

```bash
git add app.js index.html
git commit -m "Task D3: CSV export for stock balances with cost"
```

---

### Task D4: "Ведомость на подпись" (.docx через act_generator)

**Files:**
- Modify: `act_generator.py` (`_build_placeholders`, `generate_act` — опциональный `action_phrase`)
- Modify: `server.py` (`handle_act_request` — прокинуть `actionPhrase` из payload)
- Modify: `app.js` (`downloadActDocx` — принять и передать `actionPhrase`; новая кнопка на экране сотрудника)
- Test: `tests/test_act_generator.py`

**Interfaces:**
- Consumes: существующий `POST /api/act`, `downloadActDocx({actNumber, date, employee, items, isIssue})` (`app.js:3057`).
- Produces: `generate_act(..., action_phrase: str | None = None)` — если передан, переопределяет `ISSUE_PHRASE`/`RETURN_PHRASE`.

- [ ] **Step 1: Написать падающий тест на `action_phrase`**

```python
# tests/test_act_generator.py — добавить рядом с существующими тестами generate_act
def test_generate_act_uses_custom_action_phrase_when_provided():
    docx_bytes = act_generator.generate_act(
        act_number=1, date_iso="2026-09-04",
        employee={"fullName": "Иванов И.И.", "position": "Инженер"},
        items=[{"name": "Ноутбук", "quantity": 1, "price": 1000}],
        is_issue=True,
        action_phrase="За Работником числится по состоянию на",
    )
    zf = zipfile.ZipFile(io.BytesIO(docx_bytes))
    document_xml = zf.read("word/document.xml").decode("utf-8")
    assert "За Работником числится по состоянию на" in document_xml
    assert act_generator.ISSUE_PHRASE not in document_xml
```

Проверить точные имена импортов `zipfile`/`io` в начале `tests/test_act_generator.py` (скорее всего уже импортированы для существующих тестов).

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `pytest tests/test_act_generator.py -k action_phrase -v`
Expected: FAIL — `TypeError: generate_act() got an unexpected keyword argument 'action_phrase'`

- [ ] **Step 3: Реализовать**

```python
# act_generator.py — новая константа рядом с ISSUE_PHRASE/RETURN_PHRASE
HANDOVER_PHRASE = "За Работником числится по состоянию на"
```

```python
# act_generator.py, _build_placeholders — добавить параметр
def _build_placeholders(
    *,
    act_number,
    date_iso,
    employee,
    is_issue: bool,
    action_phrase: str | None = None,
) -> dict[str, str]:
    ...
    return {
        "{{ACT_NUMBER}}": str(act_number).strip() if act_number else "_____",
        "{{EMPLOYEE_INFO}}": employee_text or ("_" * 52),
        "{{DAY}}": day,
        "{{MONTH}}": month,
        "{{YEAR}}": year,
        "{{ACTION_PHRASE}}": action_phrase or (ISSUE_PHRASE if is_issue else RETURN_PHRASE),
    }
```

```python
# act_generator.py, generate_act — добавить параметр и прокинуть дальше
def generate_act(
    *,
    act_number=None,
    date_iso: str | None = None,
    employee: dict | None = None,
    items: list[dict] | None = None,
    is_issue: bool = True,
    action_phrase: str | None = None,
) -> bytes:
    ...
    placeholders = _build_placeholders(
        act_number=act_number,
        date_iso=date_iso,
        employee=employee,
        is_issue=is_issue,
        action_phrase=action_phrase,
    )
```

- [ ] **Step 4: Прогнать тест**

Run: `pytest tests/test_act_generator.py -k action_phrase -v`
Expected: PASS

- [ ] **Step 5: Прокинуть через `/api/act`**

```python
# server.py, handle_act_request (~строка 1188) — добавить action_phrase:
            docx_bytes = generate_act(
                act_number=payload.get("actNumber"),
                date_iso=payload.get("date"),
                employee=payload.get("employee"),
                items=payload.get("items") or [],
                is_issue=bool(payload.get("isIssue", True)),
                action_phrase=payload.get("actionPhrase") or None,
            )
```

- [ ] **Step 6: Тест на прокидывание через HTTP**

```python
# tests/test_server_auth.py
def test_act_endpoint_accepts_custom_action_phrase(live_server):
    token = _create_admin(live_server)
    status, body = _fetch_bytes_post(live_server, "/api/act", token, {
        "actNumber": 1, "date": "2026-09-04",
        "employee": {"fullName": "Иванов И.И."},
        "items": [{"name": "Ноутбук", "quantity": 1, "price": 1000}],
        "isIssue": True,
        "actionPhrase": "За Работником числится по состоянию на",
    })
    assert status == 200
    zf = zipfile.ZipFile(io.BytesIO(body))
    assert "За Работником числится" in zf.read("word/document.xml").decode("utf-8")
```

Добавить локальный helper `_fetch_bytes_post` рядом с `_fetch_bytes` (тот принимает только GET) — POST с JSON-телом, ожидающий бинарный ответ:

```python
def _fetch_bytes_post(base_url, path, token, json_body):
    data = json.dumps(json_body).encode("utf-8")
    req = urllib.request.Request(f"{base_url}{path}", data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
```

Run: `pytest tests/test_server_auth.py -k action_phrase -v`
Expected: PASS

- [ ] **Step 7: Десктоп — кнопка "Ведомость на подпись" на экране сотрудника**

```javascript
// app.js, downloadActDocx — добавить необязательный параметр actionPhrase
async function downloadActDocx({ actNumber, date, employee, items, isIssue, actionPhrase }) {
  try {
    const payload = {
      actNumber, date, isIssue,
      employee: employee ? {
        fullName: employee.fullName || "", position: employee.position || "", department: employee.department || "",
      } : null,
      items,
      actionPhrase: actionPhrase || undefined,
      filename: `Акт_${actNumber || "документ"}.docx`,
    };
    // ...остальное тело функции без изменений
```

```javascript
// app.js, новая функция рядом с buildHandoverRows (Task D1)
async function downloadHandoverSheet(employee) {
  const { data } = buildHandoverRows(state, { employeeId: employee.id });
  const items = data.map(([name, inventoryNumber, quantity, price]) => ({ name, inventoryNumber, quantity, price }));
  await downloadActDocx({
    actNumber: null,
    date: new Date().toISOString().slice(0, 10),
    employee,
    items,
    isIssue: true,
    actionPhrase: "За Работником числится по состоянию на",
  });
}
```

Добавить кнопку `<button onclick="downloadHandoverSheet(${JSON.stringify(employee).replace(/"/g, '&quot;')})">Ведомость на подпись</button>` на том же экране сотрудника, где добавлена кнопка CSV (Task D1) — либо, если передача целого объекта через `onclick`-атрибут неудобна (уже сложившийся в файле стиль — проверить, как передаются объекты в существующих `onclick`, например у "Выдать технику" на строке 1537: там передаётся только `employee.id`), взять этот же паттерн: `downloadHandoverSheet('${employee.id}')`, и найти employee по id внутри функции через `getEmployeeById`.

- [ ] **Step 8: Ручная проверка**

Открыть карточку сотрудника с закреплённой техникой, нажать "Ведомость на подпись", открыть скачанный `.docx` — таблица должна содержать те же позиции, что и CSV-ведомость, с фразой "За Работником числится по состоянию на" вместо "Работодатель передал...".

- [ ] **Step 9: Прогнать весь набор тестов**

Run: `pytest -q`
Expected: все тесты зелёные

- [ ] **Step 10: Коммит**

```bash
git add act_generator.py server.py app.js tests/test_act_generator.py tests/test_server_auth.py
git commit -m "Task D4: reuse generate_act for a signed handover sheet via a custom action phrase"
```

---

## Финальная задача

### Task Z1: финальная верификация этапа 5

**Files:** нет новых — только запуск и проверка.

- [ ] **Step 1: Полный прогон тестов**

Run: `pytest -q` (ожидается: все прежние + новые из Task A1/A2/C1/C2/D4 зелёные)
Run: `cd mobile && node --test` (ожидается: все прежние + новые из Task A4/B3 зелёные)

- [ ] **Step 2: Пересобрать EXE**

Использовать существующий процесс сборки (см. `docs/RELEASING.md`, добавленный в Этапе 3) — собрать `WarehouseApp.exe` из текущего `master`/рабочей ветки, заменить в `D:\warehouse\WarehouseApp.exe`, перезапустить.

- [ ] **Step 3: Пересобрать APK**

`cd mobile/android && ./gradlew assembleDebug` (или релизный сценарий, если ключ доступен — см. `docs/RELEASING.md`).

- [ ] **Step 4: Ручной обход критериев приёмки**

1. Панель внимания: создать актив с гарантией в пределах порога / просроченной — убедиться, что появляется и на десктопе, и на мобильном (после синхронизации), и ровно с теми параметрами, что заданы в настройках.
2. Обходной лист: уволить сотрудника с закреплённой техникой (десктоп) → синхронизировать телефон под admin → вернуть всё через мобильный экран "Сотрудники" → убедиться, что сводка показывает "Всё сдано" и что уволенный больше не предлагается в списке выдачи на десктопе.
3. Фото: снять фото на телефоне в офлайне → включить сеть → дождаться синхронизации → открыть карточку актива на десктопе, убедиться что фото появилось.
4. CSV: открыть все три новых CSV (ведомость/движения/остатки) в Excel — кириллица и цифры должны отображаться корректно.
5. `.docx` "Ведомость на подпись" — открыть в Word, проверить читаемость фразы и таблицы.

- [ ] **Step 5: Коммит (если Step 2-4 потребовали правок)**

Если ручная проверка выявила проблемы — исправить, повторить Step 1, закоммитить как отдельный "fix round", а не заново весь этап.

```bash
git add -A
git commit -m "Task Z1: final Stage 5 verification — tests, EXE/APK rebuild, acceptance walkthrough"
```
