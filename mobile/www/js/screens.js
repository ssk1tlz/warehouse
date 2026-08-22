function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

let currentAssetId = null;
let currentActionType = null;
let currentEmployees = null;

async function refreshQueueCount() {
  const pending = await Db.listPendingActions();
  document.getElementById('queueCount').textContent = pending.length;
}

async function openAssetScreen(assetId) {
  const asset = await Db.getAssetById(assetId);
  if (!asset) {
    alert('Этот QR не найден в кэше. Подключитесь к сети склада и повторите синхронизацию.');
    return;
  }
  currentAssetId = assetId;
  const employees = await Db.listEmployeesById();
  currentEmployees = employees;
  document.getElementById('assetName').textContent = asset.name;
  document.getElementById('assetStatus').textContent = STATUS_LABELS[getAssetStatus(asset)] || asset.status;
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

  showScreen('screen-asset');
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
  await Db.enqueueAction(payload);
  await refreshQueueCount();
  Sync.run(); // fire-and-forget — succeeds immediately if online, otherwise stays queued
  showScreen('screen-scan');
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
      listEl.appendChild(li);
    }
  }
  showScreen('screen-queue');
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

  const settings = await Settings.get();
  if (!settings.serverUrl) {
    showScreen('screen-settings');
  } else {
    showScreen('screen-scan');
    await refreshQueueCount();
    Sync.run().then(refreshQueueCount);
  }

  document.getElementById('settingsSaveBtn').addEventListener('click', async () => {
    await Settings.set({
      serverUrl: document.getElementById('settingsUrl').value,
      password: document.getElementById('settingsPassword').value,
    });
    showScreen('screen-scan');
    Sync.run().then(refreshQueueCount);
  });

  document.getElementById('scanBtn').addEventListener('click', async () => {
    const assetId = await Scanner.scanOnce();
    if (!assetId) return; // cancelled or not a warehouse QR
    await openAssetScreen(assetId);
  });

  document.getElementById('queueBtn').addEventListener('click', openQueueScreen);
  document.getElementById('settingsBtn').addEventListener('click', async () => {
    const currentSettings = await Settings.get();
    document.getElementById('settingsUrl').value = currentSettings.serverUrl;
    document.getElementById('settingsPassword').value = currentSettings.password;
    showScreen('screen-settings');
  });
  document.getElementById('assetBackBtn').addEventListener('click', () => showScreen('screen-scan'));
  document.getElementById('actionBackBtn').addEventListener('click', () => showScreen('screen-asset'));
  document.getElementById('queueBackBtn').addEventListener('click', () => showScreen('screen-scan'));
  document.getElementById('actionForm').addEventListener('submit', submitAction);
}

window.App = { init };
