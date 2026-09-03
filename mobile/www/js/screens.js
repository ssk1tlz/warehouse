function describeScanError(err, fallback) {
  return (err && err.message) ? err.message : fallback;
}

function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const match = /^[vV]?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function describeUpdate(state, currentVersion) {
  const latest = parseVersion(state && state.latestVersion);
  const current = parseVersion(currentVersion);
  if (!latest || !current) return null;
  for (let i = 0; i < 3; i += 1) {
    if (latest[i] > current[i]) break;
    if (latest[i] < current[i]) return null;
    if (i === 2) return null; // полностью равны
  }
  return {
    text: `Доступна версия ${state.latestVersion} (у вас ${currentVersion}).`,
    url: (state && state.releaseUrl) || 'https://github.com/ssk1tlz/warehouse/releases',
  };
}

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

const NAV_SCREEN_MAP = {
  navSearchBtn: 'screen-search',
  navQueueBtn: 'screen-queue',
  navHistoryBtn: 'screen-history',
  navInventoryBtn: 'screen-inventory-start',
  navSettingsBtn: 'screen-settings',
};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('current', NAV_SCREEN_MAP[btn.id] === id);
  });
}

let currentAssetId = null;
let currentAsset = null;
let currentActionType = null;
let currentEmployees = null;

async function refreshQueueCount() {
  const pending = await Db.listPendingActions();
  const badge = document.getElementById('queueCount');
  badge.textContent = pending.length;
  badge.classList.toggle('hidden', pending.length === 0);
}

async function openAssetScreen(assetId) {
  const asset = await Db.getAssetById(assetId);
  if (!asset) {
    Toast.show('Этот QR не найден в кэше. Подключитесь к сети склада и повторите синхронизацию.', 'error');
    return;
  }
  currentAssetId = assetId;
  currentAsset = asset;
  const employees = await Db.listEmployeesById();
  currentEmployees = employees;
  const status = getAssetStatus(asset);
  const statusEl = document.getElementById('assetStatus');
  statusEl.textContent = STATUS_LABELS[status] || asset.status;
  const tone = status === 'assigned' || status === 'partial' ? 'warn' : status === 'repair' || status === 'retired' ? 'danger' : 'ok';
  statusEl.className = `pill ${tone}`;
  document.getElementById('assetMeta').textContent =
    `${asset.category || '—'} · Инв. № ${asset.inventoryNumber || '—'} · С/н ${asset.serialNumber || '—'} · ${asset.location || '—'}`;

  const holdersEl = document.getElementById('assetHolders');
  holdersEl.innerHTML = '';
  if (!asset.allocations.length) {
    holdersEl.innerHTML = '<li>Не закреплено — на складе</li>';
  } else {
    for (const alloc of asset.allocations) {
      const li = document.createElement('li');
      li.textContent = `${holderLabel(alloc, employees)} — ${alloc.quantity} шт.`;
      holdersEl.appendChild(li);
    }
  }

  const movementsEl = document.getElementById('assetMovements');
  movementsEl.innerHTML = '';
  const movements = await Db.listMovementsForAsset(assetId);
  if (!movements.length) {
    movementsEl.innerHTML = '<li>Нет движений</li>';
  } else {
    for (const m of movements) {
      const li = document.createElement('li');
      li.textContent = `${MOVEMENT_LABELS[m.type] || m.type} · ${m.date || '—'}`;
      movementsEl.appendChild(li);
    }
  }

  const actionsEl = document.getElementById('assetActions');
  actionsEl.innerHTML = '';
  const available = getAvailableQuantity(asset);
  if (available > 0) addActionButton(actionsEl, 'issue', 'Выдать');
  if (asset.allocations.length) addActionButton(actionsEl, 'return', 'Принять возврат');
  if (available > 0) addActionButton(actionsEl, 'repair', 'В ремонт');
  if (asset.repairQuantity > 0) addActionButton(actionsEl, 'repair_return', 'Вернуть из ремонта');
  if (available > 0) addActionButton(actionsEl, 'retire', 'Списать');
  const editBtn = document.createElement('button');
  editBtn.textContent = 'Редактировать';
  editBtn.className = 'secondary';
  editBtn.addEventListener('click', openEditScreen);
  actionsEl.appendChild(editBtn);

  showScreen('screen-asset');
}

// Заполняет пустые поля формы редактирования тем, что распозналось на этикетке.
// Непустые поля не трогаем — распознавание подсказывает, а не перезаписывает.
function applyLabelToEditForm(parsed) {
  const fills = [
    ['editName', parsed.name],
    ['editCategory', parsed.category],
    ['editSerialNumber', parsed.serialNumber],
  ];
  let applied = 0;
  for (const [id, value] of fills) {
    const field = document.getElementById(id);
    if (value && !field.value.trim()) {
      field.value = value;
      applied += 1;
    }
  }
  return applied;
}

function openEditScreen() {
  document.getElementById('editName').value = currentAsset.name || '';
  document.getElementById('editCategory').value = currentAsset.category || '';
  document.getElementById('editInventoryNumber').value = currentAsset.inventoryNumber || '';
  document.getElementById('editSerialNumber').value = currentAsset.serialNumber || '';
  document.getElementById('editLocation').value = currentAsset.location || '';
  document.getElementById('editPurchaseDate').value = currentAsset.purchaseDate || '';
  document.getElementById('editWarrantyEnd').value = currentAsset.warrantyEnd || '';
  showScreen('screen-edit');
}

async function submitEdit(event) {
  event.preventDefault();
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
  await Db.enqueueAction(payload);
  Toast.show('Действие в очереди', 'info');
  await refreshQueueCount();
  Sync.run().then((r) => { refreshQueueCount(); ConnStatus.report(r.pulled, r.needsReauth); });
  showScreen('screen-scan');
}

function addActionButton(container, type, label) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.addEventListener('click', () => openActionScreen(type));
  container.appendChild(btn);
}

function openActionScreen(type) {
  currentActionType = type;
  document.getElementById('actionTitle').textContent = MOVEMENT_LABELS[type];
  const needsEmployee = (type === 'issue' || type === 'return' || type === 'repair' || type === 'repair_return');
  document.getElementById('actionEmployeeField').style.display = needsEmployee ? '' : 'none';
  if (needsEmployee) {
    const select = document.getElementById('actionEmployee');
    select.innerHTML = '';
    for (const [id, employee] of currentEmployees) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = employee.fullName;
      select.appendChild(option);
    }
  }
  document.getElementById('actionDate').value = new Date().toISOString().slice(0, 10);
  showScreen('screen-action');
}

async function submitAction(event) {
  event.preventDefault();
  const payload = {
    type: currentActionType,
    assetId: currentAssetId,
    employeeId: document.getElementById('actionEmployee').value || null,
    department: '',
    site: '',
    quantity: Number(document.getElementById('actionQuantity').value || 1),
    date: document.getElementById('actionDate').value,
    notes: document.getElementById('actionNotes').value,
  };
  if (currentActionType === 'repair') {
    payload.sourceType = payload.employeeId ? 'employee' : 'warehouse';
  }
  if (currentActionType === 'repair_return') {
    payload.targetType = payload.employeeId ? 'employee' : 'warehouse';
  }
  await Db.enqueueAction(payload);
  Toast.show('Действие в очереди', 'info');
  await refreshQueueCount();
  Sync.run().then((r) => { refreshQueueCount(); ConnStatus.report(r.pulled, r.needsReauth); }); // fire-and-forget, but still refresh the badges once sync settles
  showScreen('screen-scan');
}

async function renderSearchResults(query) {
  const assets = await Db.searchAssets(query);
  const listEl = document.getElementById('searchResults');
  listEl.innerHTML = '';
  if (!assets.length) {
    listEl.innerHTML = '<li>Ничего не найдено</li>';
    return;
  }
  for (const asset of assets) {
    const li = document.createElement('li');
    const status = getAssetStatus(asset);
    li.textContent = `${asset.name} · ${asset.inventoryNumber || '—'} — ${STATUS_LABELS[status] || asset.status}`;
    li.addEventListener('click', () => openAssetScreen(asset.id));
    listEl.appendChild(li);
  }
}

async function openSearchScreen() {
  showScreen('screen-search');
  await renderSearchResults(document.getElementById('searchInput').value);
}

async function openQueueScreen() {
  const pending = await Db.listPendingActions();
  const listEl = document.getElementById('queueList');
  listEl.innerHTML = '';
  if (!pending.length) {
    listEl.innerHTML = '<li>Очередь пуста</li>';
  } else {
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
  }
  showScreen('screen-queue');
}

function addHistoryDetailRow(dl, label, value) {
  if (!value) return;
  const row = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  row.append(dt, dd);
  dl.appendChild(row);
}

async function openHistoryScreen() {
  const employees = await Db.listEmployeesById();
  const history = await Db.listMovementHistory();
  const listEl = document.getElementById('historyList');
  listEl.innerHTML = '';
  if (!history.length) {
    listEl.innerHTML = '<li>История пуста</li>';
  } else {
    for (const m of history) {
      const li = document.createElement('li');
      const details = document.createElement('details');
      const summary = document.createElement('summary');

      const main = document.createElement('span');
      main.className = 'hist-main';
      const typeSpan = document.createElement('span');
      typeSpan.className = 'hist-type';
      typeSpan.textContent = MOVEMENT_LABELS[m.type] || m.type;
      const assetSpan = document.createElement('span');
      assetSpan.className = 'hist-asset';
      assetSpan.textContent = m.assetName || m.assetId;
      main.append(typeSpan, assetSpan);

      const dateSpan = document.createElement('span');
      dateSpan.className = 'hist-date';
      dateSpan.textContent = m.date || '—';

      const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chevron.setAttribute('viewBox', '0 0 24 24');
      chevron.setAttribute('fill', 'none');
      chevron.setAttribute('aria-hidden', 'true');
      chevron.classList.add('chevron');
      chevron.innerHTML = '<path d="M8 10l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';

      summary.append(main, dateSpan, chevron);

      const dl = document.createElement('dl');
      dl.className = 'hist-detail';
      addHistoryDetailRow(dl, m.type === 'return' ? 'От кого' : 'Получатель', holderLabel(m, employees));
      addHistoryDetailRow(dl, 'Количество', m.quantity != null ? `${m.quantity} шт.` : '');
      addHistoryDetailRow(dl, '№ акта', m.actNumber ? String(m.actNumber) : '');
      addHistoryDetailRow(dl, 'Заметка', m.notes);

      details.append(summary, dl);
      li.appendChild(details);
      listEl.appendChild(li);
    }
  }
  showScreen('screen-history');
}

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

async function postInventoryStart() {
  // Нет apiFetch() на мобильном — реальный паттерн (см. Sync.flushQueue/pullState
  // в sync.js): собрать подписанные заголовки через Sync.signedHeaders и сделать
  // fetch() напрямую на settings.serverUrl + путь.
  const settings = await Settings.get();
  const headers = { 'Content-Type': 'application/json', ...(await Sync.signedHeaders(settings, 'POST', '/api/inventory/start', '')) };
  const response = await fetch(`${settings.serverUrl}/api/inventory/start`, { method: 'POST', headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 409 && body.session) {
      // Сессия уже была открыта кем-то другим между открытием этого экрана и
      // нажатием "Начать" — подключиться к ней, а не считать это ошибкой.
      return body.session.id;
    }
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body.sessionId;
}

async function startInventoryScanning() {
  if (!currentInventorySessionId) {
    try {
      currentInventorySessionId = await postInventoryStart();
    } catch (err) {
      Toast.show(err.message || 'Не удалось начать инвентаризацию.', 'error');
      return;
    }
  }

  try {
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
      try {
        await Db.saveInventoryScan(currentInventorySessionId, assetId, 'found', '');
      } catch (error) {
        // Не добавляем assetId в seen — сбой записи в локальную Db не должен
        // навсегда "проглотить" находку; повторный скан того же кода
        // попробует сохранить ещё раз вместо того, чтобы молча теряться.
        Toast.show(describeScanError(error, 'Не удалось сохранить скан — повторите.'), 'error');
        return;
      }
      seen.add(assetId);
      foundCount += 1;
      document.getElementById('inventoryCounter').textContent = `Найдено ${foundCount} из ${inventoryAllAssets.length}`;
    });
  } catch (error) {
    // Camera/permission failure (same class as scanOnce()'s) or a local Db
    // read failure anywhere in this setup — either way the user must not be
    // left stranded on screen-inventory-scan, which deliberately has no
    // data-back for swipe-to-exit during an active scan.
    document.body.classList.remove('barcode-scanner-active');
    try {
      // Best-effort cleanup: Scanner.startInventoryScan() may have registered
      // its listener before a later step (e.g. BarcodeScanner.startScan())
      // threw, leaving the native scanner half-started. We can't observe how
      // far it got from here, so call stop unconditionally and swallow any
      // secondary error — it's a safe no-op when nothing was ever started,
      // and a secondary failure here shouldn't bury the original error toast.
      await Scanner.stopInventoryScan();
    } catch (stopError) {
      // intentionally ignored — see comment above
    }
    Toast.show(describeScanError(error, 'Не удалось начать сканирование.'), 'error');
    showScreen('screen-inventory-start');
  }
}

async function finishInventoryScanning() {
  try {
    await Scanner.stopInventoryScan();
  } catch (error) {
    // Each scan was already persisted individually via Db.saveInventoryScan
    // as it happened — whether the native "stop" call itself came back clean
    // is unrelated to whether that data is safe. Warn, but still proceed to
    // reconcile/show discrepancies rather than stranding the user here.
    Toast.show(describeScanError(error, 'Не удалось корректно остановить сканер.'), 'error');
  }
  document.body.classList.remove('barcode-scanner-active');
  try {
    const scans = await Db.getInventoryScans(currentInventorySessionId);
    const result = reconcileInventory(scans, inventoryAllAssets, extraCodesThisSession);
    renderInventoryDiscrepancies(result);
    showScreen('screen-inventory-discrepancies');
  } catch (error) {
    // Unlike a stop-scanner hiccup, failing to read back the scan data means
    // we cannot show discrepancies at all — bail out to a screen the user can
    // actually act from (retry "Начать инвентаризацию") instead of leaving
    // them on the now-dead screen-inventory-scan.
    Toast.show(describeScanError(error, 'Не удалось загрузить результаты сканирования.'), 'error');
    showScreen('screen-inventory-start');
  }
}

// DOM-построение списков, как везде в этом файле (см. openAssetScreen's
// assetHolders/assetMovements) — createElement + textContent, НЕ innerHTML со
// строковой интерполяцией (в проекте нет и не должно быть отдельной функции
// экранирования HTML — .textContent безопасен по умолчанию).
function renderInventoryList(containerId, heading, items, emptyText, formatItem) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const h3 = document.createElement('h3');
  h3.textContent = heading;
  container.appendChild(h3);
  if (!items.length) {
    const p = document.createElement('p');
    p.textContent = emptyText;
    container.appendChild(p);
    return;
  }
  for (const item of items) {
    const p = document.createElement('p');
    p.textContent = formatItem(item);
    container.appendChild(p);
  }
}

function renderInventoryDiscrepancies(result) {
  renderInventoryList('inventoryMissingList', 'Не найдено', result.missing, 'Все позиции найдены.',
    (a) => a.name);
  renderInventoryList('inventoryWrongLocationList', 'Не на своём месте', result.wrongLocation, 'Расхождений по местоположению нет.',
    (a) => `${a.name}: ${a.expectedLocation} → ${a.foundLocation}`);
  renderInventoryList('inventoryExtraList', 'Лишнее', result.extra, 'Лишних кодов не обнаружено.',
    (code) => code);
}

async function submitInventoryResult() {
  let scans;
  try {
    scans = await Db.getInventoryScans(currentInventorySessionId);
    // Db.enqueueAction сам генерирует clientActionId и кладёт запись в pending_actions —
    // тот же путь, которым уже идут выдача/возврат (см. вызовы этой функции выше по файлу).
    await Db.enqueueAction({
      type: 'inventory_complete',
      sessionId: currentInventorySessionId,
      scans: scans.map((s) => ({ assetId: s.assetId, status: s.status, foundLocation: s.foundLocation })),
      extraCodes: extraCodesThisSession,
    });
  } catch (error) {
    // Nothing was queued (clearInventoryScans hasn't run yet either way, so
    // the local inventory_scan_state rows for this session are still intact)
    // — stay on screen-inventory-discrepancies so "Отправить" can be retried,
    // and do NOT report success or navigate away as if the submit went through.
    Toast.show(describeScanError(error, 'Не удалось поставить инвентаризацию в очередь — попробуйте ещё раз.'), 'error');
    return;
  }

  try {
    await Db.clearInventoryScans(currentInventorySessionId);
  } catch (error) {
    // Lower-severity than the block above: the action is already safely
    // queued in pending_actions at this point (it will sync normally), so
    // this is local scan-state cache cleanup only, not data loss. Warn, but
    // still treat the submission itself as successful and move on.
    //
    // Deliberately NOT `describeScanError(error, fallback)` here (unlike
    // every other catch block in this flow) — describeScanError prefers the
    // real error.message when present, which for a raw SQLite/plugin error
    // would replace the "it was sent, don't worry" framing with an opaque
    // technical string and could wrongly read as total failure. The "sent"
    // fact must survive in the message even when the technical detail is
    // available, so it's appended rather than substituted; 'info' rather
    // than 'error' since the user's action did succeed.
    Toast.show(`Инвентаризация отправлена. Не удалось очистить локальный кэш сканов: ${describeScanError(error, 'неизвестная ошибка')}`, 'info');
    currentInventorySessionId = null;
    extraCodesThisSession = [];
    showScreen('screen-scan');
    return;
  }

  currentInventorySessionId = null;
  extraCodesThisSession = [];
  Toast.show('Инвентаризация отправлена в очередь синхронизации.', 'success');
  showScreen('screen-scan');
}

async function applyRoleVisibility() {
  const { role } = await Settings.get();
  document.getElementById('navInventoryBtn')?.classList.toggle('hidden', role !== 'admin');
}

async function init() {
  // Deviation from the brief's verbatim code: db.js's `open()` (Task 4) is the
  // documented entry point that creates/opens the SQLite connection and creates
  // the schema — Db.open() -> Promise<void> is part of its public Produces
  // interface specifically so a consumer calls it once at startup. No file in
  // this codebase calls it anywhere else (confirmed via grep across mobile/www).
  // Without this call the module-level `db` in db.js stays null and every other
  // Db.* method (listPendingActions/getAssetById/enqueueAction/...) throws
  // immediately on `db.query`/`db.run`, which breaks every screen including the
  // very first paint (refreshQueueCount() below). Adding the call the brief
  // itself omitted, mirroring how Task 4's own manual-verification steps call
  // `await Db.open();` before any other Db method.
  await Db.open();

  ConnStatus.start();

  const settings = await Settings.get();
  await applyRoleVisibility();
  if (!settings.serverUrl) {
    showScreen('screen-settings');
  } else {
    showScreen('screen-scan');
    await refreshQueueCount();
    Sync.run().then((r) => { refreshQueueCount(); ConnStatus.report(r.pulled, r.needsReauth); });
  }

  document.getElementById('settingsSaveBtn').addEventListener('click', async () => {
    const current = await Settings.get();
    await Settings.set({ serverUrl: document.getElementById('settingsUrl').value, token: current.token, deviceSecret: current.deviceSecret, role: current.role });
    showScreen('screen-scan');
    Sync.run().then((r) => { refreshQueueCount(); ConnStatus.report(r.pulled, r.needsReauth); });
  });

  document.getElementById('scanBtn').addEventListener('click', async () => {
    try {
      const assetId = await Scanner.scanOnce();
      if (!assetId) return; // cancelled or not a warehouse QR
      await openAssetScreen(assetId);
    } catch (error) {
      Toast.show(describeScanError(error, 'Не удалось выполнить сканирование.'), 'error');
    }
  });

  document.getElementById('settingsScanBtn').addEventListener('click', async () => {
    try {
      const result = await Scanner.scanConnectQr();
      if (!result) return; // cancelled
      const { token, role } = await Sync.pair(result.serverUrl, result.code);
      await Settings.set({ serverUrl: result.serverUrl, token, deviceSecret: result.secret, role });
      await applyRoleVisibility();
      document.getElementById('settingsUrl').value = result.serverUrl;
      showScreen('screen-scan');
      Sync.run().then((r) => { refreshQueueCount(); ConnStatus.report(r.pulled, r.needsReauth); });
    } catch (error) {
      Toast.show(describeScanError(error, 'Не удалось выполнить сканирование.'), 'error');
    }
  });

  document.getElementById('navSearchBtn').addEventListener('click', openSearchScreen);
  document.getElementById('navQueueBtn').addEventListener('click', openQueueScreen);
  document.getElementById('navHistoryBtn').addEventListener('click', openHistoryScreen);
  document.getElementById('navInventoryBtn')?.addEventListener('click', openInventoryStartScreen);
  document.getElementById('inventoryStartBtn')?.addEventListener('click', startInventoryScanning);
  document.getElementById('inventoryFinishBtn')?.addEventListener('click', finishInventoryScanning);
  document.getElementById('inventorySubmitBtn')?.addEventListener('click', submitInventoryResult);
  document.getElementById('navSettingsBtn').addEventListener('click', async () => {
    const currentSettings = await Settings.get();
    document.getElementById('settingsUrl').value = currentSettings.serverUrl;
    document.getElementById('appVersionLabel').textContent = `Версия приложения: ${window.APP_VERSION || 'неизвестна'}`;
    const update = describeUpdate(await Db.getStateMeta(), window.APP_VERSION);
    const banner = document.getElementById('updateBanner');
    if (update) {
      document.getElementById('updateBannerText').textContent = update.text;
      document.getElementById('updateBannerUrl').textContent = update.url;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
    showScreen('screen-settings');
  });
  document.getElementById('assetBackBtn').addEventListener('click', () => showScreen('screen-scan'));
  document.getElementById('actionBackBtn').addEventListener('click', () => showScreen('screen-asset'));
  document.getElementById('editBackBtn').addEventListener('click', () => showScreen('screen-asset'));
  document.getElementById('actionForm').addEventListener('submit', submitAction);
  document.getElementById('editForm').addEventListener('submit', submitEdit);

  document.getElementById('editScanSerialBtn').addEventListener('click', async () => {
    try {
      const serial = await Scanner.scanLabelBarcode();
      if (!serial) return; // отменено
      document.getElementById('editSerialNumber').value = serial;
    } catch (error) {
      Toast.show(describeScanError(error, 'Не удалось выполнить сканирование.'), 'error');
    }
  });

  document.getElementById('editPhotoBtn').addEventListener('click', async () => {
    try {
      const parsed = await Scanner.scanLabelPhoto();
      if (!parsed) return; // отменено
      const applied = applyLabelToEditForm(parsed);
      if (!applied) {
        const recognized = [parsed.name, parsed.serialNumber].filter(Boolean).join(' · ');
        Toast.show(recognized
          ? `Распознано: ${recognized}. Поля уже заполнены — очистите нужное поле и повторите, чтобы подставить.`
          : 'Не удалось распознать данные на этикетке — попробуйте снять ближе и при лучшем свете.', 'info');
      }
    } catch (error) {
      Toast.show(describeScanError(error, 'Не удалось распознать этикетку.'), 'error');
    }
  });

  let searchDebounce = null;
  document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => renderSearchResults(e.target.value), 200);
  });

  initSwipeBack();
}

// ─── swipe-right-to-go-back ───────────────────────────────────────
// Drags the active screen out to the right, following the finger; past the
// threshold on release it finishes the exit and swaps to that screen's
// data-back target (same destination its own ‹ Назад button already goes
// to, where it has one), otherwise it snaps back.
function initSwipeBack() {
  let drag = null;

  document.body.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const screen = document.querySelector('.screen:not(.hidden)');
    const backTarget = screen && screen.dataset.back;
    if (!backTarget) return; // this screen has nowhere to go back to
    drag = { startX: e.clientX, startY: e.clientY, screen, backTarget, dragging: false, pointerId: e.pointerId };
  });

  document.body.addEventListener('pointermove', (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.dragging) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; // ignore jitter, let taps through
      if (dx <= 0 || Math.abs(dy) > Math.abs(dx)) { drag = null; return; } // left-swipe or vertical scroll — not a back gesture
      drag.dragging = true;
      document.body.setPointerCapture(e.pointerId);
      drag.screen.style.transition = 'none';
    }
    const clamped = Math.min(Math.max(0, dx), 400);
    drag.screen.style.transform = `translateX(${clamped}px)`;
    drag.screen.style.opacity = String(Math.max(0.3, 1 - clamped / 260));
  });

  function endDrag(e) {
    if (!drag) return;
    if (drag.dragging) {
      const dx = Math.max(0, e.clientX - drag.startX);
      const screen = drag.screen;
      const backTarget = drag.backTarget;
      screen.style.transition = 'transform .18s ease-out, opacity .18s ease-out';
      if (dx > 90) {
        screen.style.transform = 'translateX(100%)';
        screen.style.opacity = '0';
        setTimeout(() => {
          showScreen(backTarget);
          screen.style.transition = 'none';
          screen.style.transform = '';
          screen.style.opacity = '';
        }, 180);
      } else {
        screen.style.transform = 'translateX(0)';
        screen.style.opacity = '1';
        setTimeout(() => { screen.style.transition = ''; }, 180);
      }
    }
    drag = null;
  }
  document.body.addEventListener('pointerup', endDrag);
  document.body.addEventListener('pointercancel', endDrag);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { describeScanError, describeUpdate, reconcileInventory };
}
if (typeof window !== 'undefined') {
  window.App = { init };
}
