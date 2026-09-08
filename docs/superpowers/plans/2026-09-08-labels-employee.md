# Этикетки и сотрудник (часть 2 из 3) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** В интерфейсе печати этикеток дать выбрать сотрудника и одним действием довыбрать его технику (§5 ТЗ), и печатать ФИО сотрудника на самой этикетке (§6 ТЗ).

**Architecture:** Печать этикеток — модальное окно (`#labelsOverlay`) с сеткой техники (`#labelGrid`), где выбор хранится прямо в DOM (класс `.selected` + состояние чекбоксов), а `renderLabelGrid()` перед каждой перерисовкой считывает текущий выбор из DOM и переносит его в новый HTML — это уже даёт «не терять выбор» при смене фильтров бесплатно. §5 подключается к этому же механизму: кнопка «Добавить технику сотрудника» находит технику сотрудника через уже существующую `getReturnAssets(employeeId)`, СБРАСЫВАЕТ фильтры сетки (иначе часть вещей сотрудника может быть не видна и недоступна для отметки) и ДОПОЛНИТЕЛЬНО отмечает чекбоксы — никогда не снимает уже стоящие галочки. Поскольку сетка хранит одну строку на актив (`data-id`), повторная отметка идемпотентна — дублей физически не возникает, отдельная защита от дублей не нужна.
Печать этикетки имеет два независимых рендерера, которые сейчас вручную держат в синхроне (комментарий у `drawLabelOnCanvas`: «mirroring buildLabelHtml»): `buildLabelHtml` (HTML — печать и Word) и `drawLabelOnCanvas` (Canvas — превью, JPG и PDF, через `renderLabelSheet`). §6 добавляет строку ФИО в оба, используя общий чистый хелпер `AssetOps.singleEmployeeId(allocations)` — техника печатает ФИО только когда закреплена ровно за одним сотрудником; иначе (несколько получателей или получатель не сотрудник) строка не печатается, как и требует спека.

**Tech Stack:** Браузерный JS без сборки (`app.js`, `asset_ops.js`, `index.html`), тесты JS на `node:test`.

**Spec:** `Промт на доработку системы учета техники.md` (§5 «Печать этикеток», §6 «ФИО сотрудника на этикетке»).

## Global Constraints

- Комментарии и текст интерфейса — на русском, как во всём проекте.
- Логика без DOM выносится в `asset_ops.js` и тестируется через `node --test`; DOM-код (`app.js`, `index.html`) проверяется вручную в браузере (`node --check app.js` для синтаксиса).
- Уже отмеченные вручную позиции в сетке этикеток никогда не снимаются программно — только дополняются.
- `buildLabelHtml` и `drawLabelOnCanvas` — два независимых рендерера одного шаблона; любая правка визуального содержимого вносится в оба, включая пересчёт места под имя (`smallLinesCount`/`smallCount`), иначе имя техники может визуально наехать на новую строку на маленьких этикетках.
- Python-тесты: `python -m pytest -q`. JS-тесты: `node --test mobile/tests/*.test.js tests/*.test.js`.
- Файл `_tmp_state.json` в корне репозитория — временный для браузерной проверки, **никогда не коммитить**.

---

### Task 1: `AssetOps.singleEmployeeId` в asset_ops.js

**Files:**
- Modify: `asset_ops.js` (новая функция, добавить в экспорт `AssetOps`)
- Test: `tests/asset_ops.test.js` (дописать блок в конец)

**Interfaces:**
- Consumes: ничего (чистая функция).
- Produces: `AssetOps.singleEmployeeId(allocations)` → `employeeId` (строка), если записи с непустым `employeeId` ведут ровно к одному уникальному сотруднику; иначе `null` (нет получателя-сотрудника, или их несколько разных).

- [ ] **Step 1: Написать падающие тесты**

Дописать в конец `tests/asset_ops.test.js`:

```javascript

// ─── единственный сотрудник для этикетки ─────────────────────────

const { singleEmployeeId } = require('../asset_ops.js');

test('singleEmployeeId возвращает id единственного сотрудника', () => {
  const allocations = [{ employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 2 }];
  assert.equal(singleEmployeeId(allocations), 'emp_1');
});

test('singleEmployeeId возвращает null, если техника не закреплена за сотрудником', () => {
  const allocations = [{ employeeId: null, department: 'Бухгалтерия', site: '', workplaceId: '', quantity: 4 }];
  assert.equal(singleEmployeeId(allocations), null);
});

test('singleEmployeeId возвращает null для пустого списка выдач', () => {
  assert.equal(singleEmployeeId([]), null);
});

test('singleEmployeeId возвращает null, если техника закреплена за разными сотрудниками', () => {
  // Например, часть тиража расходников выдана одному, часть — другому:
  // на этикетке одно имя было бы неоднозначным, поэтому не печатаем ни одно.
  const allocations = [
    { employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 1 },
    { employeeId: 'emp_2', department: '', site: '', workplaceId: '', quantity: 1 },
  ];
  assert.equal(singleEmployeeId(allocations), null);
});

test('singleEmployeeId игнорирует не-сотрудника рядом с сотрудником', () => {
  // Смешанная выдача (сотруднику и отделу одновременно) — получатель
  // всё равно один сотрудник, имя печатаем.
  const allocations = [
    { employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 1 },
    { employeeId: null, department: 'Бухгалтерия', site: '', workplaceId: '', quantity: 1 },
  ];
  assert.equal(singleEmployeeId(allocations), 'emp_1');
});

test('singleEmployeeId схлопывает две записи одного сотрудника в одно значение', () => {
  // Не должно возникать в норме (mergeAllocation сливает такие записи),
  // но функция не должна принять задвоенную запись за двух получателей.
  const allocations = [
    { employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 1 },
    { employeeId: 'emp_1', department: '', site: '', workplaceId: '', quantity: 2 },
  ];
  assert.equal(singleEmployeeId(allocations), 'emp_1');
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

Run: `node --test tests/asset_ops.test.js`
Expected: FAIL — `TypeError: singleEmployeeId is not a function` (6 новых тестов падают, существующие проходят).

- [ ] **Step 3: Реализовать функцию**

В `asset_ops.js` добавить перед строкой `const AssetOps = { mergeAllocation, searchAssets, movementSortValue, movementCreatedAt };`:

```javascript
// Единственный сотрудник, за которым закреплена техника — для этикетки
// (§6 ТЗ): печатаем ФИО, только если получатель однозначен. Несколько
// разных сотрудников или получатель не сотрудник вовсе — печатать
// некого, возвращаем null, и строка ФИО на этикетке не появляется.
function singleEmployeeId(allocations) {
  const employeeIds = (allocations || [])
    .filter((entry) => entry.employeeId)
    .map((entry) => entry.employeeId);
  const unique = [...new Set(employeeIds)];
  return unique.length === 1 ? unique[0] : null;
}
```

Заменить строку экспорта на:

```javascript
const AssetOps = { mergeAllocation, searchAssets, movementSortValue, movementCreatedAt, singleEmployeeId };
```

- [ ] **Step 4: Запустить тесты и убедиться, что проходят**

Run: `node --test tests/asset_ops.test.js`
Expected: PASS, все тесты файла зелёные (56 всего).

- [ ] **Step 5: Коммит**

```bash
git add asset_ops.js tests/asset_ops.test.js
git commit -m "$(cat <<'EOF'
feat(labels): singleEmployeeId — однозначный получатель-сотрудник для этикетки

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K41oDt8DfuD3EsDsLLJz5s
EOF
)"
```

---

### Task 2: Выбор сотрудника в окне печати этикеток (§5)

**Files:**
- Modify: `index.html:1136-1148` (блок `.label-select-actions` в `#labelsOverlay`)
- Modify: `app.js` (`openLabelsModal` — `app.js:4909-4914`; новая функция `populateLabelEmployeeSelect`, рядом с `populateLabelFilterDropdowns` — `app.js:5142-5155`; новая функция `addEmployeeAssetsToLabelSelection`, рядом с `renderLabelGrid`/`labelSelectAll`; регистрация обработчика в `bindEvents` — рядом с `app.js:4660-4667`)

**Interfaces:**
- Consumes: `getReturnAssets(employeeId)` (уже существует, `app.js:2622`) — список активов, закреплённых за сотрудником; `getActiveEmployees(state.employees)` (уже существует, `app.js:584`).
- Produces: `populateLabelEmployeeSelect()`, `addEmployeeAssetsToLabelSelection()` — ничего из этого не нужно другим задачам плана.

- [ ] **Step 1: Разметка**

В `index.html` в `.label-select-actions` (после `<label style="gap:6px"><input type="checkbox" id="labelUnprintedCheck" ...> Не печатались ранее</label>`, строка 1146, и перед `<span class="label-count" id="labelCountSpan">0 выбрано</span>`, строка 1147) вставить:

```html
        <select id="labelEmployeeSelect">
          <option value="">— сотрудник —</option>
        </select>
        <button type="button" class="secondary" id="labelAddEmployeeAssetsBtn">Добавить технику сотрудника</button>
```

- [ ] **Step 2: Заполнение списка сотрудников**

В `app.js` рядом с `populateLabelFilterDropdowns` (`app.js:5142`) добавить:

```javascript
function populateLabelEmployeeSelect() {
  const select = document.getElementById("labelEmployeeSelect");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">— сотрудник —</option>`
    + getActiveEmployees(state.employees).map((employee) =>
      `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.fullName)}</option>`).join("");
  select.value = current;
}
```

В `openLabelsModal` (`app.js:4909-4914`) заменить:

```javascript
function openLabelsModal() {
  document.getElementById("labelsOverlay").classList.remove("hidden");
  populateLabelFilterDropdowns();
  renderLabelGrid();
  updateLabelSizeHint();
}
```

на:

```javascript
function openLabelsModal() {
  document.getElementById("labelsOverlay").classList.remove("hidden");
  populateLabelFilterDropdowns();
  populateLabelEmployeeSelect();
  renderLabelGrid();
  updateLabelSizeHint();
}
```

- [ ] **Step 3: Добавление техники сотрудника в выбор**

Рядом с `labelSelectAll` (`app.js`, ищите по имени функции — предыдущая задача не трогает эту область) добавить:

```javascript
// «Добавить технику сотрудника»: находит всю технику, закреплённую за
// выбранным сотрудником, и довыбирает её в сетке — не заменяя, а
// дополняя то, что уже отмечено вручную (§5 ТЗ: «уже выбранные вручную
// этикетки не должны удаляться»). Сбрасываем фильтры перед перерисовкой:
// техника сотрудника обязана попасть в список независимо от того, что
// было выбрано в поиске/категории/локации до этого — иначе часть его
// вещей могла бы оказаться отфильтрована и недоступна для отметки.
// Повторная отметка чекбокса, который уже стоит — no-op, поэтому
// отдельная защита от дублей не нужна: строка одна на asset.id.
function addEmployeeAssetsToLabelSelection() {
  const select = document.getElementById("labelEmployeeSelect");
  const employeeId = select?.value || "";
  if (!employeeId) {
    showToast("Выберите сотрудника.", "warning");
    return;
  }
  const employeeAssets = getReturnAssets(employeeId);
  if (!employeeAssets.length) {
    showToast("За этим сотрудником не закреплена техника.", "warning");
    return;
  }

  const searchInput = document.getElementById("labelSearchInput");
  const categorySelect = document.getElementById("labelFilterCategory");
  const locationSelect = document.getElementById("labelFilterLocation");
  const unprintedCheck = document.getElementById("labelUnprintedCheck");
  if (searchInput) searchInput.value = "";
  if (categorySelect) categorySelect.value = "";
  if (locationSelect) locationSelect.value = "";
  if (unprintedCheck) unprintedCheck.checked = false;
  renderLabelGrid();

  const grid = document.getElementById("labelGrid");
  const employeeAssetIds = new Set(employeeAssets.map((asset) => asset.id));
  let added = 0;
  grid.querySelectorAll(".label-item").forEach((item) => {
    if (!employeeAssetIds.has(item.dataset.id)) return;
    const checkbox = item.querySelector("input[type=checkbox]");
    if (!checkbox.checked) added += 1;
    checkbox.checked = true;
    item.classList.add("selected");
  });
  updateLabelCount();
  showToast(`Добавлено позиций: ${added} (найдено за сотрудником: ${employeeAssets.length}).`, "success");
}
```

- [ ] **Step 4: Обработчик кнопки**

В `bindEvents`, рядом с существующими обработчиками окна этикеток (`app.js:4660-4667`), добавить:

```javascript
  document.getElementById("labelAddEmployeeAssetsBtn")?.addEventListener("click", addEmployeeAssetsToLabelSelection);
```

- [ ] **Step 5: Проверить синтаксис**

Run: `node --check app.js`
Expected: без вывода.

- [ ] **Step 6: Проверить в браузере**

```bash
python -m http.server 8790 --bind 127.0.0.1 --directory /d/warehouse &
```

На реальных данных (или тестовых, заведённых через интерфейс): открыть «Этикетки», вручную отметить 1-2 позиции техники, затем выбрать сотрудника с закреплённой техникой и нажать «Добавить технику сотрудника». Убедиться:
- вручную отмеченные позиции остались отмеченными;
- вся техника сотрудника отмечена дополнительно;
- счётчик «N выбрано» учитывает и то, и другое без задвоения;
- повторное нажатие кнопки для того же сотрудника не меняет счётчик (idempotent).

Остановить сервер после проверки.

- [ ] **Step 7: Коммит**

```bash
git add index.html app.js
git commit -m "$(cat <<'EOF'
feat(labels): выбор сотрудника довыбирает его технику в окне печати

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K41oDt8DfuD3EsDsLLJz5s
EOF
)"
```

---

### Task 3: ФИО сотрудника на этикетке (§6)

**Files:**
- Modify: `app.js` (новая функция `getAssetEmployeeName`, рядом с `getEmployeeById` — `app.js:468`; `buildLabelHtml` — `app.js:5373-5430`; `drawLabelOnCanvas` — `app.js:5434-5523`)

**Interfaces:**
- Consumes: `AssetOps.singleEmployeeId` из Task 1.
- Produces: `getAssetEmployeeName(asset)` → ФИО (строка) или `null`. Используется в обоих рендерерах этикетки.

- [ ] **Step 1: Хелпер имени**

В `app.js` рядом с `getEmployeeById` (`app.js:468`) добавить:

```javascript
// ФИО сотрудника для этикетки (§6 ТЗ). null, если техника не закреплена
// ровно за одним сотрудником — тогда строка на этикетке не печатается.
function getAssetEmployeeName(asset) {
  const employeeId = AssetOps.singleEmployeeId(asset.allocations);
  if (!employeeId) return null;
  const employee = getEmployeeById(employeeId);
  return employee ? employee.fullName : null;
}
```

- [ ] **Step 2: Строка ФИО в HTML-шаблоне (`buildLabelHtml`)**

В `buildLabelHtml` (`app.js:5373-5430`) после блока с `invLine` (строки 5391-5392):

```javascript
  const invLine = (showInv && asset.inventoryNumber && !showQr)
    ? `<div style="font-size:${f.small}pt;color:#555;line-height:${SMALL_LINE_H}">Инв: ${escapeHtml(asset.inventoryNumber)}</div>` : '';
```

добавить:

```javascript
  const empName = getAssetEmployeeName(asset);
  const empLine = empName
    ? `<div style="font-size:${f.small}pt;color:#000;font-weight:600;line-height:${SMALL_LINE_H};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(empName)}</div>` : '';
```

Строку подсчёта занятых строк (`app.js:5410`):

```javascript
  const smallLinesCount = (catLine ? 1 : 0) + (snLine ? 1 : 0) + (locLine ? 1 : 0) + (invLine ? 1 : 0);
```

заменить на:

```javascript
  const smallLinesCount = (catLine ? 1 : 0) + (snLine ? 1 : 0) + (locLine ? 1 : 0) + (invLine ? 1 : 0) + (empLine ? 1 : 0);
```

Без этой правки авто-подбор размера шрифта названия не оставит места под новую строку, и на маленьких этикетках (40×30мм) ФИО наедет на название.

В возвращаемом HTML (`app.js:5421-5427`) после `${invLine}` добавить `${empLine}`:

```javascript
      ${catLine}
      ${snLine}
      ${locLine}
      ${invLine}
      ${empLine}
    </div>
    ${bottom}
```

- [ ] **Step 3: Строка ФИО в Canvas-рендерере (`drawLabelOnCanvas`)**

В `drawLabelOnCanvas` (`app.js:5434-5523`) после блока `hasInv` (строка 5459):

```javascript
  const hasInv = !!(showInv && asset.inventoryNumber && !showQr);
```

добавить:

```javascript
  const empName = getAssetEmployeeName(asset);
  const hasEmp = !!empName;
```

Подсчёт занятых строк (`app.js:5467`):

```javascript
  const smallCount = (hasCat ? 1 : 0) + (hasSn ? 1 : 0) + (hasLoc ? 1 : 0) + (hasInv ? 1 : 0);
```

заменить на:

```javascript
  const smallCount = (hasCat ? 1 : 0) + (hasSn ? 1 : 0) + (hasLoc ? 1 : 0) + (hasInv ? 1 : 0) + (hasEmp ? 1 : 0);
```

Отрисовку строк (`app.js:5493-5496`):

```javascript
  if (hasCat) small(asset.category, '#666');
  if (hasSn) small('S/N: ' + asset.serialNumber, '#808080');
  if (hasLoc) small('Локация: ' + asset.location, '#2563eb');
  if (hasInv) small('Инв: ' + asset.inventoryNumber, '#555');
```

дополнить:

```javascript
  if (hasCat) small(asset.category, '#666');
  if (hasSn) small('S/N: ' + asset.serialNumber, '#808080');
  if (hasLoc) small('Локация: ' + asset.location, '#2563eb');
  if (hasInv) small('Инв: ' + asset.inventoryNumber, '#555');
  if (hasEmp) {
    // buildLabelHtml печатает ФИО жирным (font-weight:600) — то же здесь,
    // временно переключив шрифт контекста и вернув его обратно, чтобы не
    // задеть последующую отрисовку (штрихкод/подпись ниже этого блока).
    ctx.font = `700 ${ptToPx(f.small)}px Arial, Helvetica, sans-serif`;
    small(empName, '#000');
    ctx.font = `${ptToPx(f.small)}px Arial, Helvetica, sans-serif`;
  }
```

- [ ] **Step 4: Проверить синтаксис**

Run: `node --check app.js`
Expected: без вывода.

- [ ] **Step 5: Проверить в браузере**

```bash
python -m http.server 8790 --bind 127.0.0.1 --directory /d/warehouse &
```

Сценарий:
1. Технику, закреплённую за одним сотрудником, добавить в список печати (вручную или через Task 2) — открыть предпросмотр (canvas-рендерер) и печать/Word (HTML-рендерер): в обоих ФИО видно, шрифт названия не наезжает на новую строку даже на этикетке 40×30мм.
2. Технику без получателя или закреплённую за отделом/объектом/рабочим местом (не сотрудником) — строки ФИО нет ни в одном рендерере.
3. Технику, часть которой выдана одному сотруднику, часть — другому (если есть в тестовых данных; иначе завести вручную) — строки ФИО нет (неоднозначный получатель).

Остановить сервер после проверки.

- [ ] **Step 6: Полный прогон тестов и коммит**

```bash
python -m pytest -q && node --test mobile/tests/*.test.js tests/*.test.js
git add app.js
git commit -m "$(cat <<'EOF'
feat(labels): ФИО сотрудника на этикетке

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K41oDt8DfuD3EsDsLLJz5s
EOF
)"
```

---

### Task 4: Сквозной сценарий и пересборка

**Files:** нет изменений кода.

- [ ] **Step 1: Сквозной сценарий по критериям готовности (§9 ТЗ, пункты про этикетки)**

На поднятой статике (см. Task 3, Step 5):
1. Открыть печать этикеток.
2. Выбрать сотрудника — убедиться, что подтягивается его закреплённая техника (закрепление сначала можно создать через выдачу со склада).
3. Нажать «Добавить технику сотрудника» — все его позиции отмечены, ранее отмеченные вручную — не потеряны.
4. Сформировать этикетки (печать/предпросмотр/PDF/JPG/Word — минимум два разных экспорта).
5. Убедиться, что на этикетке техники сотрудника отображается его ФИО, а на этикетке несвязанной техники — нет.

- [ ] **Step 2: Резервная копия базы**

```bash
cp "C:/ProgramData/Warehouse/warehouse.db" "$SCRATCH/before_labels_employee_$(date +%Y%m%d_%H%M%S).db"
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
for f in index.html app.js asset_ops.js; do diff <(curl -s http://127.0.0.1:8765/$f) $f > /dev/null && echo "$f совпадает" || echo "$f ОТЛИЧАЕТСЯ"; done
```

Expected: все совпадают. Затем в реальном интерфейсе повторить сценарий из Step 1 на боевых данных (сотрудник с закреплённой техникой уже есть в базе).
