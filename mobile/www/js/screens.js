const NAV_SCREEN_MAP = {
  navSearchBtn: 'screen-search',
  navQueueBtn: 'screen-queue',
  navHistoryBtn: 'screen-history',
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
    alert('Этот QR не найден в кэше. Подключитесь к сети склада и повторите синхронизацию.');
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
    name: document.getElementById('editName').value,
    category: document.getElementById('editCategory').value,
    inventoryNumber: document.getElementById('editInventoryNumber').value,
    serialNumber: document.getElementById('editSerialNumber').value,
    location: document.getElementById('editLocation').value,
    purchaseDate: document.getElementById('editPurchaseDate').value,
    warrantyEnd: document.getElementById('editWarrantyEnd').value,
  };
  await Db.enqueueAction(payload);
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
      const statusText = row.status === 'failed' ? `Ошибка: ${row.server_error}` : 'Ждёт отправки';
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
  if (!settings.serverUrl) {
    showScreen('screen-settings');
  } else {
    showScreen('screen-scan');
    await refreshQueueCount();
    Sync.run().then((r) => { refreshQueueCount(); ConnStatus.report(r.pulled, r.needsReauth); });
  }

  document.getElementById('settingsSaveBtn').addEventListener('click', async () => {
    const current = await Settings.get();
    await Settings.set({ serverUrl: document.getElementById('settingsUrl').value, token: current.token, deviceSecret: current.deviceSecret });
    showScreen('screen-scan');
    Sync.run().then((r) => { refreshQueueCount(); ConnStatus.report(r.pulled, r.needsReauth); });
  });

  document.getElementById('scanBtn').addEventListener('click', async () => {
    try {
      const assetId = await Scanner.scanOnce();
      if (!assetId) return; // cancelled or not a warehouse QR
      await openAssetScreen(assetId);
    } catch (error) {
      alert(error && error.message ? error.message : 'Не удалось выполнить сканирование.');
    }
  });

  document.getElementById('settingsScanBtn').addEventListener('click', async () => {
    try {
      const result = await Scanner.scanConnectQr();
      if (!result) return; // cancelled
      const { token } = await Sync.pair(result.serverUrl, result.code);
      await Settings.set({ serverUrl: result.serverUrl, token, deviceSecret: result.secret });
      document.getElementById('settingsUrl').value = result.serverUrl;
      showScreen('screen-scan');
      Sync.run().then((r) => { refreshQueueCount(); ConnStatus.report(r.pulled, r.needsReauth); });
    } catch (error) {
      alert(error && error.message ? error.message : 'Не удалось выполнить сканирование.');
    }
  });

  document.getElementById('navSearchBtn').addEventListener('click', openSearchScreen);
  document.getElementById('navQueueBtn').addEventListener('click', openQueueScreen);
  document.getElementById('navHistoryBtn').addEventListener('click', openHistoryScreen);
  document.getElementById('navSettingsBtn').addEventListener('click', async () => {
    const currentSettings = await Settings.get();
    document.getElementById('settingsUrl').value = currentSettings.serverUrl;
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
      alert(error && error.message ? error.message : 'Не удалось выполнить сканирование.');
    }
  });

  document.getElementById('editPhotoBtn').addEventListener('click', async () => {
    try {
      const parsed = await Scanner.scanLabelPhoto();
      if (!parsed) return; // отменено
      const applied = applyLabelToEditForm(parsed);
      if (!applied) {
        const recognized = [parsed.name, parsed.serialNumber].filter(Boolean).join(' · ');
        alert(recognized
          ? `Распознано: ${recognized}. Поля уже заполнены — очистите нужное поле и повторите, чтобы подставить.`
          : 'Не удалось распознать данные на этикетке — попробуйте снять ближе и при лучшем свете.');
      }
    } catch (error) {
      alert(error && error.message ? error.message : 'Не удалось распознать этикетку.');
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

window.App = { init };
