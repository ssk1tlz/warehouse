# Выдача и операции (часть 1 из 3) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Починить видимость выдач в «Операциях» (§3 ТЗ) и добавить комментарий к выдаче из блока «Выдать сразу» (§4 ТЗ).

**Architecture:** Диагноз подтверждён на боевых данных: операции выдачи создаются исправно, но 15 записей с неизвестной датой проваливаются в конец журнала, потому что `dateSortKey` считает пустую дату «самой старой», а блок «Выдать сразу» по умолчанию оставляет дату пустой (осознанное решение — техника часто заводится задним числом). Правка не трогает семантику «неизвестно» нигде, кроме упорядочивания: новая чистая функция `movementSortValue` в `asset_ops.js` для записей без даты берёт момент создания записи из её `id` (`mov_<timestamp>_<rand>`) вместо `-Infinity`, и её используют обе точки, где пользователь видит «появилась ли операция» — таблица «Операции» и виджет «Последние операции» на дашборде. Второе изменение — независимое: у блока «Выдать сразу» нет поля комментария вовсе (в отличие от окна «Выдать» по кнопке на складе, где оно уже есть и работает), это отдельный текстовый инпут плюс проводка значения через `readAssetIssueRequest` → `issueAssetOnCreate` → `addMovement`.

**Known gap, not fixed in this part:** the mobile client (`mobile/www/js/db.js`, `mobile/www/js/screens.js`) independently re-derives movement order from the server's `ORDER BY date DESC, id DESC` (`server.py:584`) and has the same root-cause symptom — an unknown-date movement can be dropped from its per-asset cache entirely (`db.js` keeps only the first 3 per asset in server order) and never appear in the home screen's "Последние" list. This part fixes only the two desktop surfaces above. The cheapest real fix is at the source: order `server.py`'s query by an id-derived creation time when `date` is empty, so every client (desktop, mobile, and any future one) inherits one ordering rule instead of each reimplementing it in its own SQL. Tracked here for a follow-up, not silently out of scope.

**Tech Stack:** Python 3.12 + sqlite3 (сервер — в этой части не меняется), браузерный JS без сборки (`app.js`, `asset_ops.js`), тесты JS на `node:test`.

**Spec:** `Промт на доработку системы учета техники.md` (§3 «Выдача техники со склада», §4 «Комментарий при выдаче»); диагноз причины и решение по ней зафиксированы в этом плане (Architecture выше).

## Global Constraints

- Комментарии и текст интерфейса — на русском, как во всём проекте.
- Не менять семантику «дата неизвестна» (галочка, `formatDate`, `dateSortKey`) нигде за пределами упорядочивания движений — она используется для дат покупки и других списков и должна остаться как есть.
- Логика без DOM выносится в `asset_ops.js` и тестируется через `node --test`; DOM-код проверяется вручную в браузере (`node --check app.js` для синтаксиса).
- Python-тесты: `python -m pytest -q`. JS-тесты: `node --test mobile/tests/*.test.js tests/*.test.js`.
- Файл `_tmp_state.json` в корне репозитория — временный для браузерной проверки, **никогда не коммитить**.

---

### Task 1: `movementSortValue` в asset_ops.js

**Files:**
- Modify: `asset_ops.js` (новая функция, добавить в экспорт `AssetOps`)
- Test: `tests/asset_ops.test.js` (дописать блок в конец)

**Interfaces:**
- Consumes: ничего из других задач (чистая функция).
- Produces: `AssetOps.movementSortValue(movement)` → число для сортировки «новые сверху» (`sort((a, b) => movementSortValue(b) - movementSortValue(a))`). Для движения с валидной `date` — её timestamp. Для движения с пустой `date` — timestamp, зашитый в `movement.id` вида `mov_<timestamp>_<rand>`. Если и это не распознать — `-Infinity` (старое поведение как последний рубеж).

- [ ] **Step 1: Написать падающие тесты**

Дописать в конец `tests/asset_ops.test.js`:

```javascript

// ─── сортировка движений по свежести ─────────────────────────────

const { movementSortValue } = require('../asset_ops.js');

test('движение с датой сортируется по этой дате', () => {
  const value = movementSortValue({ id: 'mov_1_abc', date: '2026-08-15' });
  assert.equal(value, new Date('2026-08-15').getTime());
});

test('движение без даты сортируется по моменту создания из id', () => {
  const value = movementSortValue({ id: 'mov_1757321893821_a1b2c3', date: '' });
  assert.equal(value, 1757321893821);
});

test('движение без даты и без разбираемого id уходит в конец', () => {
  const value = movementSortValue({ id: 'не-по-шаблону', date: '' });
  assert.equal(value, -Infinity);
});

test('движение вовсе без id и без даты уходит в конец', () => {
  const value = movementSortValue({ date: null });
  assert.equal(value, -Infinity);
});

test('свежая выдача без даты сортируется выше старой выдачи с датой', () => {
  // Ровно сценарий бага: «Выдать сразу» только что создало запись без
  // даты — она не должна проваливаться ниже выдачи месячной давности.
  const freshUnknownDate = { id: `mov_${Date.now()}_a1b2c3`, date: '' };
  const oldDated = { id: 'mov_1_xyz', date: '2020-01-01' };
  const sorted = [oldDated, freshUnknownDate].sort((a, b) => movementSortValue(b) - movementSortValue(a));
  assert.deepEqual(sorted, [freshUnknownDate, oldDated]);
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

Run: `node --test tests/asset_ops.test.js`
Expected: FAIL — `TypeError: movementSortValue is not a function` (5 новых тестов падают, существующие проходят).

- [ ] **Step 3: Реализовать функцию**

В `asset_ops.js` добавить перед строкой `const AssetOps = { mergeAllocation, searchAssets };`:

```javascript
// Ключ сортировки движений по свежести для списков «новые сверху». У
// выдачи «Выдать сразу» (app.js, resetAssetIssueBlock) дата по умолчанию
// неизвестна — технику часто заводят задним числом. Если в этом случае
// считать её самой старой (как делает formatDate/dateSortKey в app.js
// для дат покупки), свежая выдача проваливается в конец журнала и
// выглядит как «операция не создалась», хотя она есть. Вместо этого для
// записей без даты берём момент создания, зашитый в id вида
// `mov_<timestamp>_<rand>` (см. createId в app.js).
function movementSortValue(movement) {
  const dateTime = movement.date ? new Date(movement.date).getTime() : NaN;
  if (!Number.isNaN(dateTime)) return dateTime;
  const createdAt = Number((String(movement.id || '').match(/^mov_(\d+)_/) || [])[1]);
  return Number.isFinite(createdAt) ? createdAt : -Infinity;
}
```

Заменить строку экспорта на:

```javascript
const AssetOps = { mergeAllocation, searchAssets, movementSortValue };
```

- [ ] **Step 4: Запустить тесты и убедиться, что проходят**

Run: `node --test tests/asset_ops.test.js`
Expected: PASS, все тесты файла зелёные.

- [ ] **Step 5: Коммит**

```bash
git add asset_ops.js tests/asset_ops.test.js
git commit -m "$(cat <<'EOF'
feat(operations): ключ сортировки движений без потери свежих выдач без даты

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K41oDt8DfuD3EsDsLLJz5s
EOF
)"
```

---

### Task 2: Журнал и дашборд используют `movementSortValue`

**Files:**
- Modify: `app.js:2555-2556` (`renderMovementTable`), `app.js:1076-1077` (`renderRecentMovements`)

**Interfaces:**
- Consumes: `AssetOps.movementSortValue` из Task 1 (уже загружен в браузере — `asset_ops.js` подключается в `index.html` до `app.js`, `AssetOps.mergeAllocation` из него уже используется в `app.js`).
- Produces: обе точки, где пользователь видит «появилась ли выдача» — полная таблица «Операции» и виджет «Последние операции» на дашборде (top-6) — упорядочены по свежести, включая записи с неизвестной датой.

Экспорты `exportMovementsCsv` (`app.js:1626`) и Excel-выгрузку (`app.js:4193`), а также `resolveActNumber` (`app.js:3090`, порядок номеров актов для старых движений без `actNumber`) эта задача не трогает: жалоба и диагноз — про экранную видимость операции, а не про выгрузки или нумерацию актов, и лишняя правка там не по спеке.

- [ ] **Step 1: Заменить сортировку в таблице «Операции»**

В `renderMovementTable` (`app.js:2555-2556`) заменить:

```javascript
  const rows = [...state.movements]
    .sort((a, b) => dateSortKey(b.date) - dateSortKey(a.date))
```

на:

```javascript
  const rows = [...state.movements]
    .sort((a, b) => AssetOps.movementSortValue(b) - AssetOps.movementSortValue(a))
```

- [ ] **Step 2: Заменить сортировку в виджете «Последние операции»**

В `renderRecentMovements` (`app.js:1076-1077`) заменить:

```javascript
  const recent = [...state.movements]
    .sort((a, b) => dateSortKey(b.date) - dateSortKey(a.date))
```

на:

```javascript
  const recent = [...state.movements]
    .sort((a, b) => AssetOps.movementSortValue(b) - AssetOps.movementSortValue(a))
```

Это важно отдельно от Step 1: виджет обрезает список до 6 записей (`.slice(0, 6)`) — со старой сортировкой свежая выдача без даты не просто уходила вниз, а вовсе не попадала в «последние», даже если это была последняя операция в системе.

- [ ] **Step 3: Проверить синтаксис**

Run: `node --check app.js`
Expected: без вывода.

- [ ] **Step 4: Проверить в браузере**

```bash
python -m http.server 8790 --bind 127.0.0.1 --directory /d/warehouse &
```

Открыть страницу, в консоли выполнить сценарий: создать технику с «Выдать сразу» (дата не заполняется — оставить «Неизвестно»), сохранить. Убедиться, что:
- на дашборде в «Последних операциях» новая выдача видна сразу (не только после ручного обновления);
- на экране «Операции» она в верхней части журнала, а не в конце.

Остановить сервер после проверки.

- [ ] **Step 5: Коммит**

```bash
git add app.js
git commit -m "$(cat <<'EOF'
fix(operations): свежая выдача без даты не тонет в конце журнала и дашборда

15 выдач с пустой датой («Выдать сразу» ставит её по умолчанию) сортировались
как самые старые записи и проваливались в конец «Операций», а в виджете
дашборда (top-6) не показывались вовсе — отсюда жалоба «выдача не появляется».

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K41oDt8DfuD3EsDsLLJz5s
EOF
)"
```

---

### Task 3: Комментарий в блоке «Выдать сразу»

**Files:**
- Modify: `index.html:394-395` (разметка внутри `#assetIssueFields`)
- Modify: `app.js:894-914` (`resetAssetIssueBlock`), `app.js:921-959` (`readAssetIssueRequest`), `app.js:963-990` (`issueAssetOnCreate`)

**Interfaces:**
- Consumes: ничего из Task 1–2.
- Produces: `readAssetIssueRequest()` возвращает объект с дополнительным полем `notes` (строка, может быть пустой). `issueAssetOnCreate` пишет его в движение вместо жёстко зашитого текста.

У окна «Выдать» по кнопке на карточке техники (`#issueModal`) комментарий уже есть и уже сохраняется (`handleIssueSubmit`, `app.js:3771`, читает `formData.get("notes")`) — это задача только про блок «Выдать сразу» на форме добавления техники, где поля нет вовсе, а движение получает фиксированный текст `"Выдано при добавлении техники"`.

- [ ] **Step 1: Добавить поле в разметку**

В `index.html` внутри `#assetIssueFields`, после закрывающего `</div>` строки формы (`form-row form-row-3`, заканчивается на строке 394) и перед закрывающим `</div>` блока `#assetIssueFields` (строка 395), вставить:

```html
                <div class="form-row">
                  <label class="form-field notes-field">
                    <span class="form-label">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.5 4A1.5 1.5 0 014 2.5h8A1.5 1.5 0 0113.5 4v5A1.5 1.5 0 0112 10.5H6.5L3.5 13V10.5A1.5 1.5 0 012.5 9V4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
                      Комментарий
                    </span>
                    <textarea id="assetIssueNotes" rows="2" placeholder="Например: выдано под проект…"></textarea>
                  </label>
                </div>
```

Без `name` — как и у соседних `assetIssueQuantity`/`assetIssueDate`: это поля отдельного, необязательного действия «выдать при добавлении», а не самой карточки техники, и `name` затянул бы их в `FormData` формы добавления техники (`handleAssetSubmit`), которая их не ждёт.

- [ ] **Step 2: Прочитать поле в `readAssetIssueRequest`**

В `app.js` в возвращаемом объекте `readAssetIssueRequest` (строки 949-958) добавить после `workplaceId,`:

```javascript
    notes: String(document.getElementById("assetIssueNotes")?.value || "").trim(),
```

- [ ] **Step 3: Передать в движение**

В `issueAssetOnCreate` (`app.js:963-990`) заменить в вызове `addMovement`:

```javascript
    notes: "Выдано при добавлении техники",
```

на:

```javascript
    // Пустой комментарий — не ошибка: полю необязательное, тогда в
    // истории остаётся тот же осмысленный текст, что был до этого поля.
    notes: request.notes || "Выдано при добавлении техники",
```

- [ ] **Step 4: Проверить синтаксис**

Run: `node --check app.js`
Expected: без вывода.

- [ ] **Step 5: Проверить в браузере**

```bash
python -m http.server 8790 --bind 127.0.0.1 --directory /d/warehouse &
```

Сценарий: добавить технику, включить «Выдать сразу», вписать комментарий («выдано под проект N»), сохранить. Открыть «Операции» — убедиться, что комментарий виден в строке журнала. Повторить без комментария — убедиться, что в журнале остаётся «Выдано при добавлении техники».

Остановить сервер после проверки.

- [ ] **Step 6: Полный прогон тестов и коммит**

```bash
python -m pytest -q && node --test mobile/tests/*.test.js tests/*.test.js
git add index.html app.js
git commit -m "$(cat <<'EOF'
feat(operations): комментарий в блоке «Выдать сразу»

У окна «Выдать» по кнопке на складе комментарий уже был; у выдачи прямо
при добавлении техники — нет. Добавляет поле и проводит его в движение.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K41oDt8DfuD3EsDsLLJz5s
EOF
)"
```

---

### Task 4: Сквозной сценарий и пересборка

**Files:** нет изменений кода.

- [ ] **Step 1: Сквозной сценарий по критериям готовности (§9 ТЗ, пункты про выдачу и операции)**

На поднятой статике (см. Task 3, Step 5) пройти целиком:
1. Открыть склад, добавить технику.
2. Включить «Выдать сразу», выбрать сотрудника, оставить дату «Неизвестно», вписать комментарий, выдать.
3. Убедиться: техника получила статус выдана, закреплена за сотрудником (карточка сотрудника).
4. Открыть «Операции» — новая выдача видна в верхней части списка, с комментарием.
5. Проверить дашборд — выдача видна в «Последних операциях».

Note for the real production data check (Task 4 Step 6 below): the 15 historical unknown-date issuances will now show as "Неизвестно (запись от 07.09.2026)" (per the movementDateLabel fix) occupying the top of the journal and the dashboard's "Последние операции" widget, ahead of same-day dated operations. This is the fix working as intended, not a new bug — confirm the annotation reads clearly before treating the screen as correct.

- [ ] **Step 2: Резервная копия базы**

```bash
cp "C:/ProgramData/Warehouse/warehouse.db" "$SCRATCH/before_operations_journal_$(date +%Y%m%d_%H%M%S).db"
```

- [ ] **Step 3: Остановить приложение**

```bash
powershell -NoProfile -Command "Get-Process -Name 'WarehouseApp' -ErrorAction SilentlyContinue | Stop-Process -Force"
```

- [ ] **Step 4: Пересобрать**

```bash
rm -rf build dist && python -m PyInstaller WarehouseApp_New.spec --clean --noconfirm
```

- [ ] **Step 5: Заменить с сохранением копии**

```bash
TS=$(date +%Y%m%d_%H%M%S) && cp WarehouseApp.exe "WarehouseApp_OLD_${TS}.exe" && cp dist/WarehouseApp_New.exe WarehouseApp.exe
```

- [ ] **Step 6: Запустить и проверить на боевых данных**

Запустить `WarehouseApp.exe`, дождаться порта 8765. Открыть «Операции» — убедиться, что ранее «потерянные» 15 выдач с пустой датой теперь видны в верхней части журнала, а не в конце.

```bash
for f in index.html app.js asset_ops.js; do diff <(curl -s http://127.0.0.1:8765/$f) $f > /dev/null && echo "$f совпадает" || echo "$f ОТЛИЧАЕТСЯ"; done
```

Expected: все совпадают.
