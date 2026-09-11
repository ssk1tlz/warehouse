# Общий QR-стикер на рабочее место — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** В окне печати этикеток добавить режим «один общий стикер на стол» (вместо этикетки на каждую единицу техники), и научить мобильное приложение склада сканировать такой стикер (новый QR-префикс `WHW1:`) и показывать всю технику стола + текущего сотрудника — данные всегда свежие на момент скана, без изменений на сервере.

**Architecture:** Десктоп: `labelSelection` (Map в `app.js`, копит выбор для печати) переходит на составные ключи `asset:<id>`/`workplace:<id>`, чтобы держать вперемешку штучные позиции и «стикер стола»; печать/PDF/JPG/Word/предпросмотр не меняются — им подсовывается псевдо-объект актива с `__labelKind: 'workplace'`, который новые `buildLabelHtml`/`drawLabelOnCanvas` распознают в первой строке и делегируют в новые функции-зеркала. Мобильное: локальный кэш (`db.js`) получает таблицу `workplaces` и колонку `allocations.workplace_id` — оба уже приходят с сервера в `/api/state`, просто не сохранялись; новый QR-префикс `WHW1:` разбирается тем же сканером, что и `WH1:`/`WHC1:`, и ведёт на новый экран-карточку стола.

**Tech Stack:** Браузерный JS без сборки (`app.js`, `asset_ops.js`, `index.html`, `styles.css`); мобильное — Capacitor/vanilla JS (`mobile/www/js/*.js`, `mobile/www/index.html`); тесты — `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-11-workplace-label-qr-design.md`

## Global Constraints

- Комментарии и текст интерфейса — на русском, как во всём проекте.
- Сервер (`server.py`, `migrations.py`) не меняется — все нужные поля уже отдаются `/api/state`.
- `buildLabelHtml`/`drawLabelOnCanvas` и новые `buildWorkplaceLabelHtml`/`drawWorkplaceLabelOnCanvas` — независимые пары рендереров (HTML для печати/Word, Canvas для превью/JPG/PDF); визуальная правка в одном без зеркальной правки в другом — баг.
- Десктоп (`app.js`/`index.html`/`styles.css`) без автотестов — `node --check app.js` на синтаксис, дальше только ручная проверка в браузере (`python -m http.server 8790 --bind 127.0.0.1 --directory /d/warehouse`), как для всего окна печати этикеток в прошлых этапах.
- Мобильное: чистая логика без нативных плагинов (`qr.js`) — тестируется `node --test mobile/tests/*.test.js`. `db.js` (нативный SQLite-плагин) и полный экран сканирования — без автотестов, только ручная проверка на устройстве/эмуляторе (тот же прецедент, что у `startInventoryScan`/`stopScan`).
- JS-тесты запускать: `node --test mobile/tests/*.test.js tests/*.test.js`.
- Временные файлы браузерной проверки (`_tmp_state.json` и т.п.) — никогда не коммитить.
- Печать самой техники на стикере стола — не печатается (весь смысл QR); Excel-экспорт этикеток остаётся отчётом только по активам (стол в него не попадает).

---

### Task 1: `parseWorkplaceQr` и комбинированный разбор QR (мобильное)

**Files:**
- Modify: `mobile/www/js/qr.js`
- Test: `mobile/tests/qr.test.js`

**Interfaces:**
- Consumes: ничего нового (чистые функции).
- Produces: `parseWorkplaceQr(text)` → id стола (строка) или `null`. `parseWarehouseTarget(text)` → `{ kind: 'asset'|'workplace', id }` или `null` — используется в Task 2 сканером как единая точка входа вместо голого `parseWarehouseQr`.

- [ ] **Step 1: Написать падающие тесты**

Дописать в конец `mobile/tests/qr.test.js` (заменить импорт в шапке файла):

```javascript
const { parseWarehouseQr, parseConnectQr, parseWorkplaceQr, parseWarehouseTarget } = require('../www/js/qr.js');
```

и в конец файла:

```javascript

// ─── QR рабочего места (WHW1:) ────────────────────────────────

test('extracts the workplace id from a valid workplace QR', () => {
  assert.equal(parseWorkplaceQr('WHW1:wp_1755600000000_ab12cd'), 'wp_1755600000000_ab12cd');
});

test('parseWorkplaceQr returns null for text without the WHW1: prefix', () => {
  assert.equal(parseWorkplaceQr('WH1:ast_1'), null);
});

test('parseWorkplaceQr returns null when the prefix is present but the id is empty', () => {
  assert.equal(parseWorkplaceQr('WHW1:'), null);
});

test('parseWorkplaceQr returns null for an empty or missing scan result', () => {
  assert.equal(parseWorkplaceQr(''), null);
  assert.equal(parseWorkplaceQr(null), null);
  assert.equal(parseWorkplaceQr(undefined), null);
});

test('parseWorkplaceQr trims incidental whitespace', () => {
  assert.equal(parseWorkplaceQr('  WHW1:wp_1  '), 'wp_1');
});

// ─── Комбинированный разбор для кнопки «Скан» ──────────────────

test('parseWarehouseTarget recognizes an asset QR', () => {
  assert.deepEqual(parseWarehouseTarget('WH1:ast_1'), { kind: 'asset', id: 'ast_1' });
});

test('parseWarehouseTarget recognizes a workplace QR', () => {
  assert.deepEqual(parseWarehouseTarget('WHW1:wp_1'), { kind: 'workplace', id: 'wp_1' });
});

test('parseWarehouseTarget returns null for an unrecognized QR', () => {
  assert.equal(parseWarehouseTarget('INV-004821'), null);
});

test('parseWarehouseTarget does not mistake a connect QR for an asset or workplace QR', () => {
  assert.equal(parseWarehouseTarget('WHC1:{"url":"http://x","code":"a","secret":"b"}'), null);
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

Run: `node --test mobile/tests/qr.test.js`
Expected: FAIL — `parseWorkplaceQr is not a function` / `parseWarehouseTarget is not a function` (9 новых тестов падают, существующие проходят).

- [ ] **Step 3: Реализовать**

В `mobile/www/js/qr.js` заменить весь файл на:

```javascript
const WAREHOUSE_QR_PREFIX = 'WH1:';
const WAREHOUSE_CONNECT_QR_PREFIX = 'WHC1:';
const WAREHOUSE_WORKPLACE_QR_PREFIX = 'WHW1:';

function parseWarehouseQr(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith(WAREHOUSE_QR_PREFIX)) return null;
  const id = trimmed.slice(WAREHOUSE_QR_PREFIX.length);
  return id ? id : null;
}

// Стикер рабочего места (стол печатает один общий QR вместо этикетки на
// каждую единицу техники — см. дизайн-спеку) — тот же приём, что и у
// parseWarehouseQr, свой префикс.
function parseWorkplaceQr(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith(WAREHOUSE_WORKPLACE_QR_PREFIX)) return null;
  const id = trimmed.slice(WAREHOUSE_WORKPLACE_QR_PREFIX.length);
  return id ? id : null;
}

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

// Кнопка «Скан» в приложении одна на оба вида стикеров склада — актив
// (WH1:) и стол (WHW1:). Какой из них перед нами, решает вызывающий код
// (screens.js) по полю kind, а не по формату id.
function parseWarehouseTarget(text) {
  const assetId = parseWarehouseQr(text);
  if (assetId) return { kind: 'asset', id: assetId };
  const workplaceId = parseWorkplaceQr(text);
  if (workplaceId) return { kind: 'workplace', id: workplaceId };
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseWarehouseQr, parseConnectQr, parseWorkplaceQr, parseWarehouseTarget };
}
if (typeof window !== 'undefined') {
  Object.assign(window, { parseWarehouseQr, parseConnectQr, parseWorkplaceQr, parseWarehouseTarget });
}
```

- [ ] **Step 4: Запустить тесты и убедиться, что проходят**

Run: `node --test mobile/tests/qr.test.js`
Expected: PASS, все тесты файла зелёные (18 всего: 9 старых + 9 новых).

- [ ] **Step 5: Коммит**

```bash
git add mobile/www/js/qr.js mobile/tests/qr.test.js
git commit -m "$(cat <<'EOF'
feat(mobile): parseWorkplaceQr и комбинированный разбор QR стола/актива

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CwXMrAnYENeMjBmBirZwgo
EOF
)"
```

---

### Task 2: Сканер и обработчик кнопки «Скан» узнают QR стола

**Files:**
- Modify: `mobile/www/js/scanner.js:47-49` (`scanOnce`)
- Modify: `mobile/www/js/screens.js:963-971` (обработчик `scanBtn`)

**Interfaces:**
- Consumes: `parseWarehouseTarget` (Task 1).
- Produces: `Scanner.scanOnce()` теперь возвращает `{ kind: 'asset'|'workplace', id }` вместо голого id актива (единственный вызывающий — `screens.js:965`, меняется в этом же таске). `openWorkplaceScreen` (Task 4) — обработчик уже ссылается на неё, функция появится в Task 4; до Task 4 ручная проверка скана стола покажет ошибку `openWorkplaceScreen is not defined`, это ожидаемо и фиксируется следующим таском.

- [ ] **Step 1: Поменять `scanOnce` на комбинированный разбор**

В `mobile/www/js/scanner.js:47-49` заменить:

```javascript
function scanOnce() {
  return scan(parseWarehouseQr, 'Это не похоже на этикетку склада — QR не распознан.');
}
```

на:

```javascript
function scanOnce() {
  return scan(parseWarehouseTarget, 'Это не похоже на этикетку склада — QR не распознан.');
}
```

- [ ] **Step 2: Ветвление в обработчике кнопки «Скан»**

В `mobile/www/js/screens.js:963-971` заменить:

```javascript
  document.getElementById('scanBtn').addEventListener('click', async () => {
    try {
      const assetId = await Scanner.scanOnce();
      if (!assetId) return; // cancelled or not a warehouse QR
      await openAssetScreen(assetId);
    } catch (error) {
      Toast.show(describeScanError(error, 'Не удалось выполнить сканирование.'), 'error');
    }
  });
```

на:

```javascript
  document.getElementById('scanBtn').addEventListener('click', async () => {
    try {
      const result = await Scanner.scanOnce();
      if (!result) return; // cancelled or not a warehouse QR
      if (result.kind === 'workplace') await openWorkplaceScreen(result.id);
      else await openAssetScreen(result.id);
    } catch (error) {
      Toast.show(describeScanError(error, 'Не удалось выполнить сканирование.'), 'error');
    }
  });
```

- [ ] **Step 3: Проверить синтаксис**

Run: `node --check mobile/www/js/scanner.js && node --check mobile/www/js/screens.js`
Expected: без вывода.

- [ ] **Step 4: Запустить существующие мобильные тесты**

Run: `node --test mobile/tests/*.test.js`
Expected: PASS (существующий `scanner.test.js` не трогает `scanOnce`, не затронут; `screens.test.js` не трогает обработчик кнопки — DOM-код, как и раньше, без автотестов).

- [ ] **Step 5: Коммит**

```bash
git add mobile/www/js/scanner.js mobile/www/js/screens.js
git commit -m "$(cat <<'EOF'
feat(mobile): скан различает QR актива и рабочего места

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CwXMrAnYENeMjBmBirZwgo
EOF
)"
```

(Ручная проверка на устройстве — в Task 4, вместе с самим экраном стола, чтобы не гонять сборку APK дважды подряд.)

---

### Task 3: Локальный кэш столов на телефоне (`db.js`)

**Files:**
- Modify: `mobile/www/js/db.js`

**Interfaces:**
- Consumes: `state.workplaces` (уже приходит в `/api/state`: `id, name, code, department, employeeId, site, notes`); `alloc.workplaceId` в каждом `asset.allocations` (уже приходит, сейчас не сохраняется).
- Produces: `Db.getWorkplaceById(workplaceId)` → `{ id, name, code, department, employeeId, site }` или `null`. `Db.getAllocationsForWorkplace(workplaceId, occupantEmployeeId)` → массив `{ assetId, quantity, name, category, inventoryNumber, serialNumber, status }` — вся техника, закреплённая за столом ИЛИ лично за тем, кто сейчас на нём сидит (тот же принцип, что `getWorkplaceAssets` на десктопе, `app.js:2844`).

- [ ] **Step 1: Новая таблица и колонка в схеме**

В `mobile/www/js/db.js` в константе `SCHEMA` (после `CREATE TABLE IF NOT EXISTS sites ...`, строка 21) добавить:

```sql
CREATE TABLE IF NOT EXISTS workplaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT, department TEXT, employee_id TEXT, site TEXT
);
```

- [ ] **Step 2: `ALTER TABLE` для существующих установок**

В `open()` (`db.js:48-66`) после блока `ALTER TABLE employees ADD COLUMN status TEXT` (строки 61-65) добавить:

```javascript
  try {
    await db.execute('ALTER TABLE allocations ADD COLUMN workplace_id TEXT');
  } catch (err) {
    // Уже есть колонка — см. комментарий у ALTER TABLE assets ADD COLUMN rev выше.
  }
```

- [ ] **Step 3: Сохранять `workplaces` и `workplace_id` при каждой синхронизации**

В `replaceState()` (`db.js:68-130`) добавить `'DELETE FROM workplaces'` в массив `txn` (после `{ statement: 'DELETE FROM allocations' }` — строка 83):

```javascript
    { statement: 'DELETE FROM workplaces' },
```

Заменить INSERT для `allocations` (строки 96-101):

```javascript
    for (const alloc of a.allocations || []) {
      txn.push({
        statement: 'INSERT INTO allocations (asset_id, employee_id, department, site, quantity) VALUES (?,?,?,?,?)',
        values: [a.id, alloc.employeeId, alloc.department, alloc.site, alloc.quantity],
      });
    }
```

на:

```javascript
    for (const alloc of a.allocations || []) {
      txn.push({
        statement: 'INSERT INTO allocations (asset_id, employee_id, department, site, workplace_id, quantity) VALUES (?,?,?,?,?,?)',
        values: [a.id, alloc.employeeId, alloc.department, alloc.site, alloc.workplaceId || '', alloc.quantity],
      });
    }
```

После цикла `for (const s of state.sites) { ... }` (строки 112-114) добавить:

```javascript
  for (const w of state.workplaces || []) {
    txn.push({
      statement: 'INSERT INTO workplaces (id, name, code, department, employee_id, site) VALUES (?,?,?,?,?,?)',
      values: [w.id, w.name, w.code || '', w.department || '', w.employeeId || '', w.site || ''],
    });
  }
```

- [ ] **Step 4: `Db.getWorkplaceById` и `Db.getAllocationsForWorkplace`**

Рядом с `getAllocationsForEmployee` (`db.js:306-316`) добавить:

```javascript
async function getWorkplaceById(workplaceId) {
  const result = await db.query(
    'SELECT id, name, code, department, employee_id AS employeeId, site FROM workplaces WHERE id = ?',
    [workplaceId]
  );
  return result.values[0] || null;
}

// Техника стола: закреплённая за самим местом ИЛИ лично за тем, кто
// сейчас на нём сидит (occupantEmployeeId — workplaces.employee_id) —
// тот же принцип, что у getWorkplaceAssets на десктопе (app.js:2844).
async function getAllocationsForWorkplace(workplaceId, occupantEmployeeId) {
  const result = await db.query(
    `SELECT allocations.asset_id AS assetId, allocations.quantity AS quantity,
            assets.name AS name, assets.category AS category,
            assets.inventory_number AS inventoryNumber, assets.serial_number AS serialNumber,
            assets.status AS status
     FROM allocations JOIN assets ON assets.id = allocations.asset_id
     WHERE (allocations.workplace_id = ? OR allocations.employee_id = ?) AND allocations.quantity > 0
     ORDER BY assets.name`,
    [workplaceId, occupantEmployeeId || '']
  );
  return result.values;
}
```

- [ ] **Step 5: Экспорт новых функций**

В `db.js:442` заменить:

```javascript
window.Db = { open, replaceState, getAssetById, getStateMeta, listEmployeesById, listMovementsForAsset, listMovementHistory, searchAssets, enqueueAction, listPendingActions, markActionSynced, markActionFailed, retryAction, markActionConflict, retryActionOnTop, cancelAction, generateClientActionId, saveInventoryScan, getInventoryScans, clearInventoryScans, getAllAssets, clearActiveInventorySessionMeta, queuePhotoUpload, listPendingPhotoUploads, clearPendingPhotoUpload, searchEmployees, getAllocationsForEmployee };
```

на:

```javascript
window.Db = { open, replaceState, getAssetById, getStateMeta, listEmployeesById, listMovementsForAsset, listMovementHistory, searchAssets, enqueueAction, listPendingActions, markActionSynced, markActionFailed, retryAction, markActionConflict, retryActionOnTop, cancelAction, generateClientActionId, saveInventoryScan, getInventoryScans, clearInventoryScans, getAllAssets, clearActiveInventorySessionMeta, queuePhotoUpload, listPendingPhotoUploads, clearPendingPhotoUpload, searchEmployees, getAllocationsForEmployee, getWorkplaceById, getAllocationsForWorkplace };
```

- [ ] **Step 6: Проверить синтаксис**

Run: `node --check mobile/www/js/db.js`
Expected: без вывода.

`db.js` использует нативный SQLite-плагин (`window.capacitorCapacitorSQLite`) — недоступен под `node --test`, автотестов для него в проекте нет (см. Global Constraints). Функциональная проверка — в Task 4, вместе с экраном, который их вызывает.

- [ ] **Step 7: Коммит**

```bash
git add mobile/www/js/db.js
git commit -m "$(cat <<'EOF'
feat(mobile): кэшировать рабочие места и workplace_id в локальной БД

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CwXMrAnYENeMjBmBirZwgo
EOF
)"
```

---

### Task 4: Экран «Рабочее место» на телефоне

**Files:**
- Modify: `mobile/www/index.html` (после `#screen-employee-detail`, строки 133-139)
- Modify: `mobile/www/js/screens.js` (новая `openWorkplaceScreen`, рядом с `openEmployeeDetailScreen` — строка 550; регистрация `workplaceDetailBackBtn` рядом с `employeeDetailBackBtn` — строка 997)

**Interfaces:**
- Consumes: `Db.getWorkplaceById`, `Db.getAllocationsForWorkplace`, `Db.listEmployeesById` (Task 3, существующая), `STATUS_LABELS` (`format.js`).
- Produces: `openWorkplaceScreen(workplaceId)` — вызывается из обработчика `scanBtn` (Task 2).

- [ ] **Step 1: Разметка экрана**

В `mobile/www/index.html` после закрывающего `</section>` блока `#screen-employee-detail` (строка 139) добавить:

```html

  <section id="screen-workplace-detail" class="screen hidden" data-back="screen-scan">
    <button id="workplaceDetailBackBtn" type="button" class="ghost">‹ Назад</button>
    <h2 id="workplaceDetailName"></h2>
    <p id="workplaceDetailMeta"></p>
    <p id="workplaceDetailOccupant"></p>
    <ul id="workplaceAssetsList"></ul>
  </section>
```

- [ ] **Step 2: `openWorkplaceScreen`**

В `mobile/www/js/screens.js` рядом с `openEmployeeDetailScreen` (перед строкой 550) добавить:

```javascript
// Экран стола после скана его QR (WHW1:) — только просмотр: сотрудник и
// полная техника, закреплённая за столом или лично за тем, кто сейчас
// на нём сидит. Данные читаются из локального кэша в момент открытия
// экрана (не запекаются в QR) — пересадка сотрудника отражается на
// следующем скане после ближайшей синхронизации (см. дизайн-спеку).
async function openWorkplaceScreen(workplaceId) {
  const workplace = await Db.getWorkplaceById(workplaceId);
  if (!workplace) {
    Toast.show('Этот QR не найден в кэше. Подключитесь к сети склада и повторите синхронизацию.', 'error');
    return;
  }
  document.getElementById('workplaceDetailName').textContent = workplace.name;
  document.getElementById('workplaceDetailMeta').textContent =
    `${workplace.code || '—'} · ${workplace.department || '—'} · ${workplace.site || '—'}`;

  const occupantEl = document.getElementById('workplaceDetailOccupant');
  if (workplace.employeeId) {
    const employees = await Db.listEmployeesById();
    const employee = employees.get(workplace.employeeId);
    occupantEl.textContent = employee ? employee.fullName : 'Неизвестный сотрудник';
  } else {
    occupantEl.textContent = 'Свободно';
  }

  const assets = await Db.getAllocationsForWorkplace(workplaceId, workplace.employeeId || '');
  const listEl = document.getElementById('workplaceAssetsList');
  listEl.innerHTML = '';
  if (!assets.length) {
    const li = document.createElement('li');
    li.textContent = 'Техники нет';
    listEl.appendChild(li);
  } else {
    for (const asset of assets) {
      const li = document.createElement('li');
      const statusText = STATUS_LABELS[asset.status] || asset.status || '';
      li.textContent = `${asset.name} — ${asset.category || '—'} · С/н ${asset.serialNumber || '—'} · Инв. № ${asset.inventoryNumber || '—'} · ${statusText} · ${asset.quantity} шт.`;
      listEl.appendChild(li);
    }
  }
  showScreen('screen-workplace-detail');
}
```

- [ ] **Step 3: Кнопка «Назад»**

В `mobile/www/js/screens.js` рядом с `employeeDetailBackBtn` (строка 997) добавить:

```javascript
  document.getElementById('workplaceDetailBackBtn')?.addEventListener('click', () => showScreen('screen-scan'));
```

- [ ] **Step 4: Проверить синтаксис**

Run: `node --check mobile/www/js/screens.js`
Expected: без вывода.

- [ ] **Step 5: Собрать APK и проверить на устройстве/эмуляторе**

```bash
cd mobile && npx cap sync android && cd android && gradlew.bat assembleDebug
```

Установить полученный `app-debug.apk`. Печатного QR стола пока нет (появится в Task 6) — экран проверяется напрямую через Chrome remote debugging, без физического скана:

1. Открыть `chrome://inspect` на компьютере (телефон подключён по USB с включённой отладкой, либо эмулятор), найти WebView приложения, открыть DevTools → Console.
2. Регрессия: в приложении на телефоне открыть «Скан», отсканировать существующий QR актива (`WH1:`) — карточка актива открывается как раньше.
3. В консоли DevTools выполнить `Db.getWorkplaceById('<реальный id стола>')` (id взять из десктопа — например, из ответа `GET /api/state` или атрибутов формы рабочего места) — убедиться, что возвращается не `null`, а объект с `name`/`code`/`department`/`employeeId`/`site`.
4. Там же выполнить `Db.getAllocationsForWorkplace('<id стола>', '<employeeId стола или "">')` — убедиться, что список непустой для стола с техникой и содержит `category`/`serialNumber`/`inventoryNumber`/`status`.
5. Там же выполнить `openWorkplaceScreen('<id стола>')` — экран рабочего места открывается на телефоне с этими данными (имя, код/отдел/объект, сотрудник, список техники).
6. Полный скан-сценарий (реальный стикер → экран стола) — в сквозной проверке Task 7, когда стикер уже можно напечатать (Task 6).

- [ ] **Step 6: Коммит**

```bash
git add mobile/www/index.html mobile/www/js/screens.js
git commit -m "$(cat <<'EOF'
feat(mobile): экран рабочего места после скана его QR

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CwXMrAnYENeMjBmBirZwgo
EOF
)"
```

---

### Task 5: Десктоп — составные ключи выбора этикеток (`asset:`/`workplace:`)

Рефакторинг без новой функциональности: `labelSelection` переходит на составные ключи, чтобы в Task 6 в ней же можно было держать позиции-«столы» без риска столкновения id. После этого таска поведение окна печати должно быть **неотличимо** от текущего — проверка ручная, по тому же сценарию, что уже работал.

**Files:**
- Modify: `app.js` (`openLabelsModal:6196-6218`, `getLabelAssets:6461-6472`, `renderLabelGrid:6539-6604`, `addEmployeeAssetsToLabelSelection:6640-6675`, `updateLabelCount:6677-6690`, `getSelectedLabelItems:6692-6700`)

**Interfaces:**
- Consumes: ничего нового.
- Produces: `labelAssetKey(assetId)` → `"asset:" + assetId`; `labelWorkplaceKey(workplaceId)` → `"workplace:" + workplaceId` (используется начиная с Task 6 — сама функция заводится здесь же, рядом, для целостности пары). Используются всеми последующими тасками, которые трогают `labelSelection`.

- [ ] **Step 1: Ключ-хелпер**

В `app.js` прямо перед `let labelSelection = new Map();` (строка 6537) добавить:

```javascript
// labelSelection копит вперемешку отдельные активы и целые столы (Task 6)
// — составной ключ отличает их без риска коллизии id.
function labelAssetKey(assetId) { return `asset:${assetId}`; }
function labelWorkplaceKey(workplaceId) { return `workplace:${workplaceId}`; }
```

- [ ] **Step 2: `openLabelsModal` — preselect с префиксом**

В `app.js:6206` заменить:

```javascript
  labelSelection = new Map(preselect ? [[preselect, "1"]] : []);
```

на:

```javascript
  labelSelection = new Map(preselect ? [[labelAssetKey(preselect), "1"]] : []);
```

- [ ] **Step 3: `getLabelAssets` — «только выбранные» читает только `asset:`-ключи**

В `app.js:6461-6472` заменить:

```javascript
function getLabelAssets() {
  const target = getLabelTarget();
  const onlySelected = document.getElementById("labelOnlySelectedCheck")?.checked || false;
  return AssetOps.filterLabelAssets(state.assets, {
    query: document.getElementById("labelSearchInput")?.value || "",
    category: document.getElementById("labelFilterCategory")?.value || "",
    location: document.getElementById("labelFilterLocation")?.value || "",
    onlyUnprinted: document.getElementById("labelUnprintedCheck")?.checked || false,
    onlyAssetIds: getLabelTargetAssetIds(target),
    selectedIds: onlySelected ? [...labelSelection.keys()] : null,
  });
}
```

на:

```javascript
function getLabelAssets() {
  const target = getLabelTarget();
  const onlySelected = document.getElementById("labelOnlySelectedCheck")?.checked || false;
  return AssetOps.filterLabelAssets(state.assets, {
    query: document.getElementById("labelSearchInput")?.value || "",
    category: document.getElementById("labelFilterCategory")?.value || "",
    location: document.getElementById("labelFilterLocation")?.value || "",
    onlyUnprinted: document.getElementById("labelUnprintedCheck")?.checked || false,
    onlyAssetIds: getLabelTargetAssetIds(target),
    selectedIds: onlySelected
      ? [...labelSelection.keys()].filter((key) => key.startsWith("asset:")).map((key) => key.slice(6))
      : null,
  });
}
```

- [ ] **Step 4: `renderLabelGrid` — карточки активов используют `asset:`-ключ**

В `app.js:6558-6602` (тело `.map(...)` и `forEach` обработчиков внутри `renderLabelGrid`) заменить:

```javascript
  grid.innerHTML = assets.map(asset => {
    const isSelected = labelSelection.has(asset.id);
    const qty = labelSelection.get(asset.id) || "1";
    return `<div class="label-item${isSelected ? " selected" : ""}" data-id="${asset.id}">
      <input type="checkbox" ${isSelected ? "checked" : ""} data-asset-id="${asset.id}">
      <div class="label-item-info">
        <div class="label-item-name">${escapeHtml(asset.name)}</div>
        <div class="label-item-meta">${escapeHtml(asset.inventoryNumber || asset.serialNumber || asset.category || "")}</div>
      </div>
      <input type="number" class="label-qty-input" value="${qty}" min="1" max="99" data-qty-asset="${asset.id}" title="Кол-во этикеток">
    </div>`;
  }).join("");

  grid.querySelectorAll(".label-item").forEach(item => {
    const assetId = item.dataset.id;
    // Клик по всему элементу (кроме input полей)
    item.addEventListener("click", (e) => {
      // Игнорируем клики по input элементам
      if (e.target.tagName === "INPUT") return;
      const cb = item.querySelector("input[type=checkbox]");
      cb.checked = !cb.checked;
      item.classList.toggle("selected", cb.checked);
      if (cb.checked) labelSelection.set(assetId, item.querySelector(".label-qty-input").value);
      else labelSelection.delete(assetId);
      updateLabelCount();
    });

    // Обработка изменения чекбокса
    const cb = item.querySelector("input[type=checkbox]");
    cb.addEventListener("change", (e) => {
      e.stopPropagation();
      item.classList.toggle("selected", cb.checked);
      if (cb.checked) labelSelection.set(assetId, item.querySelector(".label-qty-input").value);
      else labelSelection.delete(assetId);
      updateLabelCount();
    });

    // Обработка клика по полю количества
    const qtyInput = item.querySelector(".label-qty-input");
    qtyInput.addEventListener("click", e => e.stopPropagation());
    qtyInput.addEventListener("focus", e => e.stopPropagation());
    qtyInput.addEventListener("input", () => {
      if (labelSelection.has(assetId)) labelSelection.set(assetId, qtyInput.value);
    });
  });
  updateLabelCount();
}
```

на:

```javascript
  grid.innerHTML = assets.map(asset => {
    const key = labelAssetKey(asset.id);
    const isSelected = labelSelection.has(key);
    const qty = labelSelection.get(key) || "1";
    return `<div class="label-item${isSelected ? " selected" : ""}" data-id="${key}">
      <input type="checkbox" ${isSelected ? "checked" : ""} data-asset-id="${asset.id}">
      <div class="label-item-info">
        <div class="label-item-name">${escapeHtml(asset.name)}</div>
        <div class="label-item-meta">${escapeHtml(asset.inventoryNumber || asset.serialNumber || asset.category || "")}</div>
      </div>
      <input type="number" class="label-qty-input" value="${qty}" min="1" max="99" data-qty-asset="${asset.id}" title="Кол-во этикеток">
    </div>`;
  }).join("");

  grid.querySelectorAll(".label-item").forEach(item => {
    const key = item.dataset.id;
    // Клик по всему элементу (кроме input полей)
    item.addEventListener("click", (e) => {
      // Игнорируем клики по input элементам
      if (e.target.tagName === "INPUT") return;
      const cb = item.querySelector("input[type=checkbox]");
      cb.checked = !cb.checked;
      item.classList.toggle("selected", cb.checked);
      if (cb.checked) labelSelection.set(key, item.querySelector(".label-qty-input").value);
      else labelSelection.delete(key);
      updateLabelCount();
    });

    // Обработка изменения чекбокса
    const cb = item.querySelector("input[type=checkbox]");
    cb.addEventListener("change", (e) => {
      e.stopPropagation();
      item.classList.toggle("selected", cb.checked);
      if (cb.checked) labelSelection.set(key, item.querySelector(".label-qty-input").value);
      else labelSelection.delete(key);
      updateLabelCount();
    });

    // Обработка клика по полю количества
    const qtyInput = item.querySelector(".label-qty-input");
    qtyInput.addEventListener("click", e => e.stopPropagation());
    qtyInput.addEventListener("focus", e => e.stopPropagation());
    qtyInput.addEventListener("input", () => {
      if (labelSelection.has(key)) labelSelection.set(key, qtyInput.value);
    });
  });
  updateLabelCount();
}
```

`labelSelectAll`/`labelDeselectAll` (`app.js:6616-6638`) читают/пишут `labelSelection` только через `item.dataset.id` — уже нейтральны к формату ключа, менять не нужно.

- [ ] **Step 5: `addEmployeeAssetsToLabelSelection` — пишет `asset:`-ключи**

В `app.js:6666-6670` заменить:

```javascript
  let added = 0;
  employeeAssetIds.forEach((assetId) => {
    if (!labelSelection.has(assetId)) added += 1;
    labelSelection.set(assetId, labelSelection.get(assetId) || "1");
  });
```

на:

```javascript
  let added = 0;
  employeeAssetIds.forEach((assetId) => {
    const key = labelAssetKey(assetId);
    if (!labelSelection.has(key)) added += 1;
    labelSelection.set(key, labelSelection.get(key) || "1");
  });
```

- [ ] **Step 6: `updateLabelCount` — считает по `asset:`-ключу**

В `app.js:6677-6690` заменить:

```javascript
    const picked = [...targetIds].filter((assetId) => labelSelection.has(assetId)).length;
```

на:

```javascript
    const picked = [...targetIds].filter((assetId) => labelSelection.has(labelAssetKey(assetId))).length;
```

- [ ] **Step 7: `getSelectedLabelItems` — разбирает ключ по префиксу**

В `app.js:6692-6700` заменить:

```javascript
function getSelectedLabelItems() {
  const items = [];
  labelSelection.forEach((qtyValue, assetId) => {
    const asset = getAssetById(assetId);
    if (!asset) return;
    items.push({ asset, qty: Math.max(1, parseInt(qtyValue || 1)) });
  });
  return items;
}
```

на:

```javascript
function getSelectedLabelItems() {
  const items = [];
  labelSelection.forEach((qtyValue, key) => {
    const qty = Math.max(1, parseInt(qtyValue || 1));
    if (key.startsWith("asset:")) {
      const asset = getAssetById(key.slice(6));
      if (asset) items.push({ asset, qty });
    }
    // Ветка "workplace:" добавляется в Task 6 — до него такие ключи в
    // labelSelection просто не появляются (чекбокс ещё не существует).
  });
  return items;
}
```

- [ ] **Step 8: Проверить синтаксис**

Run: `node --check app.js`
Expected: без вывода.

- [ ] **Step 9: Ручная регрессия в браузере**

```bash
python -m http.server 8790 --bind 127.0.0.1 --directory /d/warehouse &
```

Открыть «Этикетки»: отметить вручную 2-3 позиции, выбрать сотрудника → «Выбрать всю технику», убедиться что счётчик и отметки работают как раньше; «Только выбранные» показывает ровно отмеченное; «Выбрать показанные»/«Снять показанные» работают; предпросмотр/печать/PDF/JPG/Word/Excel формируют этикетки/таблицу как раньше (сравнить с поведением до этого таска). Остановить сервер после проверки.

- [ ] **Step 10: Коммит**

```bash
git add app.js
git commit -m "$(cat <<'EOF'
refactor(labels): составные ключи asset:/workplace: в labelSelection

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CwXMrAnYENeMjBmBirZwgo
EOF
)"
```

---

### Task 6: Десктоп — режим «Один общий стикер на стол»

**Files:**
- Modify: `index.html:1171-1172` (чекбокс в `#labelsOverlay`)
- Modify: `app.js` (`renderLabelGrid`, новая `renderWorkplaceLabelCard`, `getSelectedLabelItems`, `buildLabelHtml`/`drawLabelOnCanvas` — дописать диспетчер, новые `buildWorkplaceLabelHtml`/`drawWorkplaceLabelOnCanvas`, `printLabels`/`markLabelsPrinted`, `exportLabelsExcel`, `bindEvents`)

**Interfaces:**
- Consumes: `labelAssetKey`/`labelWorkplaceKey` (Task 5), `getWorkplaceById`, `getWorkplaceAssets`, `getEmployeeById`, `qrHtml`/`qrModuleGrid`/`labelFontSizes`/`fitNameFont`/константы верстки (существующие).
- Produces: `buildWorkplaceLabelHtml(workplace, opts)`, `drawWorkplaceLabelOnCanvas(ctx, workplace, x0mm, y0mm, wMm, hMm, opts, S)`, `renderWorkplaceLabelCard(workplaceId)` — ничего из этого не нужно другим таскам плана.

- [ ] **Step 1: Чекбокс в разметке**

В `index.html` между `labelAddEmployeeAssetsBtn` (строка 1171) и `labelOnlySelectedCheck` (строка 1172) вставить:

```html
        <label id="labelWorkplaceStickerWrap" style="gap:6px" class="hidden"><input type="checkbox" id="labelWorkplaceStickerCheck" style="width:15px;height:15px;accent-color:var(--brand)"> Один общий стикер на стол</label>
```

- [ ] **Step 2: Обработчик изменения чекбокса**

В `app.js:5949` (рядом с `labelEmployeeSelect` change) добавить:

```javascript
  document.getElementById("labelWorkplaceStickerCheck")?.addEventListener("change", renderLabelGrid);
```

- [ ] **Step 3: `renderLabelGrid` — ветка режима стола**

В `app.js:6539-6543` заменить начало функции:

```javascript
function renderLabelGrid() {
  const grid = document.getElementById("labelGrid");
  if (!grid) return;
  const assets = getLabelAssets();
  if (!assets.length) {
```

на:

```javascript
function renderLabelGrid() {
  const grid = document.getElementById("labelGrid");
  if (!grid) return;
  const target = getLabelTarget();
  document.getElementById("labelWorkplaceStickerWrap")?.classList.toggle("hidden", target?.kind !== "wp");
  if (target?.kind === "wp" && document.getElementById("labelWorkplaceStickerCheck")?.checked) {
    renderWorkplaceLabelCard(target.id);
    return;
  }

  const assets = getLabelAssets();
  if (!assets.length) {
```

(Остальное тело функции — без изменений, `target` внутри уже не переобъявляется повторно: в оставшемся коде функции есть своя строка `const target = getLabelTarget();` внутри блока пустого состояния, `app.js:6546` — её удалить, переменная теперь берётся из начала функции.)

В `app.js:6546` (внутри блока `if (!assets.length) { ... }`) заменить:

```javascript
    const target = getLabelTarget();
    const onlySelected = document.getElementById("labelOnlySelectedCheck")?.checked || false;
```

на:

```javascript
    const onlySelected = document.getElementById("labelOnlySelectedCheck")?.checked || false;
```

- [ ] **Step 4: `renderWorkplaceLabelCard` — одна карточка вместо сетки**

В `app.js` сразу после конца `renderLabelGrid` (после закрывающей `}` функции, перед `// Сужено ли то, что сейчас показано...` / `labelGridIsFiltered`) добавить:

```javascript
// Режим «Один общий стикер на стол»: вместо построчного списка техники —
// одна карточка на сам стол. Счётчик техники — только подпись в
// интерфейсе (getWorkplaceAssets), на сам стикер список не идёт — в этом
// весь смысл QR (см. дизайн-спеку).
function renderWorkplaceLabelCard(workplaceId) {
  const grid = document.getElementById("labelGrid");
  const workplace = getWorkplaceById(workplaceId);
  if (!workplace) {
    grid.innerHTML = `<div class="empty-state">Рабочее место не найдено.</div>`;
    updateLabelCount();
    return;
  }
  const key = labelWorkplaceKey(workplaceId);
  const isSelected = labelSelection.has(key);
  const qty = labelSelection.get(key) || "1";
  const assetCount = getWorkplaceAssets(workplaceId).length;
  grid.innerHTML = `<div class="label-item${isSelected ? " selected" : ""}" data-id="${key}">
      <input type="checkbox" ${isSelected ? "checked" : ""}>
      <div class="label-item-info">
        <div class="label-item-name">${escapeHtml(workplace.name)}</div>
        <div class="label-item-meta">${escapeHtml(workplace.code || "")} · Техники: ${assetCount}</div>
      </div>
      <input type="number" class="label-qty-input" value="${qty}" min="1" max="99" title="Кол-во стикеров">
    </div>`;

  const item = grid.querySelector(".label-item");
  const toggle = () => {
    const cb = item.querySelector("input[type=checkbox]");
    item.classList.toggle("selected", cb.checked);
    if (cb.checked) labelSelection.set(key, item.querySelector(".label-qty-input").value);
    else labelSelection.delete(key);
    updateLabelCount();
  };
  item.addEventListener("click", (e) => {
    if (e.target.tagName === "INPUT") return;
    const cb = item.querySelector("input[type=checkbox]");
    cb.checked = !cb.checked;
    toggle();
  });
  item.querySelector("input[type=checkbox]").addEventListener("change", (e) => { e.stopPropagation(); toggle(); });
  const qtyInput = item.querySelector(".label-qty-input");
  qtyInput.addEventListener("click", e => e.stopPropagation());
  qtyInput.addEventListener("focus", e => e.stopPropagation());
  qtyInput.addEventListener("input", () => {
    if (labelSelection.has(key)) labelSelection.set(key, qtyInput.value);
  });
  updateLabelCount();
}
```

- [ ] **Step 5: `getSelectedLabelItems` — ветка `workplace:`**

В `app.js` (правка Task 5, Step 7) заменить комментарий-заглушку:

```javascript
    // Ветка "workplace:" добавляется в Task 6 — до него такие ключи в
    // labelSelection просто не появляются (чекбокс ещё не существует).
```

на:

```javascript
    if (key.startsWith("workplace:")) {
      const workplace = getWorkplaceById(key.slice(10));
      if (workplace) {
        items.push({
          asset: { id: key, name: workplace.name, __labelKind: "workplace", __workplace: workplace },
          qty,
        });
      }
    }
```

- [ ] **Step 6: Диспетчер в `buildLabelHtml`/`drawLabelOnCanvas`**

В `app.js:6832` заменить первую строку функции:

```javascript
function buildLabelHtml(asset, { showInv = true, showQr = true, showLoc = false, width, height }) {
```

на:

```javascript
function buildLabelHtml(asset, opts) {
  if (asset.__labelKind === 'workplace') return buildWorkplaceLabelHtml(asset.__workplace, opts);
  const { showInv = true, showQr = true, showLoc = false, width, height } = opts;
```

В `app.js:6897` заменить первую строку функции:

```javascript
function drawLabelOnCanvas(ctx, asset, x0mm, y0mm, wMm, hMm, opts, S) {
```

на:

```javascript
function drawLabelOnCanvas(ctx, asset, x0mm, y0mm, wMm, hMm, opts, S) {
  if (asset.__labelKind === 'workplace') {
    drawWorkplaceLabelOnCanvas(ctx, asset.__workplace, x0mm, y0mm, wMm, hMm, opts, S);
    return;
  }
```

- [ ] **Step 7: `buildWorkplaceLabelHtml` и `drawWorkplaceLabelOnCanvas`**

В `app.js` сразу после конца `drawLabelOnCanvas` (после его закрывающей `}`, перед `// Лист печати — A4 книжный...`) добавить:

```javascript
// Стикер стола: тот же макет "имя крупно + мелкие строки + QR снизу", что
// у buildLabelHtml, но поля другие — отдел/объект/сотрудник вместо
// категории/S-N/владельца, код стола вместо инв./серийного номера. Список
// техники стола на стикер не идёт — в этом весь смысл QR (WHW1:<id>), см.
// дизайн-спеку. Зеркало: drawWorkplaceLabelOnCanvas ниже — держать в
// синхроне вручную, как buildLabelHtml/drawLabelOnCanvas.
function buildWorkplaceLabelHtml(workplace, { showQr = true, width, height }) {
  const f = labelFontSizes(height);
  const pad = LABEL_PAD_MM;
  const contentW = Math.max(1, width - pad * 2);
  const qrData = workplace.id ? `WHW1:${workplace.id}` : '';
  const occupant = workplace.employeeId ? (getEmployeeById(workplace.employeeId)?.fullName || '') : '';

  const deptLine = workplace.department
    ? `<div style="font-size:${f.small}pt;color:#666;line-height:${SMALL_LINE_H};margin-top:0.5pt;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(workplace.department)}</div>` : '';
  const siteLine = workplace.site
    ? `<div style="font-size:${f.small}pt;color:#2563eb;line-height:${SMALL_LINE_H};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(workplace.site)}</div>` : '';
  const empLine = occupant
    ? `<div style="font-size:${f.small}pt;color:#000;font-weight:600;line-height:${SMALL_LINE_H};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(occupant)}</div>` : '';
  const codeLine = (workplace.code && !showQr)
    ? `<div style="font-size:${f.small}pt;color:#555;line-height:${SMALL_LINE_H}">${escapeHtml(workplace.code)}</div>` : '';

  let bottom = '';
  let bcBlockMm = 0;
  if (showQr) {
    const stripH = Math.max(6, height * 0.34);
    const qrSize = Math.min(stripH, contentW * 0.4);
    bcBlockMm = qrSize + (5 + f.code * 1.2 + 1.5) * (25.4 / 72);
    bottom = `<div style="border-top:0.4pt solid #ccc;margin-top:2pt;padding-top:2pt;text-align:center">
        ${qrHtml(qrData, qrSize)}
        <div style="font-size:${f.code}pt;text-align:center;color:#000;margin-top:1.5pt;letter-spacing:0.3px">${escapeHtml(workplace.code || '')}</div>
      </div>`;
  }

  const smallLineMm = f.small * SMALL_LINE_H * (25.4 / 72);
  const smallLinesCount = (deptLine ? 1 : 0) + (siteLine ? 1 : 0) + (empLine ? 1 : 0) + (codeLine ? 1 : 0);
  const availNameMm = Math.max(smallLineMm, height - pad * 2 - bcBlockMm - smallLinesCount * smallLineMm - 0.5);
  const fit = fitNameFont(workplace.name || '', contentW * MM2PX, availNameMm * MM2PX, f.name, 4);

  return `<div style="
    width:${width}mm; height:${height}mm;
    border:0.5pt solid #d0d0d0;
    padding:${pad}mm; display:flex; flex-direction:column;
    overflow:hidden; background:#fff; font-family:Arial,Helvetica,sans-serif;
    box-sizing:border-box; page-break-inside:avoid;
  ">
    <div style="flex:1 1 auto;min-width:0;overflow:hidden">
      <div style="font-size:${fit.pt}pt;font-weight:700;line-height:${NAME_LINE_H};color:#000;word-break:break-word;overflow-wrap:anywhere">${escapeHtml(workplace.name)}</div>
      ${deptLine}
      ${siteLine}
      ${empLine}
      ${codeLine}
    </div>
    ${bottom}
  </div>`;
}

function drawWorkplaceLabelOnCanvas(ctx, workplace, x0mm, y0mm, wMm, hMm, opts, S) {
  const { showQr = true } = opts || {};
  const f = labelFontSizes(hMm);
  const PADmm = LABEL_PAD_MM;
  const ptToPx = (pt) => pt * 25.4 / 72 * S;
  const x = x0mm * S, y = y0mm * S, w = wMm * S, h = hMm * S, pad = PADmm * S;
  const contentWmm = wMm - PADmm * 2;
  const cw = contentWmm * S;

  ctx.fillStyle = '#fff';
  ctx.fillRect(x, y, w, h);
  ctx.lineWidth = Math.max(1, 0.5 * S * 0.3528);
  ctx.strokeStyle = '#d0d0d0';
  ctx.strokeRect(x, y, w, h);

  const qrData = workplace.id ? `WHW1:${workplace.id}` : '';
  const occupant = workplace.employeeId ? (getEmployeeById(workplace.employeeId)?.fullName || '') : '';
  const hasDept = !!workplace.department;
  const hasSite = !!workplace.site;
  const hasEmp = !!occupant;
  const hasCode = !!(workplace.code && !showQr);

  const codePx = ptToPx(f.code);
  const stripHmm = Math.max(6, hMm * 0.34);
  const qrSizeMm = Math.min(stripHmm, contentWmm * 0.4);
  const bcBlockMm = showQr ? qrSizeMm + (5 + f.code * 1.2 + 1.5) * (25.4 / 72) : 0;
  const slh = ptToPx(f.small) * SMALL_LINE_H;
  const smallMm = f.small * SMALL_LINE_H * (25.4 / 72);
  const smallCount = (hasDept ? 1 : 0) + (hasSite ? 1 : 0) + (hasEmp ? 1 : 0) + (hasCode ? 1 : 0);
  const availNameMm = Math.max(smallMm, hMm - PADmm * 2 - bcBlockMm - smallCount * smallMm - 0.5);

  let nPt = f.name, nameLines = [''];
  for (; nPt >= 4; nPt -= 0.25) {
    const fpx = ptToPx(nPt);
    const lines = wrapTextLines(workplace.name || '', cw, makeTextMeasurer(fpx, true));
    nameLines = lines;
    if (lines.length * fpx * NAME_LINE_H <= availNameMm * S) break;
  }
  const nFpx = ptToPx(nPt);

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  let ty = y + pad;
  ctx.fillStyle = '#000';
  ctx.font = `700 ${nFpx}px Arial, Helvetica, sans-serif`;
  for (const line of nameLines) { ctx.fillText(line, x + pad, ty); ty += nFpx * NAME_LINE_H; }

  ctx.font = `${ptToPx(f.small)}px Arial, Helvetica, sans-serif`;
  const small = (txt, color) => {
    ctx.fillStyle = color;
    ctx.fillText(clipToWidth(txt, cw, (s) => ctx.measureText(s).width), x + pad, ty);
    ty += slh;
  };
  if (hasDept) small(workplace.department, '#666');
  if (hasSite) small(workplace.site, '#2563eb');
  if (hasEmp) {
    ctx.font = `700 ${ptToPx(f.small)}px Arial, Helvetica, sans-serif`;
    small(occupant, '#000');
    ctx.font = `${ptToPx(f.small)}px Arial, Helvetica, sans-serif`;
  }
  if (hasCode) small(workplace.code, '#555');

  if (showQr) {
    const codeTop = y + h - pad - codePx;
    const qrBottom = codeTop - 0.5 * S;
    const qrPx = qrSizeMm * S;
    const qrTop = qrBottom - qrPx;
    const sepY = qrTop - 1.5 * S;
    ctx.strokeStyle = '#ccc'; ctx.lineWidth = Math.max(1, 0.4 * S * 0.3528);
    ctx.beginPath(); ctx.moveTo(x + pad, sepY); ctx.lineTo(x + w - pad, sepY); ctx.stroke();

    const { n, modules } = qrModuleGrid(qrData);
    const cellPx = qrPx / n;
    const qrLeft = x + pad + (cw - qrPx) / 2;
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (modules[r][c]) ctx.fillRect(qrLeft + c * cellPx, qrTop + r * cellPx, cellPx, cellPx);
      }
    }

    ctx.fillStyle = '#000';
    ctx.font = `${codePx}px Arial, Helvetica, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(String(workplace.code || ''), x + w / 2, codeTop);
    ctx.textAlign = 'left';
  }
}
```

- [ ] **Step 8: `markLabelsPrinted` пропускает позиции-столы**

В `app.js:7164` заменить:

```javascript
  markLabelsPrinted([...new Set(labels.map((a) => a.id))]);
```

на:

```javascript
  markLabelsPrinted([...new Set(labels.filter((a) => a.__labelKind !== "workplace").map((a) => a.id))]);
```

- [ ] **Step 9: `exportLabelsExcel` не включает столы**

В `app.js:7181-7183` заменить:

```javascript
function exportLabelsExcel() {
  const items = getSelectedLabelItems();
  if (!items.length) { showToast('Выберите хотя бы одну позицию.', 'warning'); return; }
```

на:

```javascript
function exportLabelsExcel() {
  const items = getSelectedLabelItems().filter(({ asset }) => asset.__labelKind !== "workplace");
  if (!items.length) { showToast('Выберите хотя бы одну позицию техники (стикеры столов в Excel не выводятся).', 'warning'); return; }
```

- [ ] **Step 10: Проверить синтаксис**

Run: `node --check app.js`
Expected: без вывода.

- [ ] **Step 11: Ручная проверка в браузере**

```bash
python -m http.server 8790 --bind 127.0.0.1 --directory /d/warehouse &
```

Сценарий (нужен стол с техникой и сотрудником):
1. Открыть «Этикетки», найти и выбрать стол в поле «Сотрудник или стол» — появляется чекбокс «Один общий стикер на стол» (для сотрудника — не появляется).
2. Включить его — сетка показывает одну карточку стола со счётчиком техники.
3. Отметить карточку, задать количество копий 2 → «Выбрано всего: 2».
4. Предпросмотр: один стикер стола, увеличенный вдвое по числу копий — имя, код, отдел, объект/локация, ФИО сотрудника, QR с кодом под ним. Список техники на стикере отсутствует.
5. Печать, PDF, JPG, Word — каждый выдаёт тот же стикер (минимум два разных экспорта проверить визуально).
6. Excel — стикер стола не попадает в таблицу; если он выбран один — тост «выберите хотя бы одну позицию техники...», не пустой файл.
7. Выключить чекбокс, переключиться обратно на отдельные активы того же стола — обычная построчная сетка техники работает как раньше; выбор стола (карточка) остаётся в общем счётчике, пока не нажата «Очистить выбор».
8. Переключиться на другой стол, не выключая чекбокс — сразу видна его карточка (переключатель не сбрасывается между столами).

Остановить сервер после проверки.

- [ ] **Step 12: Коммит**

```bash
git add index.html app.js
git commit -m "$(cat <<'EOF'
feat(labels): один общий QR-стикер на рабочее место

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CwXMrAnYENeMjBmBirZwgo
EOF
)"
```

---

### Task 7: Сквозной сценарий и пересборка EXE + APK

**Files:** нет изменений кода.

- [ ] **Step 1: Полный прогон тестов**

Run: `node --test mobile/tests/*.test.js tests/*.test.js`
Expected: PASS, все тесты зелёные (существующие + новые из Task 1).

- [ ] **Step 2: Резервная копия базы**

```bash
cp "C:/ProgramData/Warehouse/warehouse.db" "$SCRATCH/before_workplace_label_qr_$(date +%Y%m%d_%H%M%S).db"
```

- [ ] **Step 3: Остановить приложение**

```bash
powershell -NoProfile -Command "Get-Process -Name 'WarehouseApp' -ErrorAction SilentlyContinue | Stop-Process -Force"
```

- [ ] **Step 4: Пересобрать десктоп**

```bash
rm -rf build dist && python -m PyInstaller WarehouseApp_New.spec --clean --noconfirm
```

- [ ] **Step 5: Заменить EXE с сохранением копии**

```bash
TS=$(date +%Y%m%d_%H%M%S) && cp WarehouseApp.exe "WarehouseApp_OLD_${TS}.exe" && cp dist/WarehouseApp_New.exe WarehouseApp.exe
```

- [ ] **Step 6: Запустить и сверить раздаваемые файлы**

Запустить `WarehouseApp.exe`, дождаться порта 8765.

```bash
for f in index.html app.js asset_ops.js; do diff <(curl -s http://127.0.0.1:8765/$f) $f > /dev/null && echo "$f совпадает" || echo "$f ОТЛИЧАЕТСЯ"; done
```

Expected: все совпадают.

- [ ] **Step 7: Собрать APK (release, если есть keystore, иначе debug)**

```bash
cd mobile && npx cap sync android && cd android && gradlew.bat assembleDebug
```

- [ ] **Step 8: Сквозной сценарий на боевых данных**

На запущенном `WarehouseApp.exe` и установленном APK, со столом, у которого есть техника и сотрудник:

1. Десктоп: «Этикетки» → выбрать стол → «Один общий стикер на стол» → отметить → напечатать (или PDF/JPG) физический/файловый стикер с QR.
2. Телефон: приложение синхронизировано (иконка соединения активна) → «Скан» → навести на стикер стола → открывается экран рабочего места: имя, код, отдел, объект/локация, ФИО сотрудника, полный список техники с категорией/S-N/инв. номером/статусом/количеством.
3. Десктоп: пересадить сотрудника этого стола на другой (через существующую форму рабочих мест) или снять со стола.
4. Телефон: подождать до ~20 секунд (фоновая синхронизация) либо потянуть список для принудительного `Sync.run()`, затем повторно отсканировать тот же стикер — экран показывает нового сотрудника (или «Свободно»), без перепечатки стикера.
5. Регрессия: печать отдельной этикетки на актив (кнопка на карточке техники, штучный выбор в «Этикетки») работает как раньше; скан QR актива (`WH1:`) на телефоне по-прежнему открывает карточку актива.

- [ ] **Step 9: Финальный коммит (если в шагах 1-8 что-то потребовало правок)**

```bash
git add -A
git status
```

Закоммитировать только если ручная проверка выявила и потребовала правок кода — в этом случае вернуться к соответствующему таску, исправить, повторить его пункты «проверить синтаксис»/«тесты», и закоммитировать с сообщением по месту правки. Если всё сошлось без правок — этот шаг ничего не коммитит.
