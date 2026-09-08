# Реестр сотрудников (часть 3 из 3) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Предупреждать о похожих сотрудниках при добавлении нового, без запрета сохранить (§1 ТЗ), и показывать на карточке сотрудника дату выдачи/статус/операцию/комментарий для каждой единицы закреплённой техники (§2 ТЗ).

**Architecture:** Большая часть §1 и §2 уже реализована существующим кодом и не требует правок: выбор сотрудника в формах операций — закрытые `<select>`, дубль в них появиться не может по конструкции; существующая запись сотрудника используется во всех операциях через `employeeId`; просмотр закреплённой техники на карточке сотрудника уже есть (`openEmployeeDetailsModal`, через `getEmployeeHoldings`); закрытие связи при возврате/передаче уже происходит через существующие потоки возврата/выдачи (движение «Возврат» плюс новое «Выдача» — история не теряется). Два реальных пробела: (1) при создании сотрудника форма (`#employeeForm`) не проверяет, нет ли уже похожего ФИО в базе — эту часть плана закрывает; (2) карточка сотрудника показывает список техники только как «инв.№ / название / кол-во», без даты выдачи, статуса, операции и комментария, которые ТЗ явно требует по каждой позиции — эти данные уже есть в `state.movements` (после части 1 — с корректным порядком по свежести), просто не подтягиваются в карточку.

**Известный, не устранённый здесь пробел:** `deleteEmployee`/`bulkDeleteEmployees` (app.js) при удалении сотрудника вычищают из `state.movements` вообще все движения, где он упомянут — не только его текущие закрепления, а всю историю операций, включая уже закрытые возвраты, по технике, которая остаётся в системе. Это противоречит §2/§8 («история операции сохраняется»). Пробел существует независимо от этой части и требует отдельного рассмотрения — изменение логики удаления не бантик к ревью-фиксам, это отдельная тема.

Похожесть ФИО — чистая функция `AssetOps.findSimilarEmployees` в `asset_ops.js`: нормализует регистр/пробелы/«ё-е» (тот же приём, что `searchAssets`), считает точное совпадение после нормализации похожим всегда, а неполное совпадение (одно ФИО — подмножество слов другого, напр. без отчества) — похожим, если самого короткого ФИО не меньше двух слов. Это защита именно от «различий в написании» (опечатки регистра/пробелов/ё), а не полнотекстовый fuzzy-поиск с допуском на опечатки в буквах — так проще, предсказуемее и без ложных срабатываний на просто однофамильцах.

**Tech Stack:** Браузерный JS без сборки (`app.js`, `asset_ops.js`, `index.html`, `styles.css`), тесты JS на `node:test`.

**Spec:** `Промт на доработку системы учета техники.md` (§1 «Реестр сотрудников», §2 «Связь сотрудника и техники»). Политика по дублям ФИО — предупреждать и показывать похожих, не запрещать — зафиксирована пользователем в этой же сессии.

## Global Constraints

- Комментарии и текст интерфейса — на русском, как во всём проекте.
- Предупреждение о похожих сотрудниках НИКОГДА не блокирует сохранение — только показывает похожих и даёт выбрать существующую запись вместо создания новой.
- Логика без DOM выносится в `asset_ops.js` и тестируется через `node --test`; DOM-код (`app.js`, `index.html`, `styles.css`) проверяется вручную (`node --check app.js` для синтаксиса, ручная проверка в браузере).
- Не дублировать уже существующую логику: `getEmployeeHoldings`, `getEmployeeAllocation`, `AssetOps.movementSortValue` — переиспользуются, не переписываются заново.
- Python-тесты: `python -m pytest -q`. JS-тесты: `node --test mobile/tests/*.test.js tests/*.test.js`.
- Файл `_tmp_state.json` в корне репозитория — временный для браузерной проверки, **никогда не коммитить**.

---

### Task 1: `AssetOps.findSimilarEmployees` в asset_ops.js

**Files:**
- Modify: `asset_ops.js` (две новые функции, добавить в экспорт `AssetOps`)
- Test: `tests/asset_ops.test.js` (дописать блок в конец)

**Interfaces:**
- Consumes: ничего из других задач (чистые функции).
- Produces: `AssetOps.normalizeFullName(fullName)` → строка (нижний регистр, схлопнутые пробелы, «ё»→«е»). `AssetOps.findSimilarEmployees(employees, fullName, excludeId = '')` → массив сотрудников из `employees`, чьё ФИО похоже на `fullName` (без `excludeId`, если задан).

- [ ] **Step 1: Написать падающие тесты**

Дописать в конец `tests/asset_ops.test.js`:

```javascript

// ─── похожие сотрудники (защита от дублей ФИО) ────────────────────

const { normalizeFullName, findSimilarEmployees } = require('../asset_ops.js');

test('normalizeFullName схлопывает регистр, пробелы и ё/е', () => {
  assert.equal(normalizeFullName('  Ивлёв   Пётр  Ильич '), 'ивлев петр ильич');
});

test('findSimilarEmployees находит точное совпадение после нормализации', () => {
  const employees = [{ id: 'emp_1', fullName: 'Иванов Иван Иванович' }];
  const similar = findSimilarEmployees(employees, 'иванов   иван иванович');
  assert.deepEqual(similar.map((e) => e.id), ['emp_1']);
});

test('findSimilarEmployees находит ФИО без отчества как похожее на полное', () => {
  const employees = [{ id: 'emp_1', fullName: 'Иванов Иван Иванович' }];
  const similar = findSimilarEmployees(employees, 'Иванов Иван');
  assert.deepEqual(similar.map((e) => e.id), ['emp_1']);
});

test('findSimilarEmployees не считает похожими просто однофамильцев', () => {
  // Одно общее слово из двух — недостаточно: это разные люди, а не
  // разное написание одного и того же.
  const employees = [{ id: 'emp_1', fullName: 'Иванов Пётр Петрович' }];
  const similar = findSimilarEmployees(employees, 'Иванов Иван Иванович');
  assert.deepEqual(similar, []);
});

test('findSimilarEmployees исключает excludeId (для режима редактирования)', () => {
  const employees = [{ id: 'emp_1', fullName: 'Иванов Иван Иванович' }];
  const similar = findSimilarEmployees(employees, 'Иванов Иван Иванович', 'emp_1');
  assert.deepEqual(similar, []);
});

test('findSimilarEmployees возвращает пустой список для пустого ФИО', () => {
  const employees = [{ id: 'emp_1', fullName: 'Иванов Иван Иванович' }];
  assert.deepEqual(findSimilarEmployees(employees, ''), []);
  assert.deepEqual(findSimilarEmployees(employees, '   '), []);
});

test('findSimilarEmployees пропускает сотрудников с пустым ФИО в базе', () => {
  const employees = [{ id: 'emp_1', fullName: '' }, { id: 'emp_2', fullName: 'Иванов Иван Иванович' }];
  const similar = findSimilarEmployees(employees, 'Иванов Иван Иванович');
  assert.deepEqual(similar.map((e) => e.id), ['emp_2']);
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

Run: `node --test tests/asset_ops.test.js`
Expected: FAIL — `TypeError: findSimilarEmployees is not a function` (7 новых тестов падают, существующие проходят).

- [ ] **Step 3: Реализовать функции**

В `asset_ops.js` добавить перед строкой `const AssetOps = { ... };`:

```javascript
// Нормализация ФИО для сравнения: убираем разницу в регистре, лишние
// пробелы и написание «ё»/«е» — самые частые причины, по которым один
// и тот же человек заводится в базе дважды (§1 ТЗ, «различия в
// написании ФИО»). Тот же приём, что searchAssets использует для
// техники.
function normalizeFullName(fullName) {
  return String(fullName || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

/**
 * Ищет сотрудников с похожим ФИО — для предупреждения о возможном
 * дубле при добавлении нового (§1 ТЗ: предупреждать, не запрещать).
 * «Похожий» — совпадает после нормализации целиком, либо слова более
 * короткого ФИО целиком содержатся в более длинном (напр. без
 * отчества). Из двух общих слов при разных остальных — недостаточно:
 * это, скорее всего, разные люди с общей фамилией или именем, а не
 * разное написание одного. excludeId исключает самого редактируемого
 * сотрудника — иначе он всегда «похож сам на себя».
 */
function findSimilarEmployees(employees, fullName, excludeId = '') {
  const normalized = normalizeFullName(fullName);
  if (!normalized) return [];
  const words = normalized.split(' ').filter(Boolean);
  const wordSet = new Set(words);
  return (employees || []).filter((employee) => {
    if (employee.id === excludeId) return false;
    const otherNormalized = normalizeFullName(employee.fullName);
    if (!otherNormalized) return false;
    if (otherNormalized === normalized) return true;
    const otherWords = otherNormalized.split(' ').filter(Boolean);
    const otherWordSet = new Set(otherWords);
    if (wordSet.size < 2 || otherWordSet.size < 2) return false;
    const overlap = words.filter((w) => otherWordSet.has(w));
    return overlap.length >= Math.min(wordSet.size, otherWordSet.size);
  });
}
```

Заменить строку экспорта на:

```javascript
const AssetOps = { mergeAllocation, searchAssets, movementSortValue, movementCreatedAt, singleEmployeeId, normalizeFullName, findSimilarEmployees };
```

- [ ] **Step 4: Запустить тесты и убедиться, что проходят**

Run: `node --test tests/asset_ops.test.js`
Expected: PASS, все тесты файла зелёные (64 всего).

- [ ] **Step 5: Коммит**

```bash
git add asset_ops.js tests/asset_ops.test.js
git commit -m "$(cat <<'EOF'
feat(employees): findSimilarEmployees — похожие ФИО для защиты от дублей

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K41oDt8DfuD3EsDsLLJz5s
EOF
)"
```

---

### Task 2: Предупреждение о похожих сотрудниках при добавлении (§1)

**Files:**
- Modify: `index.html` (после первой `.form-row` формы `#employeeForm`, после ФИО+Отдел)
- Modify: `styles.css` (новый блок стилей рядом с `.emp-edit-aside`)
- Modify: `app.js` (новая функция `syncEmployeeDuplicateWarning`, рядом с `syncEmployeeEditAside`; расширить `handleEmployeeAsideSync` в `bindEvents`; новый обработчик клика по кнопке «Использовать эту запись»)

**Interfaces:**
- Consumes: `AssetOps.findSimilarEmployees` из Task 1.
- Produces: `syncEmployeeDuplicateWarning()` — ничего из этого не нужно другим задачам плана.

- [ ] **Step 1: Разметка панели предупреждения**

В `index.html` в форме `#employeeForm`, сразу после закрывающего `</div>` первой `.form-row` (та, что содержит поля ФИО и Отдел — ищите `id="employeeFullNameInput"`, панель ставится сразу за концом этой строки, перед следующей `.form-row` с Должностью/Объектом), вставить:

```html
          <div id="employeeDuplicateWarning" class="emp-duplicate-warning hidden"></div>
```

- [ ] **Step 2: Стили панели**

В `styles.css` рядом с `.emp-edit-aside` (искать по этому селектору) добавить:

```css
.emp-duplicate-warning {
  margin: 0 0 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--warn-dim);
  border: 1px solid var(--warn);
  font-size: 12.5px;
}
.emp-duplicate-warning-title { font-weight: 600; color: var(--warn); margin-bottom: 6px; }
.emp-duplicate-warning-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 0; }
.emp-duplicate-warning-item + .emp-duplicate-warning-item { border-top: 1px solid var(--warn-dim); }
```

- [ ] **Step 3: Функция отрисовки предупреждения**

В `app.js` рядом с `syncEmployeeEditAside` (искать по имени функции) добавить:

```javascript
// Предупреждение о похожих сотрудниках при вводе ФИО (§1 ТЗ): показывает
// найденные совпадения и даёт использовать существующую запись вместо
// создания новой — но не запрещает сохранить как есть. Работает и при
// добавлении, и при редактировании (excludeId исключает самого себя).
function syncEmployeeDuplicateWarning() {
  const panel = document.getElementById("employeeDuplicateWarning");
  if (!panel) return;
  const employeeId = document.getElementById("employeeFormId")?.value || "";
  const fullName = document.getElementById("employeeFullNameInput")?.value || "";
  const similar = AssetOps.findSimilarEmployees(state.employees, fullName, employeeId);
  if (!similar.length) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }
  panel.classList.remove("hidden");
  panel.innerHTML = `<div class="emp-duplicate-warning-title">Похожие сотрудники уже есть в реестре — возможно, это дубль:</div>`
    + similar.map((employee) => `
      <div class="emp-duplicate-warning-item">
        <span>${escapeHtml(employee.fullName)}${employee.department ? ` — ${escapeHtml(employee.department)}` : ""}</span>
        <button type="button" class="secondary" data-use-employee-id="${escapeHtml(employee.id)}">Использовать эту запись</button>
      </div>`).join("");
}
```

- [ ] **Step 4: Подключить к существующему слушателю формы**

В `bindEvents` найти (искать `handleEmployeeAsideSync`):

```javascript
  const handleEmployeeAsideSync = () => {
    const employeeId = document.getElementById("employeeFormId")?.value;
    syncEmployeeEditAside(employeeId ? getEmployeeById(employeeId) : null);
  };
```

заменить на:

```javascript
  const handleEmployeeAsideSync = () => {
    const employeeId = document.getElementById("employeeFormId")?.value;
    syncEmployeeEditAside(employeeId ? getEmployeeById(employeeId) : null);
    syncEmployeeDuplicateWarning();
  };
```

Рядом (в том же `bindEvents`) добавить обработчик клика по кнопке в панели — «Использовать эту запись» переключает форму в режим редактирования найденного сотрудника, автоматически подтягивая его данные (§1 ТЗ):

```javascript
  document.getElementById("employeeDuplicateWarning")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-use-employee-id]");
    if (!button) return;
    openEditEmployeeModal(button.dataset.useEmployeeId);
  });
```

- [ ] **Step 5: Скрывать панель при открытии формы «Добавить сотрудника»**

В `openAddEmployeeModal` (искать по имени функции) добавить очистку панели — форма могла остаться с предыдущего открытия:

```javascript
function openAddEmployeeModal() {
  resetEmployeeForm();
  syncEmployeeEditAside(null);
  document.getElementById("employeeDuplicateWarning")?.classList.add("hidden");
  document.getElementById("employeeModalOverlay")?.classList.remove("hidden");
  document.getElementById("employeeFullNameInput")?.focus();
}
```

(Изменилась только одна добавленная строка — остальное остаётся как есть.)

- [ ] **Step 6: Проверить синтаксис**

Run: `node --check app.js`
Expected: без вывода.

- [ ] **Step 7: Проверить в браузере**

```bash
python -m http.server 8790 --bind 127.0.0.1 --directory /d/warehouse &
```

На тестовых данных (заведите сотрудника «Иванов Иван Иванович»):
1. Открыть «Добавить сотрудника», начать вводить «Иванов Иван» — появляется предупреждение с найденным «Иванов Иван Иванович».
2. Нажать «Использовать эту запись» — форма переключается в режим редактирования, поля заполнены данными существующего сотрудника.
3. Открыть «Добавить сотрудника» заново, ввести заведомо новое ФИО — предупреждения нет, форма сохраняется как обычно (запрета нет).
4. Ввести похожее ФИО и всё равно нажать «Сохранить сотрудника», не используя подсказку — сотрудник создаётся (предупреждение не блокирует).

Остановить сервер после проверки.

- [ ] **Step 8: Коммит**

```bash
git add index.html styles.css app.js
git commit -m "$(cat <<'EOF'
feat(employees): предупреждение о похожих сотрудниках при добавлении

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K41oDt8DfuD3EsDsLLJz5s
EOF
)"
```

---

### Task 3: Дата, статус, операция и комментарий на карточке сотрудника (§2)

**Files:**
- Modify: `app.js` (новая функция `findLatestIssueMovement` и `renderHoldingsListDetailed`, рядом с `renderHoldingsList`; `openEmployeeDetailsModal` — переключить на детальный рендер)
- Modify: `styles.css` (одно новое правило рядом с `.held-list`)

**Interfaces:**
- Consumes: `AssetOps.movementSortValue` (часть 1), `getEmployeeHoldings` (уже существует).
- Produces: `findLatestIssueMovement(assetId, { employeeId, workplaceId })` → движение или `null`; `renderHoldingsListDetailed(entries, recipient)` — используется только в `openEmployeeDetailsModal`.

**Внимание на дрейф строк:** задача 2 добавляет код в `app.js` в области около `syncEmployeeEditAside` (строка ~1968 на момент написания плана) — это РАНЬШЕ в файле, чем `renderHoldingsList` (~2442) и `openEmployeeDetailsModal` (~2032), которые трогает эта задача. К моменту, когда до этой задачи дойдёт очередь, все номера строк ниже точки вставки задачи 2 сместятся. Находите функции по имени (`function renderHoldingsList`, `function openEmployeeDetailsModal`), не доверяйте абсолютным номерам.

- [ ] **Step 1: Найти последнюю операцию выдачи**

В `app.js` рядом с `renderHoldingsList` (искать по имени функции) добавить:

```javascript
// Последняя по свежести операция «Выдача» этой техники этому
// получателю — сотруднику лично или его рабочему месту (§2 ТЗ: для
// каждой единицы техники нужна дата выдачи, операция и комментарий, а
// у allocation этих данных нет — только в журнале движений).
// AssetOps.movementSortValue — тот же порядок, что чинит видимость
// выдач в «Операциях» (часть 1): запись без даты не считается «самой
// старой», а сортируется по моменту создания.
function findLatestIssueMovement(assetId, { employeeId = null, workplaceId = null } = {}) {
  const candidates = state.movements.filter((m) =>
    m.type === "issue" && m.assetId === assetId &&
    (employeeId ? m.employeeId === employeeId : Boolean(workplaceId) && m.workplaceId === workplaceId)
  );
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => AssetOps.movementSortValue(b) - AssetOps.movementSortValue(a))[0];
}
```

- [ ] **Step 2: Подробный список для карточки сотрудника**

Рядом (сразу после `renderHoldingsList`) добавить:

```javascript
// Подробный список техники для карточки сотрудника (§2 ТЗ): дата
// выдачи, текущий статус и операция, в результате которой техника
// оказалась у получателя, плюс комментарий, если он был указан.
// В отличие от renderHoldingsList (используется ещё и в панели
// «уже на руках» при выдаче — там нужен краткий список, не подробный
// аудит), эта функция используется только на карточке сотрудника.
function renderHoldingsListDetailed(entries, recipient) {
  return `<ul class="held-list">` + entries.map(({ asset, allocation }) => {
    const movement = findLatestIssueMovement(asset.id, recipient);
    const dateText = movement ? movementDateLabel(movement) : "Неизвестно";
    const opText = movement
      ? `${movementLabels[movement.type] || movement.type}${movement.actNumber ? ` · Акт №${movement.actNumber}` : ""}`
      : "—";
    const statusText = statusLabels[getAssetStatus(asset)] || asset.status;
    const noteText = movement?.notes ? ` · ${escapeHtml(movement.notes)}` : "";
    return `<li>
      <code>${escapeHtml(asset.inventoryNumber || "—")}</code><span>${escapeHtml(asset.name)}</span><b>${allocation.quantity} шт.</b>
      <div class="held-item-meta">Выдано: ${escapeHtml(dateText)} · ${escapeHtml(opText)} · Статус: ${escapeHtml(statusText)}${noteText}</div>
    </li>`;
  }).join("") + `</ul>`;
}
```

- [ ] **Step 3: Стиль для строки с подробностями**

В `styles.css` рядом с `.held-list` (искать по этому селектору) добавить:

```css
.held-item-meta { grid-column: 1 / -1; font-size: 11px; color: var(--text-3); margin-top: 2px; }
```

`.held-list li` уже задаёт `display:grid; grid-template-columns: 92px 1fr auto` — без `grid-column: 1 / -1` четвёртый элемент (строка с деталями) лёг бы в первую по счёту 92-пиксельную колонку и обрезался.

- [ ] **Step 4: Использовать подробный рендер в карточке сотрудника**

В `openEmployeeDetailsModal` (искать по имени функции) заменить:

```javascript
  let assetsHtml = `<div class="empty-state" style="padding:20px"><p>Техники за сотрудником нет</p></div>`;
  if (totalCount > 0) {
    assetsHtml =
      (workplace
        ? `<div class="held-title">На рабочем месте — ${escapeHtml(workplace.name)}</div>`
          + (atWorkplace.length ? renderHoldingsList(atWorkplace) : `<div class="held-title empty">Техники на месте нет</div>`)
        : "")
      + (personal.length
        ? `<div class="held-title"${workplace ? ' style="margin-top:14px"' : ""}>Лично на руках</div>` + renderHoldingsList(personal)
        : "");
  }
```

на:

```javascript
  let assetsHtml = `<div class="empty-state" style="padding:20px"><p>Техники за сотрудником нет</p></div>`;
  if (totalCount > 0) {
    assetsHtml =
      (workplace
        ? `<div class="held-title">На рабочем месте — ${escapeHtml(workplace.name)}</div>`
          + (atWorkplace.length ? renderHoldingsListDetailed(atWorkplace, { workplaceId: workplace.id }) : `<div class="held-title empty">Техники на месте нет</div>`)
        : "")
      + (personal.length
        ? `<div class="held-title"${workplace ? ' style="margin-top:14px"' : ""}>Лично на руках</div>` + renderHoldingsListDetailed(personal, { employeeId: employee.id })
        : "");
  }
```

Панель «уже на руках» в окне выдачи (`renderIssueEmployeeAssets`) не трогаем — она по-прежнему вызывает `renderHoldingsList` (краткий вариант), это осознанное решение по объёму задачи, см. Architecture выше.

- [ ] **Step 5: Проверить синтаксис**

Run: `node --check app.js`
Expected: без вывода.

- [ ] **Step 6: Проверить в браузере**

```bash
python -m http.server 8790 --bind 127.0.0.1 --directory /d/warehouse &
```

Сценарий: выдать технику сотруднику с комментарием, открыть карточку сотрудника — убедиться, что под позицией видна строка «Выдано: <дата> · Выдача · Акт №N · Статус: Выдано · <комментарий>». Выдать что-то без комментария — строка без него, без лишнего разделителя. Технику на рабочем месте сотрудника — та же подробная строка, источник даты/акта тот же (по `workplaceId`, не по `employeeId`).

Остановить сервер после проверки.

- [ ] **Step 7: Полный прогон тестов и коммит**

```bash
python -m pytest -q && node --test mobile/tests/*.test.js tests/*.test.js
git add app.js styles.css
git commit -m "$(cat <<'EOF'
feat(employees): дата, статус, операция и комментарий в карточке сотрудника

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K41oDt8DfuD3EsDsLLJz5s
EOF
)"
```

---

### Task 4: Сквозной сценарий и пересборка

**Files:** нет изменений кода.

- [ ] **Step 1: Сквозной сценарий по критериям готовности (§9 ТЗ, пункты про реестр сотрудников)**

На поднятой статике (см. Task 3, Step 6):
1. Найти сотрудника через реестр — если существует, система подтягивает его данные (Task 2).
2. Открыть склад, выбрать технику, выбрать сотрудника, добавить комментарий, выдать.
3. Открыть карточку сотрудника — убедиться, что выданная техника видна со статусом, датой, операцией и комментарием (Task 3).
4. Попробовать завести сотрудника с ФИО, похожим на уже существующего — увидеть предупреждение, убедиться что сохранение всё равно доступно.

- [ ] **Step 2: Резервная копия базы**

```bash
cp "C:/ProgramData/Warehouse/warehouse.db" "$SCRATCH/before_employee_registry_$(date +%Y%m%d_%H%M%S).db"
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

- [ ] **Step 6: Запустить и проверить**

Запустить `WarehouseApp.exe`, дождаться порта 8765.

```bash
for f in index.html app.js asset_ops.js styles.css; do diff <(curl -s http://127.0.0.1:8765/$f) $f > /dev/null && echo "$f совпадает" || echo "$f ОТЛИЧАЕТСЯ"; done
```

Expected: все совпадают. Затем повторить сценарий из Step 1 на боевых данных.
