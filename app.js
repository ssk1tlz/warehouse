const EMPTY_STATE = {
  meta: { updatedAt: null },
  employees: [],
  departments: [],
  sites: [],
  workplaces: [],
  assets: [],
  movements: [],
  auditLog: [],
  kitTemplates: [],
  currentVersion: "",
  latestVersion: null,
  releaseUrl: null,
  assetCodeTypes: [],
};

const statusLabels = {
  in_stock: "На складе",
  assigned: "Выдано",
  partial: "Частично выдано",
  repair: "В ремонте",
  retired: "Списано",
};

const movementLabels = {
  purchase: "Поступление",
  issue: "Выдача",
  return: "Возврат",
  repair: "Ремонт",
  repair_return: "Возврат из ремонта",
  retire: "Списание",
  edit: "Редактирование",
  delete: "Удаление",
};

const dom = {
  views: document.querySelectorAll(".view"),
  menuLinks: document.querySelectorAll(".menu-link"),
  statsGrid: document.getElementById("statsGrid"),
  recentMovements: document.getElementById("recentMovements"),
  assignedSummary: document.getElementById("assignedSummary"),
  assetsTableBody: document.getElementById("assetsTableBody"),
  movementsTableBody: document.getElementById("movementsTableBody"),
  inStockReport: document.getElementById("inStockReport"),
  employeeBalanceReport: document.getElementById("employeeBalanceReport"),
  modalOverlay: document.getElementById("modalOverlay"),
  lastUpdateLabel: document.getElementById("lastUpdateLabel"),
  assetForm: document.getElementById("assetForm"),
  assetFormTitle: document.getElementById("assetFormTitle"),
  assetSubmitBtn: document.getElementById("assetSubmitBtn"),
  assetCancelBtn: document.getElementById("assetCancelBtn"),
  employeeForm: document.getElementById("employeeForm"),
  employeeFormTitle: document.getElementById("employeeModalTitle"),
  employeeSubmitBtn: document.getElementById("employeeSubmitBtn"),
  employeeCancelBtn: document.getElementById("employeeModalCancelBtn"),
  employeesTableBody: document.getElementById("employeesTableBody"),
  employeesCardsGrid: document.getElementById("employeesCardsGrid"),
  manualActForm: document.getElementById("manualActForm"),
  manualActTypeSelect: document.getElementById("manualActTypeSelect"),
  manualActEmployeeSelect: document.getElementById("manualActEmployeeSelect"),
  manualActItems: document.getElementById("manualActItems"),
  addManualActItemBtn: document.getElementById("addManualActItemBtn"),
  issueForm: document.getElementById("issueForm"),
  returnForm: document.getElementById("returnForm"),
  repairForm: document.getElementById("repairForm"),
  repairReturnForm: document.getElementById("repairReturnForm"),
  retireForm: document.getElementById("retireForm"),
  issueItems: document.getElementById("issueItems"),
  addIssueItemBtn: document.getElementById("addIssueItemBtn"),
  issueEmployeeSelect: document.getElementById("issueEmployeeSelect"),
  returnItems: document.getElementById("returnItems"),
  addReturnItemBtn: document.getElementById("addReturnItemBtn"),
  returnEmployeeSelect: document.getElementById("returnEmployeeSelect"),
  repairSourceSelect: document.getElementById("repairSourceSelect"),
  repairAssetSelect: document.getElementById("repairAssetSelect"),
  repairReturnTargetSelect: document.getElementById("repairReturnTargetSelect"),
  repairReturnAssetSelect: document.getElementById("repairReturnAssetSelect"),
  retireAssetSelect: document.getElementById("retireAssetSelect"),
  exportDataBtn: document.getElementById("exportDataBtn"),
  exportExcelBtn: document.getElementById("exportExcelBtn"),
  importDataInput: document.getElementById("importDataInput"),
  dashboardSearchInput: document.getElementById("dashboardSearchInput"),
  assetSearchInput: document.getElementById("assetSearchInput"),
  employeeSearchInput: document.getElementById("employeeSearchInput"),
  movementSearchInput: document.getElementById("movementSearchInput"),
  reportSearchInput: document.getElementById("reportSearchInput"),
  emptyStateTemplate: document.getElementById("emptyStateTemplate"),
};

// ─── АУТЕНТИФИКАЦИЯ ─────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const token = localStorage.getItem("authToken");
  const headers = Object.assign({}, options.headers, token ? { Authorization: `Bearer ${token}` } : {});
  const response = await fetch(path, Object.assign({}, options, { headers }));
  if (response.status === 401) {
    localStorage.removeItem("authToken");
    localStorage.removeItem("userRole");
    showAuthOverlay("login");
    const error = new Error("Сессия истекла — войдите снова.");
    error.sessionExpired = true;
    throw error;
  }
  return response;
}

function showAuthOverlay(mode) {
  const overlay = document.getElementById("authOverlay");
  document.getElementById("authOverlayTitle").textContent =
    mode === "setup" ? "Создание администратора" : "Вход";
  document.getElementById("authSubmitBtn").textContent = mode === "setup" ? "Создать" : "Войти";
  overlay.dataset.mode = mode;
  overlay.classList.remove("hidden");
  // authOverlay shares the same z-index as every other standalone overlay
  // (modal-overlay/confirm-overlay), so a token expiring while one of those
  // is open could otherwise paint on top of the forced-relogin screen.
  // Force every other overlay closed so the login/setup screen always wins.
  document.querySelectorAll(".modal-overlay, .confirm-overlay").forEach((el) => {
    if (el !== overlay) el.classList.add("hidden");
  });
}

function hideAuthOverlay() {
  document.getElementById("authOverlay").classList.add("hidden");
}

async function ensureAuthenticated() {
  const status = await fetch("/api/setup-status").then((r) => r.json()).catch(() => ({ needsSetup: false }));
  if (status.needsSetup) {
    showAuthOverlay("setup");
    return false;
  }
  if (!localStorage.getItem("authToken")) {
    showAuthOverlay("login");
    return false;
  }
  // #authOverlay is visible by default in index.html, so an already-authenticated
  // session reloading the page would otherwise stare at the login screen forever.
  hideAuthOverlay();
  return true;
}

function bindAuthEvents() {
  document.getElementById("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const mode = document.getElementById("authOverlay").dataset.mode;
    const username = document.getElementById("authUsername").value.trim();
    const password = document.getElementById("authPassword").value;
    const path = mode === "setup" ? "/api/setup" : "/api/login";
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json().catch(() => ({}));
    const errorEl = document.getElementById("authError");
    if (!response.ok) {
      errorEl.textContent = data.error || "Не удалось войти.";
      errorEl.classList.remove("hidden");
      return;
    }
    errorEl.classList.add("hidden");
    localStorage.setItem("authToken", data.token);
    localStorage.setItem("userRole", data.role);
    hideAuthOverlay();
    document.getElementById("authForm").reset();
    await boot();
  });
}

async function handleLogout() {
  try {
    await apiFetch("/api/logout", { method: "POST" });
  } catch (error) {
    // A 401 means the session was already gone — apiFetch has cleared the token
    // and shown the login overlay, which is exactly where we were heading.
    // Any other failure (server down) still must not trap the user in a
    // session they asked to end: fall through and clear locally.
    if (error.sessionExpired) return;
    console.error(error);
  }
  localStorage.removeItem("authToken");
  localStorage.removeItem("userRole");
  showAuthOverlay("login");
}

function applyRoleVisibility() {
  const role = localStorage.getItem("userRole");
  document.querySelectorAll("[data-requires-role]").forEach((el) => {
    const allowed = el.dataset.requiresRole.split(",");
    el.classList.toggle("hidden", !allowed.includes(role));
  });
}

const VIEW_RENDERERS = {
  dashboard: () => { renderStats(); renderAttentionPanel(); renderCharts(); renderRecentMovements(); renderAssignedSummary(); },
  inventory: () => { renderAssetsTable(); },
  employees: () => { renderEmployees(); },
  departments: () => { renderDepartments(); },
  sites: () => { renderSites(); },
  workplaces: () => { renderWorkplaces(); },
  movements: () => { renderMovementTable(); renderKitTemplates(); },
  reports: () => { renderReports(); },
  registry: () => { renderRegistry(); },
};

let state = createEmptyState();

let _employeeMap = new Map();
let _assetMap = new Map();
let assetCurrentPage = 1;
const ASSETS_PER_PAGE = 20;
let registryCurrentPage = 1;
let registryPerPage = 20;

// ─── TOAST SYSTEM ─────────────────────────────────────────────
// `action` (optional): { kind, label, onClick } — renders a button and keeps
// the toast on screen (no auto-dismiss) until clicked, instead of the usual
// 3.6s fade. Used for retryable errors where losing the message would hide
// that something still needs the user's attention (e.g. an unsaved save).
function showToast(message, type = 'info', action = null) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  if (action) {
    container.querySelectorAll(`.toast[data-kind="${action.kind}"]`).forEach((el) => el.remove());
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}${action ? ' persistent' : ''}`;
  toast.textContent = message;
  if (action) {
    toast.dataset.kind = action.kind;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { toast.remove(); action.onClick(); });
    toast.appendChild(btn);
  } else {
    setTimeout(() => toast.remove(), 3600);
  }
  container.appendChild(toast);
}

// ─── CONFIRM DIALOG ──────────────────────────────────────────
function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirmOverlay');
    const msg = document.getElementById('confirmMessage');
    const yesBtn = document.getElementById('confirmYes');
    const noBtn = document.getElementById('confirmNo');
    if (!overlay) { resolve(confirm(message)); return; }
    msg.textContent = message;
    overlay.classList.remove('hidden');
    const cleanup = () => { overlay.classList.add('hidden'); yesBtn.replaceWith(yesBtn.cloneNode(true)); noBtn.replaceWith(noBtn.cloneNode(true)); };
    document.getElementById('confirmYes').addEventListener('click', () => { cleanup(); resolve(true); });
    document.getElementById('confirmNo').addEventListener('click', () => { cleanup(); resolve(false); });
  });
}

// ─── STATE, УТИЛИТЫ И НОРМАЛИЗАЦИЯ ─────────────────────────────
function rebuildLookupMaps() {
  _employeeMap = new Map(state.employees.map(e => [e.id, e]));
  _assetMap = new Map(state.assets.map(a => [a.id, a]));
}

// Формат `<prefix>_<timestamp>_<rand>`. Для движений (`mov_...`) это ещё и
// контракт с AssetOps.movementSortValue/movementCreatedAt в asset_ops.js —
// они разбирают этот id, чтобы дать записям без даты разумный порядок и
// подпись создания. Меняя формат, проверьте эти функции (тот же формат
// отдельно минтит _new_movement_id в mobile_actions.py).
function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(date) {
  if (!date) return "Неизвестно";
  return new Intl.DateTimeFormat("ru-RU").format(new Date(date));
}

// Ключ для сортировки по дате. Пустая дата — законное значение
// ("неизвестно", галочка в форме), а `new Date("")` даёт NaN, из-за
// которого компаратор возвращает NaN и сортировка молча перестаёт
// упорядочивать соседние элементы. Записи без даты считаем самыми
// старыми: при сортировке "новые сверху" они уходят вниз.
function dateSortKey(date) {
  const time = date ? new Date(date).getTime() : NaN;
  return Number.isNaN(time) ? -Infinity : time;
}

// Подпись даты для строки движения. Если дата неизвестна, но у записи
// разборчивый id, показываем момент создания — иначе несколько таких
// строк подряд (частый случай: «Выдать сразу» без указанной даты)
// читаются как один и тот же необъяснённый провал, хотя они появились в
// разное время и именно поэтому так упорядочены (см. AssetOps.movementSortValue).
function movementDateLabel(movement) {
  if (movement.date) return formatDate(movement.date);
  const createdAt = AssetOps.movementCreatedAt(movement);
  return createdAt === null ? "Неизвестно" : `Неизвестно (запись от ${formatDate(new Date(createdAt).toISOString())})`;
}

function debounce(fn, ms = 200) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function normalizeSearchValue(value) {
  return String(value || "").trim().toLowerCase();
}

function matchesSearch(query, ...values) {
  if (!query) return true;
  return values.some((value) => normalizeSearchValue(value).includes(query));
}

function normalizeAsset(asset) {
  return {
    id: asset.id || createId("asset"),
    name: asset.name || "Без названия",
    category: asset.category || "Без категории",
    inventoryNumber: asset.inventoryNumber || "",
    serialNumber: asset.serialNumber || "Отсутствует",
    purchaseDate: asset.purchaseDate || "",
    status: asset.status || "in_stock",
    notes: asset.notes || "",
    quantity: Math.max(1, Number(asset.quantity || 1)),
    repairQuantity: Math.max(0, Number(asset.repairQuantity || 0)),
    retiredQuantity: Math.max(0, Number(asset.retiredQuantity || 0)),
    minQuantity: Math.max(0, Number(asset.minQuantity || 0)),
    warrantyEnd: asset.warrantyEnd || "",
    // Напоминание о гарантии снято вручную. Хранится отдельно от даты
    // (server.py, миграция 032) именно для того, чтобы в реестре
    // осталась настоящая дата окончания, а не пустое «Неизвестно».
    warrantyReminderOff: Boolean(asset.warrantyReminderOff),
    price: Math.max(0, Number(asset.price || 0)),
    repairDate: asset.repairDate || "",
    location: asset.location || "",
    photoUrl: asset.photoUrl || "",
    // rev is server-owned (bumped by server.py whenever a save changes
    // core fields) and arrives on every asset in GET /api/state — kept
    // here so the photo preview's cache-busting query param survives a
    // page reload instead of resetting to 0 every time.
    rev: asset.rev || 0,
    labelPrintedAt: asset.labelPrintedAt || null,
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
      : [],
  };
}

function createEmptyState() {
  return JSON.parse(JSON.stringify(EMPTY_STATE));
}

function hydrateState(parsed) {
  return {
    meta: parsed.meta || { updatedAt: null },
    employees: (parsed.employees || []).map((entry) => ({
      id: entry.id,
      fullName: entry.fullName || "",
      department: entry.department || "",
      site: entry.site || "",
      position: entry.position || "",
      email: entry.email || "",
      phone: entry.phone || "",
      status: entry.status || "active",
      createdAt: entry.createdAt || "",
    })),
    departments: (parsed.departments || []).map((entry) => ({
      id: entry.id,
      name: entry.name || "",
    })),
    sites: (parsed.sites || []).map((entry) => ({
      id: entry.id,
      name: entry.name || "",
    })),
    workplaces: (parsed.workplaces || []).map((entry) => ({
      id: entry.id,
      name: entry.name || "",
      employeeId: entry.employeeId || null,
      site: entry.site || "",
      notes: entry.notes || "",
    })),
    assets: Array.isArray(parsed.assets) ? parsed.assets.map(normalizeAsset) : [],
    movements: Array.isArray(parsed.movements) ? parsed.movements : [],
    auditLog: parsed.auditLog || [],
    kitTemplates: parsed.kitTemplates || [],
    currentVersion: parsed.currentVersion || "",
    latestVersion: parsed.latestVersion || null,
    releaseUrl: parsed.releaseUrl || null,
    activeInventorySession: parsed.activeInventorySession || null,
    attentionItems: Array.isArray(parsed.attentionItems) ? parsed.attentionItems : [],
    // Справочник обозначений техники — приезжает с сервера, здесь только
    // читается. Правила живут в asset_codes.py, чтобы миграция
    // перенумерации и форма считали префикс одинаково.
    assetCodeTypes: Array.isArray(parsed.assetCodeTypes) ? parsed.assetCodeTypes : [],
  };
}

// ─── AUDIT LOG ──────────────────────────────────────────────────
function addAuditEntry(entityType, entityId, action, changes = {}) {
  state.auditLog.unshift({
    entityType,
    entityId,
    action,
    changes,
    timestamp: new Date().toISOString(),
  });
}

// ─── ЗАГРУЗКА И СОХРАНЕНИЕ СОСТОЯНИЯ (сервер) ──────────────────
async function loadState() {
  const response = await apiFetch("/api/state");
  if (!response.ok) throw new Error(`Не удалось загрузить данные: ${response.status}`);
  return hydrateState(await response.json());
}

async function saveState() {
  state.meta.updatedAt = new Date().toISOString();
  const response = await apiFetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  if (response.status === 409) {
    // Кто-то сохранил данные раньше нас (другая вкладка/окно):
    // принимаем актуальное состояние с сервера, локальное изменение отбрасываем.
    const data = await response.json().catch(() => ({}));
    if (data.state) {
      state = hydrateState(data.state);
      rebuildLookupMaps();
      renderUpdateBanner();
      render();
    }
    const error = new Error(data.error || "Данные были изменены в другом окне.");
    error.conflict = true;
    throw error;
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const error = new Error(err.error || `Не удалось сохранить данные: ${response.status}`);
    error.validation = response.status === 400;
    throw error;
  }
  state = hydrateState(await response.json());
  rebuildLookupMaps();
  renderUpdateBanner();
  render();
}

async function reloadFromServer() {
  try {
    state = await loadState();
    rebuildLookupMaps();
    renderUpdateBanner();
    render();
  } catch (error) {
    console.error(error);
  }
}

// ─── ГЕТТЕРЫ И РАСЧЁТ ОСТАТКОВ ──────────────────────────────────
function getEmployeeById(id) { return _employeeMap.get(id) || null; }

// ФИО сотрудника для этикетки (§6 ТЗ). null, если техника не закреплена
// ровно за одним сотрудником — тогда строка на этикетке не печатается.
function getAssetEmployeeName(asset) {
  const employeeId = AssetOps.singleEmployeeId(asset.allocations);
  if (!employeeId) return null;
  const employee = getEmployeeById(employeeId);
  return employee ? employee.fullName : null;
}

function getAssetById(id) { return _assetMap.get(id) || null; }

function getAllocatedQuantity(asset) {
  return asset.allocations.reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
}

function getAvailableQuantity(asset) {
  return Math.max(0, Number(asset.quantity || 0) - getAllocatedQuantity(asset) - Number(asset.repairQuantity || 0));
}

// ─── ПРЕВЬЮ ФОТО АКТИВА ───────────────────────────────────────
// Holds the object URL for whatever photo is currently shown, so it can be
// revoked before the next one is created (avoids leaking blob: URLs as the
// user opens/edits different assets).
let assetPhotoObjectUrl = null;
// Monotonic call counter, so a call whose async photo GET resolves after a
// *newer* call has already taken over the preview (e.g. the user clicks
// Edit on asset A, then Edit on asset B before A's fetch finishes) can tell
// its response is stale and bail — instead of clobbering B's already-shown
// photo/object URL with A's late-arriving one.
let assetPhotoRenderToken = 0;

async function renderAssetPhotoPreview(asset) {
  const myToken = ++assetPhotoRenderToken;
  const img = document.getElementById("assetPhotoImg");
  const placeholder = document.getElementById("assetPhotoPlaceholder");
  const uploadBtn = document.getElementById("assetPhotoUploadBtn");
  const fileInput = document.getElementById("assetPhotoFileInput");
  if (!img || !placeholder || !uploadBtn || !fileInput) return;

  // This call now owns the preview: reset to placeholder immediately (not
  // gated on the token — this is synchronous, current DOM state, not a
  // stale async continuation) and revoke whatever object URL was showing.
  // Safe even if that URL belongs to an older in-flight call: that call's
  // continuation below bails via the token check before it could ever
  // touch assetPhotoObjectUrl or the DOM again.
  if (assetPhotoObjectUrl) {
    URL.revokeObjectURL(assetPhotoObjectUrl);
    assetPhotoObjectUrl = null;
  }
  img.classList.add("hidden");
  img.removeAttribute("src");
  placeholder.classList.remove("hidden");

  // A brand-new, not-yet-saved asset form has asset.id === "" — the upload
  // endpoint is /api/assets/<id>/photo, so uploading before the asset has
  // ever been saved (and thus has a real id) would silently 404. Disable
  // the button rather than let that happen.
  uploadBtn.disabled = !asset.id;
  uploadBtn.title = asset.id ? "" : "Сначала сохраните позицию";

  uploadBtn.onclick = () => fileInput.click();
  fileInput.onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const bytes = await file.arrayBuffer();
    try {
      const response = await apiFetch(`/api/assets/${asset.id}/photo`, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: bytes,
      });
      fileInput.value = "";
      if (response.ok) {
        showToast("Фото загружено.", "info");
        asset.photoUrl = `uploads/${asset.id}.jpg`;
        asset.rev = (asset.rev || 0) + 1; // локальный кэш-бастинг; реальный rev подтянется на следующем /api/state
        renderAssetPhotoPreview(asset);
      } else {
        showToast("Не удалось загрузить фото.", "error");
      }
    } catch (error) {
      console.error(error);
      fileInput.value = "";
      showToast("Не удалось загрузить фото — нет связи с сервером.", "error");
    }
  };

  if (asset.id) {
    try {
      // Deliberately NOT gated on asset.photoUrl: that's the client's
      // already-loaded (possibly stale) copy of state, which never changes
      // just because a photo was uploaded from elsewhere (e.g. a phone) —
      // the desktop only calls loadState() at boot/re-auth, it doesn't
      // poll. Always attempt the GET when the card is opened, so a photo
      // uploaded elsewhere shows up the next time this asset's card is
      // opened, not only after a full app reload. A 404 (genuinely no
      // photo) already renders correctly as "Нет фото" below.
      //
      // GET /api/assets/<id>/photo requires the same Bearer-token auth as
      // every other /api/ route, so a plain <img src="..."> would get a
      // 401 — a browser never attaches localStorage's token to an <img>
      // request. Fetch the bytes through apiFetch (which does add it) and
      // hand the <img> an object URL instead — same pattern already used
      // for the .docx act download (see downloadActDocx()'s apiFetch("/api/act")).
      const response = await apiFetch(`/api/assets/${asset.id}/photo?v=${asset.rev || 0}`);
      const blob = response.ok ? await response.blob() : null;
      // A newer call may have started (and possibly already finished)
      // while the two awaits above were in flight. If so, this response is
      // stale: discard it without touching the DOM or assetPhotoObjectUrl,
      // so it can never overwrite whatever the newer call has shown.
      if (myToken !== assetPhotoRenderToken) return;
      if (blob) {
        assetPhotoObjectUrl = URL.createObjectURL(blob);
        img.src = assetPhotoObjectUrl;
        img.classList.remove("hidden");
        placeholder.classList.add("hidden");
      }
    } catch (error) {
      console.error(error);
    }
  }
}

function getActiveEmployees(employees) {
  return employees.filter((e) => (e.status || "active") !== "inactive" && e.status !== "deleted");
}

// Сотрудники, кроме мягко удалённых (status === "deleted") — для реестра,
// счётчиков, экспортов и любых списков выбора. Мягко удалённый сотрудник
// остаётся в state.employees (и в _employeeMap — см. rebuildLookupMaps),
// чтобы старые движения (getEmployeeById) продолжали показывать его имя
// в истории, но пропадает из всего, что перечисляет живых людей. Удалять
// саму запись нельзя: движения по нему (выдачи, возвраты) хранят его
// employeeId, а сервер держит внешний ключ movements.employee_id →
// employees.id — стереть строку означало бы либо потерять историю
// (старое поведение deleteEmployee), либо сломать сохранение по FK.
function getVisibleEmployees(employees) {
  return employees.filter((e) => e.status !== "deleted");
}

function getEmployeeAllocation(asset, employeeId) {
  return asset.allocations.find((entry) => entry.employeeId === employeeId && !entry.department) || null;
}

function getDepartmentAllocation(asset, department) {
  if (!department) return null;
  return asset.allocations.find((entry) => !entry.employeeId && !entry.site && entry.department === department) || null;
}

function getSiteAllocation(asset, site) {
  if (!site) return null;
  return asset.allocations.find((entry) => !entry.employeeId && !entry.department && entry.site === site) || null;
}

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

function getUniqueDepartments() {
  const set = new Set();
  state.employees.forEach((e) => { if (e.department) set.add(e.department); });
  state.assets.forEach((a) => a.allocations.forEach((al) => { if (al.department) set.add(al.department); }));
  state.movements.forEach((m) => { if (m.department) set.add(m.department); });
  return [...set].sort();
}

function parseLocationValue(value) {
  const raw = String(value || "");
  if (!raw || raw === "warehouse") return { type: "warehouse", employeeId: null };
  if (raw.startsWith("employee:")) return { type: "employee", employeeId: raw.slice(9) || null };
  return { type: "warehouse", employeeId: null };
}

function getLocationLabel(value) {
  const location = parseLocationValue(value);
  if (location.type === "warehouse") return "Склад";
  const employee = getEmployeeById(location.employeeId);
  return employee ? employee.fullName : "Неизвестный сотрудник";
}

function getAssetStatus(asset) {
  if (asset.status === "repair" || asset.status === "retired") return asset.status;
  const allocated = getAllocatedQuantity(asset);
  const repair = Number(asset.repairQuantity || 0);
  if (asset.quantity <= 0 && Number(asset.retiredQuantity || 0) > 0) return "retired";
  if (repair > 0 && allocated <= 0 && getAvailableQuantity(asset) <= 0) return "repair";
  if (allocated <= 0) return "in_stock";
  if (allocated >= asset.quantity) return "assigned";
  return "partial";
}

function normalizeAssetField(value) {
  return String(value || "").trim().toLowerCase();
}

function assetMatchKey(name, category) {
  return `${normalizeAssetField(name)}||${normalizeAssetField(category)}`;
}

function findDuplicateAsset(name, category, serialNumber, excludeId = "") {
  const key = assetMatchKey(name, category);
  const normalizedSerial = normalizeAssetField(serialNumber);
  return state.assets.find((asset) => {
    if (asset.id === excludeId || assetMatchKey(asset.name, asset.category) !== key) return false;
    const assetSerial = normalizeAssetField(asset.serialNumber);
    if (!normalizedSerial && !assetSerial) return true;
    return assetSerial === normalizedSerial;
  }) || null;
}

function getAssetHolderText(asset) {
  if (!asset.allocations.length) return "Склад";
  return asset.allocations
    .map((entry) => `${allocationLabel(entry)} (${entry.quantity})`)
    .join(", ");
}

function assetShortLabel(asset) {
  const serialPart = asset?.serialNumber ? ` · S/N: ${asset.serialNumber}` : " · S/N: -";
  return `${asset?.name || "Без названия"}${serialPart}`;
}

// ─── ФОРМЫ: СБРОС И АВТОЗАПОЛНЕНИЕ ──────────────────────────────
function appendEmptyState(container) {
  container.innerHTML = "";
  container.appendChild(dom.emptyStateTemplate.content.cloneNode(true));
}

// Тон статуса: выдано/частично — предупреждение, ремонт/списание —
// тревога, остальное спокойно. Одно определение на чип в таблице и на
// точку в форме, чтобы цвета не разъехались.
function statusTone(status) {
  if (status === "assigned" || status === "partial") return "warn";
  if (status === "repair" || status === "retired") return "danger";
  return "ok";
}

function syncAssetStatusDot() {
  const dot = document.getElementById("assetStatusDot");
  const select = document.getElementById("assetStatusSelect");
  if (!dot || !select) return;
  dot.className = `status-dot ${statusTone(select.value)}`;
}

function statusChip(status) {
  return `<span class="chip ${statusTone(status)}">${statusLabels[status] || status}</span>`;
}

function setDefaultDates() {
  [dom.assetForm.elements.purchaseDate, dom.manualActForm?.elements.date, dom.issueForm.elements.date, dom.returnForm.elements.date, dom.repairForm.elements.date, dom.repairReturnForm.elements.date, dom.retireForm.elements.date].forEach((field) => {
    if (field && !field.value) field.value = today();
  });
}

// Инвентарный номер имеет вид ПРЕФИКС-NNNN: буквы говорят, что это за
// техника, четыре цифры — сквозной номер по всему складу, общий для всех
// типов. Ноутбук, добавленный после MON-0050, получает NB-0051.
//
// Номер, посчитанный здесь, окончательный, а не предварительный:
// сохранение состояния проверяет base_version на сервере, так что если
// кто-то занял номер, пока форма была открыта, придёт 409 и данные
// перезагрузятся вместо записи поверх.
function suggestedInventoryNumber() {
  const form = dom.assetForm;
  return AssetCodes.buildInventoryNumber(
    state.assetCodeTypes,
    state.assets.map((asset) => asset.inventoryNumber),
    form.elements.category.value,
    form.elements.name.value,
  );
}

// Пока номер сгенерирован автоматически, он пересчитывается на каждый
// ввод в "Категорию" и "Наименование". Как только пользователь правит
// само поле номера, отметка снимается (см. обработчик input в
// setupEventListeners) и приложение в поле больше не пишет.
function isInventoryNumberAutoFilled(input) {
  return input.dataset.autoGenerated === input.value;
}

function markInventoryNumberAutoFilled(input) {
  input.dataset.autoGenerated = input.value;
}

function refreshInventoryNumber() {
  const input = dom.assetForm.elements.inventoryNumber;
  if (!input) return;
  // В режиме редактирования номер не трогаем: он напечатан на этикетке и
  // менять его вслед за категорией нельзя.
  if (dom.assetForm.elements.assetId.value !== "") return;
  if (input.value && !isInventoryNumberAutoFilled(input)) return;
  input.value = suggestedInventoryNumber();
  markInventoryNumberAutoFilled(input);
  updateInventoryHint();
}

function updateInventoryHint() {
  const input = dom.assetForm.elements.inventoryNumber;
  const hint = document.getElementById("inventoryNumberHint");
  const autoBtn = document.getElementById("autoInventoryBtn");
  if (!input || !hint) return;
  const isEditMode = dom.assetForm.elements.assetId.value !== "";
  if (autoBtn) autoBtn.style.display = isEditMode ? "none" : "block";
  if (isEditMode) {
    hint.style.display = "none";
    return;
  }
  const prefix = (input.value.match(/^([A-Za-z]+)-\d+$/) || [])[1];
  const type = prefix
    ? (state.assetCodeTypes || []).find((entry) => entry.prefix === prefix.toUpperCase())
    : null;
  hint.innerHTML = type
    ? `Обозначение <strong>${escapeHtml(type.prefix)}</strong> — ${escapeHtml(type.label)}. Номер сквозной по всей технике.`
    : "Номер подставится сам, как только будет заполнена категория или наименование.";
  hint.style.display = "block";
}

// Кнопка 📋: перезаписывает номер и снова включает автоматический режим,
// даже если поле правили руками.
function autoFillInventoryNumber() {
  const input = dom.assetForm.elements.inventoryNumber;
  if (!input) return;
  input.value = suggestedInventoryNumber();
  markInventoryNumberAutoFilled(input);
  updateInventoryHint();
}

// ─── ДАТЫ «НЕИЗВЕСТНО» ──────────────────────────────────────────
// Галочка — двустороннее отражение того, что поле даты пустое:
// поставили галочку — поле очистилось; начали вводить — галочка снялась.
// Отдельного признака «точно неизвестно» в базе нет, пустая дата и есть
// неизвестная, и показывается она как «Неизвестно» (см. formatDate).
//
// Поле НЕ блокируется при включённой галочке — иначе в него нельзя было
// бы начать вводить дату, а именно ввод её и снимает.
function bindUnknownDateToggle(dateInput) {
  const checkbox = document.getElementById(dateInput.dataset.unknownToggle);
  if (!checkbox) return;

  checkbox.addEventListener("change", () => {
    if (checkbox.checked) dateInput.value = "";
  });

  // Снимаем галочку по самому событию ввода, а не по появлению значения:
  // input type="date" держит value пустым, пока дата не введена целиком,
  // и галочка провисела бы до последней цифры.
  dateInput.addEventListener("input", () => {
    if (checkbox.checked) checkbox.checked = false;
  });

  // Ввод закончен (или поле очищено) — сверяем галочку с фактом.
  dateInput.addEventListener("change", () => {
    checkbox.checked = !dateInput.value;
  });
}

function setUnknownDate(dateInput, unknown) {
  const checkbox = document.getElementById(dateInput.dataset.unknownToggle);
  if (unknown) dateInput.value = "";
  if (checkbox) checkbox.checked = unknown;
}

// ─── ВЫДАЧА ПРЯМО ИЗ ФОРМЫ ДОБАВЛЕНИЯ ───────────────────────────
function getAssetIssueTarget() {
  return document.querySelector('input[name="assetIssueTarget"]:checked')?.value || "employee";
}

function isAssetIssueEnabled() {
  // При редактировании карточки секция скрыта, но галочка могла остаться
  // включённой с прошлого добавления — проверяем и её, и режим формы.
  return Boolean(document.getElementById("assetIssueNow")?.checked)
    && dom.assetForm.elements.assetId.value === "";
}

// Первым пунктом идёт заглушка с пустым значением, а не первый сотрудник
// из списка. В окне выдачи браузер выбирает первого сам, но там человек
// пришёл именно выдавать; здесь же выдача — необязательная галочка сбоку
// от заведения техники, и молча подставленный первый из 133 сотрудников
// означал бы выдачу не тому. Пустое значение ловится проверкой в
// readAssetIssueRequest.
function fillIssueSelect(select, placeholder, options) {
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">${placeholder}</option>` + options.join("");
  select.value = current;
}

function renderAssetIssueSelects() {
  fillIssueSelect(
    document.getElementById("assetIssueEmployeeSelect"),
    "— выберите сотрудника —",
    getActiveEmployees(state.employees).map((employee) =>
      `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.fullName)}${employee.department ? ` — ${escapeHtml(employee.department)}` : ""}</option>`),
  );
  fillIssueSelect(
    document.getElementById("assetIssueDepartmentSelect"),
    "— выберите отдел —",
    state.departments.map((department) =>
      `<option value="${escapeHtml(department.name)}">${escapeHtml(department.name)}</option>`),
  );
  fillIssueSelect(
    document.getElementById("assetIssueSiteSelect"),
    "— выберите объект —",
    state.sites.map((site) => `<option value="${escapeHtml(site.name)}">${escapeHtml(site.name)}</option>`),
  );
}

function syncAssetIssueFields() {
  const enabled = Boolean(document.getElementById("assetIssueNow")?.checked);
  document.getElementById("assetIssueFields")?.classList.toggle("hidden", !enabled);
  // Класс, а не CSS :has() — приложение открывают и из встроенного окна
  // .exe, где движок может оказаться старее поддержки :has().
  document.getElementById("assetIssueSection")?.classList.toggle("is-on", enabled);
  if (!enabled) return;
  const target = getAssetIssueTarget();
  document.getElementById("assetIssueEmployeeField")?.classList.toggle("hidden", target !== "employee");
  document.getElementById("assetIssueDepartmentField")?.classList.toggle("hidden", target !== "department");
  document.getElementById("assetIssueSiteField")?.classList.toggle("hidden", target !== "site");
  document.getElementById("assetIssueWorkplaceField")?.classList.toggle("hidden", target !== "workplace");
  renderAssetIssueSelects();
}

// Количество к выдаче по умолчанию равно всему, что заводится: чаще
// всего технику заводят и сразу отдают целиком. Подставляем только пока
// поле не тронули руками — тем же приёмом, что и инвентарный номер.
function syncAssetIssueQuantity() {
  const input = document.getElementById("assetIssueQuantity");
  if (!input) return;
  if (input.value && input.dataset.autoFilled !== input.value) return;
  input.value = String(Math.max(1, Number(dom.assetForm.elements.quantity.value || 1)));
  input.dataset.autoFilled = input.value;
}

function resetAssetIssueBlock() {
  const toggle = document.getElementById("assetIssueNow");
  if (toggle) toggle.checked = false;
  const employeeRadio = document.querySelector('input[name="assetIssueTarget"][value="employee"]');
  if (employeeRadio) employeeRadio.checked = true;
  const quantity = document.getElementById("assetIssueQuantity");
  if (quantity) {
    // Оставляем поле ПУСТЫМ и снимаем метку: заполнит его
    // syncAssetIssueQuantity ниже, она же поставит метку. Если записать
    // сюда "1" и метку снять, защита от перезаписи ручного ввода примет
    // единицу за правку пользователя и подстановка перестанет работать.
    quantity.value = "";
    delete quantity.dataset.autoFilled;
  }
  const dateInput = document.getElementById("assetIssueDate");
  // Дата выдачи по умолчанию неизвестна: техника нередко заводится
  // задним числом, когда дату выдачи уже не восстановить.
  if (dateInput) setUnknownDate(dateInput, true);
  const notesInput = document.getElementById("assetIssueNotes");
  if (notesInput) notesInput.value = "";
  syncAssetIssueFields();
  syncAssetIssueQuantity();
}

/**
 * Читает блок «Выдать сразу». Возвращает null, если выдача выключена,
 * или объект с получателем; при ошибке показывает тост и возвращает
 * строку "invalid", чтобы вызывающий прервал сохранение.
 */
function readAssetIssueRequest(addedQuantity) {
  if (!isAssetIssueEnabled()) return null;
  const target = getAssetIssueTarget();
  const employeeId = target === "employee" ? String(document.getElementById("assetIssueEmployeeSelect")?.value || "") : "";
  const department = target === "department" ? String(document.getElementById("assetIssueDepartmentSelect")?.value || "").trim() : "";
  const site = target === "site" ? String(document.getElementById("assetIssueSiteSelect")?.value || "").trim() : "";
  const workplaceId = target === "workplace" ? String(document.getElementById("assetIssueWorkplaceSelect")?.value || "") : "";
  if (target === "employee" && !employeeId) {
    showToast("Выберите сотрудника для выдачи.", "warning");
    return "invalid";
  }
  if (target === "department" && !department) {
    showToast("Выберите отдел для выдачи.", "warning");
    return "invalid";
  }
  if (target === "site" && !site) {
    showToast("Выберите объект для выдачи.", "warning");
    return "invalid";
  }
  if (target === "workplace" && !workplaceId) {
    showToast("Выберите рабочее место для выдачи.", "warning");
    return "invalid";
  }
  const quantity = Math.max(1, Number(document.getElementById("assetIssueQuantity")?.value || 1));
  if (quantity > addedQuantity) {
    showToast(`Нельзя выдать ${quantity} шт.: добавляется ${addedQuantity}.`, "warning");
    return "invalid";
  }
  return {
    employeeId,
    department,
    site,
    workplaceId,
    notes: String(document.getElementById("assetIssueNotes")?.value || "").trim(),
    quantity,
    // Пустая дата — законное «неизвестно»: в акте вместо дня, месяца и
    // года печатаются прочерки, в истории пишется «Неизвестно».
    date: String(document.getElementById("assetIssueDate")?.value || ""),
  };
}

// Те же три эффекта, что и у окна выдачи (см. handleIssueSubmit):
// запись в allocations, отметка в аудите и движение с номером акта.
function issueAssetOnCreate(asset, request) {
  const employee = request.employeeId ? getEmployeeById(request.employeeId) : null;
  AssetOps.mergeAllocation(asset.allocations, {
    employeeId: request.employeeId,
    department: request.department,
    site: request.site,
    workplaceId: request.workplaceId,
    quantity: request.quantity,
  });
  addAuditEntry("asset", asset.id, "issue", {
    employee: employee?.fullName,
    department: employee?.department || request.department,
    site: request.site,
    quantity: request.quantity,
  });
  addMovement({
    type: "issue",
    assetId: asset.id,
    employeeId: request.employeeId || null,
    department: request.department,
    site: request.site,
    workplaceId: request.workplaceId,
    actNumber: getNextActNumber(),
    quantity: request.quantity,
    date: request.date,
    // Пустой комментарий — не ошибка: полю необязательное, тогда в
    // истории остаётся тот же осмысленный текст, что был до этого поля.
    notes: request.notes || "Выдано при добавлении техники",
  });
}

function renderAssetCodeReference() {
  const body = document.getElementById("assetCodeReferenceBody");
  if (!body) return;
  const counts = new Map();
  for (const asset of state.assets) {
    const prefix = (String(asset.inventoryNumber || "").match(/^([A-Za-z]+)-\d+$/) || [])[1];
    if (prefix) counts.set(prefix.toUpperCase(), (counts.get(prefix.toUpperCase()) || 0) + 1);
  }
  const types = state.assetCodeTypes || [];
  body.innerHTML = types.length
    ? types.map((type) => `<tr><td><code>${escapeHtml(type.prefix)}</code></td><td>${escapeHtml(type.label)}</td><td class="num">${counts.get(type.prefix) || 0}</td></tr>`).join("")
    : '<tr><td colspan="3" class="muted">Справочник ещё не загружен с сервера.</td></tr>';
}

function openAssetCodeReference() {
  renderAssetCodeReference();
  document.getElementById("assetCodeReferenceModal")?.classList.remove("hidden");
}

function closeAssetCodeReference() {
  document.getElementById("assetCodeReferenceModal")?.classList.add("hidden");
}

function resetAssetForm() {
  dom.assetForm.reset();
  dom.assetForm.elements.assetId.value = "";
  dom.assetForm.elements.quantity.value = 1;
  dom.assetFormTitle.textContent = "Добавить единицу техники";
  dom.assetSubmitBtn.textContent = "Сохранить технику";
  dom.assetCancelBtn.classList.add("hidden");
  setDefaultDates();
  // form.reset() чистит значения, но не dataset — без этого пустое поле
  // осталось бы помеченным номером с прошлого заполнения.
  delete dom.assetForm.elements.inventoryNumber.dataset.autoGenerated;
  updateInventoryHint();
  // setDefaultDates() уже подставил сегодняшнюю дату покупки, поэтому
  // галочка «Неизвестно» у неё снимается — правило одно: галочка стоит
  // ровно тогда, когда поле пустое.
  const purchaseDateInput = document.getElementById("purchaseDateInput");
  if (purchaseDateInput) setUnknownDate(purchaseDateInput, !purchaseDateInput.value);
  syncAssetStatusDot();
  document.getElementById("assetIssueSection")?.classList.remove("hidden");
  resetAssetIssueBlock();
  renderAssetPhotoPreview({ id: "", photoUrl: "" });
}

function resetEmployeeForm() {
  const form = document.getElementById("employeeForm");
  if (form) form.reset();
  const idInput = document.getElementById("employeeFormId");
  if (idInput) idInput.value = "";
  const title = document.getElementById("employeeModalTitle");
  if (title) title.textContent = "Добавить сотрудника";
  const submitBtn = document.getElementById("employeeSubmitBtn");
  if (submitBtn) submitBtn.textContent = "Сохранить сотрудника";
  const statusSelect = document.getElementById("employeeStatusSelect");
  if (statusSelect) statusSelect.value = "active";
}

function resetOperationForms() {
  dom.issueForm.reset();
  dom.returnForm.reset();
  dom.manualActForm?.reset();
  dom.issueItems.innerHTML = "";
  dom.returnItems.innerHTML = "";
  dom.manualActItems.innerHTML = "";
  addIssueItemRow();
  addReturnItemRow();
  addManualActItemRow();
  setDefaultDates();
}

// ─── DASHBOARD: СТАТИСТИКА И СВОДКИ ─────────────────────────────
function renderStats() {
  const positions = state.assets.length;
  const totalUnits = state.assets.reduce((sum, asset) => sum + asset.quantity, 0);
  const inStock = state.assets.reduce((sum, asset) => sum + getAvailableQuantity(asset), 0);
  const assigned = state.assets.reduce((sum, asset) => sum + getAllocatedQuantity(asset), 0);
  const cards = [["Позиций", positions], ["Всего единиц", totalUnits], ["На складе", inStock], ["Выдано сотрудникам", assigned]];
  dom.statsGrid.innerHTML = cards.map(([label, value]) => `<article class="stat-card"><p class="stat-label">${label}</p><p class="value">${value}</p></article>`).join("");
}

function renderRecentMovements() {
  const query = normalizeSearchValue(dom.dashboardSearchInput?.value);
  const recent = [...state.movements]
    .sort((a, b) => AssetOps.movementSortValue(b) - AssetOps.movementSortValue(a))
    .filter((movement) => {
      const asset = getAssetById(movement.assetId);
      const employee = getEmployeeById(movement.employeeId);
      return matchesSearch(query, movementLabels[movement.type], asset?.name, asset?.serialNumber, employee?.fullName, movement.notes, movement.date);
    })
    .slice(0, 6);
  if (!recent.length) return appendEmptyState(dom.recentMovements);
  dom.recentMovements.innerHTML = recent.map((movement) => {
    const asset = getAssetById(movement.assetId);
    const employee = getEmployeeById(movement.employeeId);
    return `<article class="list-item"><div class="title-line"><strong>${movementLabels[movement.type] || movement.type}</strong><span class="chip">${movementDateLabel(movement)}</span></div><p>${asset ? asset.name : "Позиция удалена"}${movement.quantity ? ` · ${movement.quantity} шт.` : ""}</p><p class="muted">${employee ? employee.fullName : "Без сотрудника"}${movement.notes ? ` · ${movement.notes}` : ""}</p></article>`;
  }).join("");
}

function renderAssignedSummary() {
  const query = normalizeSearchValue(dom.dashboardSearchInput?.value);
  const summary = [];
  state.assets.forEach((asset) => {
    asset.allocations.forEach((entry) => {
      let record = summary.find((item) => item.employeeId === entry.employeeId);
      if (!record) {
        record = { employeeId: entry.employeeId, employee: getEmployeeById(entry.employeeId), items: [] };
        summary.push(record);
      }
      record.items.push(`${asset.name} (${entry.quantity}) · Инв.№: ${asset.inventoryNumber || "Отсутствует"} · S/N: ${asset.serialNumber || "Отсутствует"}`);
    });
  });
  const filtered = summary.filter((record) => matchesSearch(query, record.employee?.fullName, record.employee?.department, record.employee?.position, record.items.join(", ")));
  if (!filtered.length) return appendEmptyState(dom.assignedSummary);
  dom.assignedSummary.innerHTML = filtered.map((record) => `<article class="list-item"><div class="title-line"><strong>${record.employee ? record.employee.fullName : "Неизвестный сотрудник"}</strong><span class="chip warn">${record.items.length} поз.</span></div><p class="muted">${record.employee ? `${record.employee.department}${record.employee.position ? ` · ${record.employee.position}` : ""}` : "Карточка сотрудника не найдена"}</p><p>${record.items.join(", ")}</p></article>`).join("");
}

// Общие фильтрация и сортировка для вкладок «Склад» и «Реестр».
// ─── ИНВЕНТАРЬ: ФИЛЬТРАЦИЯ И ТАБЛИЦА ─────────────────────────────
function filterSortAssets({ query = "", status = "", category = "", location = "", sortField = "name", sortDir = "asc", haystack }) {
  const q = String(query || "").trim().toLowerCase();
  const rows = state.assets.filter((asset) => {
    if (status && getAssetStatus(asset) !== status) return false;
    if (category && asset.category !== category) return false;
    if (location && (asset.location || "") !== location) return false;
    if (!q) return true;
    return haystack(asset).join(" ").toLowerCase().includes(q);
  });

  rows.sort((a, b) => {
    let valA, valB;
    if (sortField === "quantity") {
      valA = a.quantity; valB = b.quantity;
    } else if (sortField === "purchaseDate") {
      valA = a.purchaseDate || ""; valB = b.purchaseDate || "";
    } else if (sortField === "status") {
      valA = getAssetStatus(a); valB = getAssetStatus(b);
    } else if (sortField === "inventoryNumber") {
      // Сортируем по числовой части инвентарного номера (INV-0001, SW-0018, …).
      const extractNum = (inv) => {
        const match = inv?.match(/(\d+)$/);
        return match ? parseInt(match[1], 10) : 0;
      };
      valA = extractNum(a.inventoryNumber);
      valB = extractNum(b.inventoryNumber);
    } else {
      valA = String(a[sortField] || "").toLowerCase();
      valB = String(b[sortField] || "").toLowerCase();
    }
    if (valA < valB) return sortDir === "asc" ? -1 : 1;
    if (valA > valB) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  return rows;
}

function getFilteredAssets() {
  return filterSortAssets({
    query: dom.assetSearchInput.value,
    status: document.getElementById('assetFilterStatus')?.value || '',
    category: document.getElementById('assetFilterCategory')?.value || '',
    sortField: document.getElementById('assetSortField')?.value || 'inventoryNumber',
    sortDir: document.getElementById('assetSortDir')?.value || 'asc',
    haystack: (asset) => [asset.name, asset.category, asset.inventoryNumber, asset.serialNumber, getAssetHolderText(asset)],
  });
}

function updateCategoryFilter() {
  const select = document.getElementById('assetFilterCategory');
  if (!select) return;
  const current = select.value;
  const categories = [...new Set(state.assets.map(a => a.category).filter(Boolean))].sort();
  select.innerHTML = '<option value="">Все категории</option>' + categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  select.value = current;
}

function renderAssetPagination(totalItems) {
  const container = document.getElementById('assetPagination');
  if (!container) return;
  const totalPages = Math.ceil(totalItems / ASSETS_PER_PAGE);
  if (totalPages <= 1) { container.innerHTML = ''; return; }
  if (assetCurrentPage > totalPages) assetCurrentPage = totalPages;
  let html = `<button ${assetCurrentPage <= 1 ? 'disabled' : ''} data-page="${assetCurrentPage - 1}">&laquo;</button>`;
  for (let i = 1; i <= totalPages; i++) {
    if (totalPages > 7 && i > 3 && i < totalPages - 1 && Math.abs(i - assetCurrentPage) > 1) {
      if (i === 4 || i === totalPages - 2) html += '<span class="page-info">...</span>';
      continue;
    }
    html += `<button class="${i === assetCurrentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
  }
  html += `<button ${assetCurrentPage >= totalPages ? 'disabled' : ''} data-page="${assetCurrentPage + 1}">&raquo;</button>`;
  container.innerHTML = html;
  container.querySelectorAll('button[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      assetCurrentPage = parseInt(btn.dataset.page);
      renderAssetsTable();
    });
  });
}

function renderAssetsTable() {
  const rows = getFilteredAssets();
  updateCategoryFilter();
  if (!rows.length) {
    dom.assetsTableBody.innerHTML = `<tr><td colspan="11"><div class="empty-state"><svg width="48" height="48" fill="none" viewBox="0 0 48 48" style="opacity:0.3;margin-bottom:8px"><rect x="6" y="10" width="36" height="28" rx="4" stroke="currentColor" stroke-width="2"/><path d="M6 18h36" stroke="currentColor" stroke-width="1.5" opacity="0.5"/></svg><p>Ничего не найдено</p></div></td></tr>`;
    renderAssetPagination(0);
    return;
  }
  const start = (assetCurrentPage - 1) * ASSETS_PER_PAGE;
  const pageRows = rows.slice(start, start + ASSETS_PER_PAGE);
  dom.assetsTableBody.innerHTML = pageRows.map((asset) => {
    const lowStock = asset.minQuantity > 0 && getAvailableQuantity(asset) < asset.minQuantity;
    return `<tr${lowStock ? ' class="low-stock-row"' : ''}>
      <td><input type="checkbox" class="asset-bulk-check" data-id="${asset.id}"></td>
      <td>${asset.inventoryNumber || "-"}</td>
      <td><strong>${asset.name}</strong><div class="muted">${asset.serialNumber || "Без серийного номера"}</div>${asset.price ? `<div class="muted">${Number(asset.price).toLocaleString("uz")} Sum</div>` : ""}</td>
      <td>${asset.category}</td>
      <td>${statusChip(getAssetStatus(asset))}</td>
      <td>${asset.quantity}${lowStock ? ` <span class="chip danger">мин.${asset.minQuantity}</span>` : ""}</td>
      <td>${getAvailableQuantity(asset)}</td>
      <td>${getAllocatedQuantity(asset)}</td>
      <td>${getAssetHolderText(asset)}</td>
      <td>${formatDate(asset.purchaseDate)}${asset.warrantyEnd ? `<div class="muted">Гар. до ${formatDate(asset.warrantyEnd)}${asset.warrantyReminderOff ? " · без напоминаний" : ""}</div>` : ""}</td>
      <td><div class="row-actions"><button type="button" class="edit-button" data-requires-role="admin,storekeeper" data-action="edit-asset" data-id="${asset.id}">Ред.</button><button type="button" class="ghost" data-requires-role="admin,storekeeper" data-action="duplicate-asset" data-id="${asset.id}" title="Дублировать"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M3 11V3h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button><button type="button" class="label-button" data-action="quick-label" data-id="${asset.id}"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 2h6l4 4v8H2V2h2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></button><button type="button" class="danger-button" data-requires-role="admin,storekeeper" data-action="delete-asset" data-id="${asset.id}">Удалить</button></div></td>
    </tr>`;
  }).join("");
  renderAssetPagination(rows.length);
  // These rows are rebuilt on every search/filter/page change, long after
  // boot()'s applyRoleVisibility() ran — re-apply so a viewer never sees
  // edit/duplicate/delete on freshly rendered rows. (The label button stays:
  // printing a label changes nothing server-side.)
  applyRoleVisibility();
}

// ─── REGISTRY (full asset table with export) ──────────────────────────
function getRegistryAssetHolders(asset) {
  return asset.allocations
    .map((entry) => {
      if (entry.employeeId) {
        const employee = getEmployeeById(entry.employeeId);
        return employee ? `${employee.fullName} (${entry.quantity})` : `(удалён) (${entry.quantity})`;
      }
      if (entry.workplaceId) {
        const workplace = getWorkplaceById(entry.workplaceId);
        return workplace ? `Место: ${workplace.name} (${entry.quantity})` : `Место удалено (${entry.quantity})`;
      }
      if (entry.site) return `Объект: ${entry.site} (${entry.quantity})`;
      return entry.department ? `Отдел: ${entry.department} (${entry.quantity})` : `(?) (${entry.quantity})`;
    })
    .join("; ");
}

function getRegistryFilteredAssets() {
  return filterSortAssets({
    query: document.getElementById("registrySearchInput")?.value || "",
    status: document.getElementById("registryFilterStatus")?.value || "",
    category: document.getElementById("registryFilterCategory")?.value || "",
    location: document.getElementById("registryFilterLocation")?.value || "",
    sortField: document.getElementById("registrySortField")?.value || "inventoryNumber",
    sortDir: document.getElementById("registrySortDir")?.value || "asc",
    haystack: (asset) => [
      asset.name, asset.category, asset.inventoryNumber, asset.serialNumber,
      asset.location, asset.notes, getRegistryAssetHolders(asset),
    ],
  });
}

function updateRegistryDropdowns() {
  const catSelect = document.getElementById("registryFilterCategory");
  if (catSelect) {
    const current = catSelect.value;
    const categories = [...new Set(state.assets.map((a) => a.category).filter(Boolean))].sort();
    catSelect.innerHTML = '<option value="">Все категории</option>' +
      categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    catSelect.value = current;
  }
  const locSelect = document.getElementById("registryFilterLocation");
  if (locSelect) {
    const current = locSelect.value;
    const locations = [...new Set(state.assets.map((a) => a.location).filter(Boolean))].sort();
    locSelect.innerHTML = '<option value="">Все локации</option>' +
      locations.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("");
    locSelect.value = current;
  }
}

function renderRegistry() {
  const tbody = document.getElementById("registryTableBody");
  if (!tbody) return;
  updateRegistryDropdowns();
  const rows = getRegistryFilteredAssets();
  const countEl = document.getElementById("registryCount");
  if (countEl) countEl.textContent = `Найдено: ${rows.length} из ${state.assets.length}`;

  const totalPages = Math.ceil(rows.length / registryPerPage);
  if (registryCurrentPage > totalPages && totalPages > 0) registryCurrentPage = totalPages;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="17"><div class="empty-state"><p>Ничего не найдено</p></div></td></tr>`;
    renderRegistryPagination(0);
    return;
  }

  const start = (registryCurrentPage - 1) * registryPerPage;
  const pageRows = rows.slice(start, start + registryPerPage);

  tbody.innerHTML = pageRows.map((asset) => {
    const status = getAssetStatus(asset);
    const allocated = getAllocatedQuantity(asset);
    const available = getAvailableQuantity(asset);
    const repair = Number(asset.repairQuantity || 0);
    const retired = Number(asset.retiredQuantity || 0);
    const holders = getRegistryAssetHolders(asset);
    const price = Number(asset.price || 0);
    const ec = 'reg-edit';
    const t = 'title="Дважды нажмите, чтобы изменить. Enter — сохранить, Esc — отмена"';
    return `<tr data-id="${asset.id}">
      <td class="${ec}" contenteditable="true" data-field="inventoryNumber" ${t}>${escapeHtml(asset.inventoryNumber || "")}</td>
      <td class="${ec}" contenteditable="true" data-field="serialNumber" ${t}>${escapeHtml(asset.serialNumber || "")}</td>
      <td class="${ec} reg-name" contenteditable="true" data-field="name" ${t}>${escapeHtml(asset.name || "")}</td>
      <td class="${ec}" contenteditable="true" data-field="category" ${t}>${escapeHtml(asset.category || "")}</td>
      <td class="${ec}" contenteditable="true" data-field="location" ${t}>${escapeHtml(asset.location || "")}</td>
      <td>${statusChip(status)}</td>
      <td class="${ec} reg-num" contenteditable="true" data-field="quantity" ${t}>${asset.quantity}</td>
      <td>${available}</td>
      <td>${allocated}</td>
      <td>${repair}</td>
      <td>${retired}</td>
      <td>${escapeHtml(holders) || "—"}</td>
      <td class="${ec} reg-num" contenteditable="true" data-field="price" ${t}>${price ? price.toLocaleString("ru-RU") : "0"}</td>
      <td class="${ec}" contenteditable="true" data-field="purchaseDate" ${t}>${regDateDisplay(asset.purchaseDate)}</td>
      <td class="${ec}${asset.warrantyReminderOff ? " reg-no-reminder" : ""}" contenteditable="true" data-field="warrantyEnd" ${asset.warrantyReminderOff ? 'title="Напоминание о гарантии снято — дата настоящая. Впишите новую дату, чтобы напоминание вернулось."' : t}>${regDateDisplay(asset.warrantyEnd)}</td>
      <td class="${ec}" contenteditable="true" data-field="notes" ${t}>${escapeHtml(asset.notes || "")}</td>
      <td class="reg-actions"><button type="button" class="reg-del" data-action="reg-delete" data-id="${asset.id}" title="Удалить позицию">✕</button></td>
    </tr>`;
  }).join("");

  setupRegistryInlineEdit();
  renderRegistryPagination(rows.length);
}

// ─── INLINE EDITING (Excel-style) ─────────────────────────────
function regDateDisplay(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}

// Parse a user-typed date. Returns ISO "YYYY-MM-DD", "" for empty, or null if invalid.
function regDateParse(str) {
  str = (str || "").trim();
  if (!str) return "";
  let m = str.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return null;
}

function commitRegistryEdit(cell) {
  const id = cell.dataset.id || cell.closest("tr")?.dataset.id;
  const field = cell.dataset.field;
  const asset = getAssetById(id);
  if (!asset || !field) return;
  const raw = cell.textContent.replace(/ /g, " ").trim();
  let newVal, oldVal;

  if (field === "price") {
    newVal = Math.max(0, parseInt(raw.replace(/[^\d]/g, "") || "0", 10));
    oldVal = Number(asset.price || 0);
  } else if (field === "quantity") {
    newVal = Math.max(1, parseInt(raw.replace(/[^\d]/g, "") || "1", 10));
    oldVal = Number(asset.quantity || 1);
  } else if (field === "purchaseDate" || field === "warrantyEnd") {
    const parsed = regDateParse(raw);
    if (parsed === null) {
      showToast("Неверная дата. Используйте формат ДД.ММ.ГГГГ", "warning");
      renderRegistry();
      return;
    }
    newVal = parsed;
    oldVal = asset[field] || "";
  } else if (field === "name") {
    newVal = raw;
    oldVal = asset.name || "";
    if (!newVal) {
      showToast("Наименование не может быть пустым", "warning");
      renderRegistry();
      return;
    }
  } else {
    newVal = raw;
    oldVal = String(asset[field] || "");
  }

  if (String(newVal) === String(oldVal)) {
    return; // no change — leave the cell as is (avoids re-render races)
  }
  if (field === "warrantyEnd") applyWarrantyEnd(asset, String(newVal));
  else asset[field] = newVal;
  addAuditEntry("asset", id, "edit", { [field]: { from: oldVal, to: newVal } });
  persist();
}

function setupRegistryInlineEdit() {
  const tbody = document.getElementById("registryTableBody");
  if (!tbody || tbody._inlineBound) return;
  tbody._inlineBound = true;
  tbody.addEventListener("focusin", (e) => {
    const c = e.target.closest && e.target.closest(".reg-edit");
    if (c) c.dataset._orig = c.textContent;
  });
  tbody.addEventListener("keydown", (e) => {
    const c = e.target.closest && e.target.closest(".reg-edit");
    if (!c) return;
    if (e.key === "Enter") { e.preventDefault(); c.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); c.textContent = c.dataset._orig ?? c.textContent; c.blur(); }
  });
  tbody.addEventListener("focusout", (e) => {
    const c = e.target.closest && e.target.closest(".reg-edit");
    if (c) commitRegistryEdit(c);
  });
  // Row deletion (also removes the asset from the database via persist()).
  tbody.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest('button[data-action="reg-delete"]');
    if (btn) { e.preventDefault(); deleteAsset(btn.dataset.id); }
  });
}

function renderRegistryPagination(totalItems) {
  const container = document.getElementById('registryPagination');
  if (!container) return;
  const totalPages = Math.ceil(totalItems / registryPerPage);
  if (totalPages <= 1) { container.innerHTML = ''; return; }
  let html = `<button ${registryCurrentPage <= 1 ? 'disabled' : ''} data-page="${registryCurrentPage - 1}">&laquo;</button>`;
  for (let i = 1; i <= totalPages; i++) {
    if (totalPages > 7 && i > 3 && i < totalPages - 1 && Math.abs(i - registryCurrentPage) > 1) {
      if (i === 4 || i === totalPages - 2) html += '<span class="page-info">...</span>';
      continue;
    }
    html += `<button class="${i === registryCurrentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
  }
  html += `<button ${registryCurrentPage >= totalPages ? 'disabled' : ''} data-page="${registryCurrentPage + 1}">&raquo;</button>`;
  container.innerHTML = html;
  container.querySelectorAll('button[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      registryCurrentPage = parseInt(btn.dataset.page);
      renderRegistry();
    });
  });
}

function buildRegistryRows() {
  const headers = [
    "Инв. №", "S/N", "Наименование", "Категория", "Локация", "Статус",
    "Всего", "Склад", "Выдано", "В ремонте", "Списано",
    "Сотрудник(и)", "Цена (сум)", "Дата покупки", "Гарантия до", "Комментарий",
  ];
  const data = getRegistryFilteredAssets().map((asset) => [
    asset.inventoryNumber || "",
    asset.serialNumber || "",
    asset.name || "",
    asset.category || "",
    asset.location || "",
    statusLabels[getAssetStatus(asset)] || getAssetStatus(asset),
    asset.quantity,
    getAvailableQuantity(asset),
    getAllocatedQuantity(asset),
    Number(asset.repairQuantity || 0),
    Number(asset.retiredQuantity || 0),
    getRegistryAssetHolders(asset),
    Number(asset.price || 0),
    asset.purchaseDate || "",
    asset.warrantyEnd || "",
    (asset.notes || "").replace(/\s+/g, " "),
  ]);
  return { headers, data };
}

function exportRegistryCsv() {
  const { headers, data } = buildRegistryRows();
  const escape = (v) => {
    const s = String(v == null ? "" : v);
    if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  // Use ';' separator + UTF-8 BOM so Excel opens Cyrillic correctly.
  const csv = [headers, ...data].map((row) => row.map(escape).join(";")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `Реестр_техники_${stamp}.csv`);
  showToast("Реестр выгружен в CSV.", "info");
}

function exportRegistryXls() {
  // Excel-compatible HTML (.xls) — opens natively in Excel.
  const { headers, data } = buildRegistryRows();
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8"><style>table{border-collapse:collapse}th,td{border:1px solid #999;padding:4px 8px;font-family:Arial,sans-serif;font-size:11pt}th{background:#e7eaf3;font-weight:bold;text-align:left}</style></head>
<body><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
<tbody>${data.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></body></html>`;
  const blob = new Blob(["\uFEFF" + html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `Реестр_техники_${stamp}.xls`);
  showToast("Реестр выгружен в Excel.", "info");
}

function exportBalanceCsv() {
  const headers = ["Актив", "Инв. номер", "Остаток", "Цена", "Сумма остатка"];
  // Same filtered/sorted set the registry's own CSV/Excel export use
  // (buildRegistryRows() -> getRegistryFilteredAssets()), not the raw,
  // unfiltered state.assets — this button lives on the same registry
  // screen and should respect the same active filters as its siblings.
  const rows = getRegistryFilteredAssets().map((asset) => {
    const available = getAvailableQuantity(asset);
    const price = Number(asset.price || 0);
    return [asset.name, asset.inventoryNumber || "", available, price, available * price];
  });
  const escape = (v) => {
    const s = String(v == null ? "" : v);
    if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  // Use ';' separator + UTF-8 BOM so Excel opens Cyrillic correctly (same pattern as exportRegistryCsv).
  const csv = [headers, ...rows].map((row) => row.map(escape).join(";")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `Остатки_${stamp}.csv`);
  showToast("Остатки выгружены в CSV.", "info");
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

function buildHandoverRows(state, filter) {
  const headers = ["Актив", "Инв. номер", "Количество", "Цена", "Сумма"];
  const rows = [];
  for (const asset of state.assets) {
    for (const alloc of asset.allocations || []) {
      // Mirror the mutual-exclusivity check used by getDepartmentAllocation/getSiteAllocation
      // so an allocation carrying more than one owner field can't double-count into a filter
      // it doesn't actually belong to.
      const matches = filter.employeeId ? alloc.employeeId === filter.employeeId
        : filter.department ? (!alloc.employeeId && !alloc.site && alloc.department === filter.department)
        : filter.site ? (!alloc.employeeId && !alloc.department && alloc.site === filter.site)
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
  // Use ';' separator + UTF-8 BOM so Excel opens Cyrillic correctly (same pattern as exportRegistryCsv).
  const csv = [headers, ...data].map((row) => row.map(escape).join(";")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const stamp = new Date().toISOString().slice(0, 10);
  // Strip characters that are invalid in Windows filenames; the suffix is free-text
  // (employee/department/site name) so it isn't safe to use verbatim.
  const safeSuffix = String(filenameSuffix || "").replace(/[\\/:*?"<>|]/g, "_").trim() || "Ведомость";
  triggerDownload(blob, `Ведомость_${safeSuffix}_${stamp}.csv`);
  showToast("Ведомость выгружена в CSV.", "info");
}

function exportEmployeeHandoverCsv(employeeId) {
  const employee = getEmployeeById(employeeId);
  if (!employee) return;
  exportHandoverCsv({ employeeId }, employee.fullName || employeeId);
}

// "Ведомость на подпись" — a signed handover sheet: the same act_generator.py
// .docx machinery used for issue/return acts (downloadActDocx -> POST /api/act),
// but with a custom action phrase ("currently on hand as of <date>" instead of
// "issued/returned") and the item list built from the same buildHandoverRows()
// used by the employee's CSV export above, so both exports agree on contents.
async function downloadHandoverSheet(employeeId) {
  const employee = getEmployeeById(employeeId);
  if (!employee) return;
  const { data } = buildHandoverRows(state, { employeeId });
  const items = data.map(([name, inventoryNumber, quantity, price]) => ({ name, inventoryNumber, quantity, price }));
  const date = new Date().toISOString().slice(0, 10);
  // actNumber is always null here (a handover sheet isn't a numbered act), so
  // downloadActDocx()'s default filename ("Акт_документ.docx") would be
  // identical for every employee/date, overwriting the previous download.
  // Same filename-sanitizing pattern as exportHandoverCsv()'s safeSuffix.
  const safeName = String(employee.fullName || employeeId).replace(/[\\/:*?"<>|]/g, "_").trim() || employeeId;
  await downloadActDocx({
    actNumber: null,
    date,
    employee,
    items,
    isIssue: true,
    actionPhrase: "За Работником числится по состоянию на",
    filename: `Обходной_лист_${safeName}_${date}.docx`,
  });
}

function exportDepartmentHandoverCsv(departmentId) {
  const dept = state.departments.find((d) => d.id === departmentId);
  if (!dept) return;
  exportHandoverCsv({ department: dept.name }, dept.name);
}

function exportSiteHandoverCsv(siteId) {
  const site = state.sites.find((s) => s.id === siteId);
  if (!site) return;
  exportHandoverCsv({ site: site.name }, site.name);
}

function exportMovementsCsv(dateFrom, dateTo) {
  const headers = ["Дата", "Тип", "Актив", "Количество", "Сотрудник/Отдел/Объект"];
  const filtered = [...state.movements]
    .filter((m) => (!dateFrom || m.date >= dateFrom) && (!dateTo || m.date <= dateTo))
    .sort((a, b) => dateSortKey(b.date) - dateSortKey(a.date));
  const rows = filtered.map((m) => {
    const asset = getAssetById(m.assetId);
    const employee = getEmployeeById(m.employeeId);
    // Issue/return movements are mutually exclusive on employee/department/site/
    // workplace (the operation form only lets you pick one target), so unlike
    // the D1 allocation filter there's no ambiguity here — just pick whichever is set.
    const workplace = m.workplaceId ? getWorkplaceById(m.workplaceId) : null;
    const target = employee
      ? employee.fullName
      : m.workplaceId
      ? (workplace ? `Место: ${workplace.name}` : "Место удалено")
      : (m.department || m.site || "Склад");
    return [m.date, movementLabels[m.type] || m.type, asset ? asset.name : m.assetId, m.quantity, target];
  });
  const escape = (v) => {
    const s = String(v == null ? "" : v);
    if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  // Use ';' separator + UTF-8 BOM so Excel opens Cyrillic correctly (same pattern as exportRegistryCsv).
  const csv = [headers, ...rows].map((row) => row.map(escape).join(";")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  triggerDownload(blob, `Движения_${dateFrom || "все"}_${dateTo || "все"}.csv`);
  showToast("Движения выгружены в CSV.", "info");
}

// ─── СОТРУДНИКИ ─────────────────────────────────────────────────
const AVATAR_COLORS = [
  "#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0d9488",
  "#dc2626", "#0284c7", "#d97706", "#db2777", "#4f46e5",
  "#059669", "#7c3aed"
];

const EYE_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EDIT_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const DELETE_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>`;
const MAIL_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="emp-contact-icon"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`;
const PHONE_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="emp-contact-icon"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;

let employeeCurrentPage = 1;
let employeePerPage = 10;
let employeeViewMode = "table"; // 'table' | 'cards'

function getAvatarBgColor(str) {
  let hash = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function getInitials(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function formatEmployeeId(employee, index) {
  if (employee.customId) return employee.customId;
  // Индекс считаем по видимым сотрудникам — иначе номер на карточке
  // разойдётся с номером в реестре, как только кто-то мягко удалён
  // (см. getVisibleEmployees): реестр их не считает, а findIndex по
  // сырому state.employees считал бы.
  const num = index !== undefined ? index + 1 : (getVisibleEmployees(state.employees).findIndex((e) => e.id === employee.id) + 1);
  return `ID: ${String(num || 1).padStart(4, "0")}`;
}

function updateEmployeeDepartmentFilter() {
  const select = document.getElementById("employeeFilterDepartment");
  if (!select) return;
  const current = select.value;
  const options = state.departments.map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`).join("");
  select.innerHTML = '<option value="">Все подразделения</option>' + options;
  select.value = Array.from(select.options).some((option) => option.value === current) ? current : "";
}

function updateEmployeePositionFilter() {
  const select = document.getElementById("employeeFilterPosition");
  if (!select) return;
  const current = select.value;
  const positions = [...new Set(state.employees.map((employee) => employee.position).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ru"));
  const options = positions.map((position) => `<option value="${escapeHtml(position)}">${escapeHtml(position)}</option>`).join("");
  select.innerHTML = '<option value="">Все должности</option>' + options;
  select.value = Array.from(select.options).some((option) => option.value === current) ? current : "";
}

function getEmployeeAssetCount(employeeId) {
  return state.assets.reduce((count, asset) => {
    const allocation = getEmployeeAllocation(asset, employeeId);
    return count + (allocation ? allocation.quantity || 1 : 0);
  }, 0);
}

function renderEmployeeStats() {
  const visible = getVisibleEmployees(state.employees);
  const total = visible.length;
  const active = visible.filter((e) => (e.status || "active") !== "inactive").length;
  const inactive = visible.filter((e) => e.status === "inactive").length;
  const depts = state.departments.length;

  const totalEl = document.getElementById("empStatTotal");
  const activeEl = document.getElementById("empStatActive");
  const inactiveEl = document.getElementById("empStatInactive");
  const deptsEl = document.getElementById("empStatDepts");

  if (totalEl) totalEl.textContent = total;
  if (activeEl) activeEl.textContent = active;
  if (inactiveEl) inactiveEl.textContent = inactive;
  if (deptsEl) deptsEl.textContent = depts;
}

function renderEmployeeActiveChips(filters) {
  const container = document.getElementById("employeeActiveChips");
  if (!container) return;
  const chips = [];

  if (filters.status) {
    const label = filters.status === "active" ? "Активные" : "Уволенные";
    chips.push(`<span class="emp-chip-tag">Статус: ${label} <span class="emp-chip-remove" data-clear="status">✕</span></span>`);
  }
  if (filters.department) {
    chips.push(`<span class="emp-chip-tag">Подразделение: ${escapeHtml(filters.department)} <span class="emp-chip-remove" data-clear="department">✕</span></span>`);
  }
  if (filters.position) {
    chips.push(`<span class="emp-chip-tag">Должность: ${escapeHtml(filters.position)} <span class="emp-chip-remove" data-clear="position">✕</span></span>`);
  }
  if (filters.query) {
    chips.push(`<span class="emp-chip-tag">Поиск: "${escapeHtml(filters.query)}" <span class="emp-chip-remove" data-clear="query">✕</span></span>`);
  }

  if (!chips.length) {
    container.innerHTML = `<span class="emp-chip-tag" style="opacity:0.75">Статус: Все</span><span class="emp-chip-tag" style="opacity:0.75">Подразделение: Все</span>`;
  } else {
    container.innerHTML = chips.join("");
  }
}

function renderEmployeePagination(totalItems) {
  const container = document.getElementById("employeePaginationNav");
  const infoEl = document.getElementById("employeePaginationInfo");
  if (!container) return;

  const totalPages = Math.ceil(totalItems / employeePerPage) || 1;
  if (employeeCurrentPage > totalPages) employeeCurrentPage = totalPages;

  const start = totalItems > 0 ? (employeeCurrentPage - 1) * employeePerPage + 1 : 0;
  const end = Math.min(employeeCurrentPage * employeePerPage, totalItems);
  if (infoEl) infoEl.textContent = `${start} – ${end} из ${totalItems}`;

  if (totalPages <= 1) {
    container.innerHTML = `<button type="button" class="emp-page-btn active">1</button>`;
    return;
  }

  let html = `<button type="button" class="emp-page-btn" ${employeeCurrentPage <= 1 ? "disabled" : ""} data-emp-page="${employeeCurrentPage - 1}">‹</button>`;

  for (let i = 1; i <= totalPages; i++) {
    if (totalPages > 7 && i > 3 && i < totalPages - 1 && Math.abs(i - employeeCurrentPage) > 1) {
      if (i === 4 || i === totalPages - 2) html += `<span style="padding:0 4px;color:var(--text-3)">...</span>`;
      continue;
    }
    html += `<button type="button" class="emp-page-btn ${i === employeeCurrentPage ? "active" : ""}" data-emp-page="${i}">${i}</button>`;
  }

  html += `<button type="button" class="emp-page-btn" ${employeeCurrentPage >= totalPages ? "disabled" : ""} data-emp-page="${employeeCurrentPage + 1}">›</button>`;
  container.innerHTML = html;
}

function renderEmployees() {
  updateEmployeeDepartmentFilter();
  updateEmployeePositionFilter();
  renderEmployeeStats();

  const query = normalizeSearchValue(document.getElementById("employeeSearchInput")?.value);
  const departmentFilter = document.getElementById("employeeFilterDepartment")?.value || "";
  const positionFilter = document.getElementById("employeeFilterPosition")?.value || "";
  const statusFilter = document.getElementById("employeeFilterStatus")?.value || "";
  const sortValue = document.getElementById("employeeSortSelect")?.value || "name_asc";

  renderEmployeeActiveChips({ query, department: departmentFilter, position: positionFilter, status: statusFilter });

  const filtered = getVisibleEmployees(state.employees).map((employee, originalIndex) => ({
    employee,
    originalIndex,
    assetCount: getEmployeeAssetCount(employee.id),
  })).filter(({ employee }) => {
    const isInactive = employee.status === "inactive";
    if (statusFilter === "active" && isInactive) return false;
    if (statusFilter === "inactive" && !isInactive) return false;
    if (departmentFilter && employee.department !== departmentFilter) return false;
    if (positionFilter && employee.position !== positionFilter) return false;
    if (!query) return true;
    return matchesSearch(query, employee.fullName, employee.department, employee.site, employee.position, employee.email, employee.phone);
  });

  filtered.sort((left, right) => {
    const a = left.employee;
    const b = right.employee;
    if (sortValue === "name_desc") return (b.fullName || "").localeCompare(a.fullName || "", "ru");
    if (sortValue === "department") return (a.department || "").localeCompare(b.department || "", "ru") || (a.fullName || "").localeCompare(b.fullName || "", "ru");
    if (sortValue === "position") return (a.position || "").localeCompare(b.position || "", "ru");
    if (sortValue === "assets") return right.assetCount - left.assetCount;
    return (a.fullName || "").localeCompare(b.fullName || "", "ru");
  });

  const totalPages = Math.ceil(filtered.length / employeePerPage) || 1;
  if (employeeCurrentPage > totalPages) employeeCurrentPage = totalPages;

  const start = (employeeCurrentPage - 1) * employeePerPage;
  const pageItems = filtered.slice(start, start + employeePerPage);

  const tbody = document.getElementById("employeesTableBody");
  const cardsGrid = document.getElementById("employeesCardsGrid");
  const tableView = document.getElementById("employeeTableView");
  const cardsView = document.getElementById("employeeCardsView");

  if (tableView && cardsView) {
    tableView.classList.toggle("hidden", employeeViewMode !== "table");
    cardsView.classList.toggle("hidden", employeeViewMode !== "cards");
  }

  // Render Table Rows
  if (tbody) {
    if (!pageItems.length) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><p>Сотрудники не найдены</p></div></td></tr>`;
    } else {
      tbody.innerHTML = pageItems.map(({ employee, originalIndex }) => {
        const initials = getInitials(employee.fullName);
        const avatarBg = getAvatarBgColor(employee.fullName || employee.id);
        const empId = formatEmployeeId(employee, originalIndex);
        const isInactive = employee.status === "inactive";
        const statusBadge = isInactive
          ? `<span class="emp-status-badge inactive">Уволен</span>`
          : `<span class="emp-status-badge active">Активен</span>`;

        return `<tr data-id="${employee.id}">
          <td style="text-align:center"><input type="checkbox" class="emp-checkbox emp-row-check" data-id="${employee.id}"></td>
          <td>
            <div class="emp-name-cell">
              <div class="emp-avatar-circle" style="background-color:${avatarBg}">${escapeHtml(initials)}</div>
              <div class="emp-name-content">
                <div class="emp-name-title">${escapeHtml(employee.fullName)}</div>
                <div class="emp-id-badge">${escapeHtml(empId)}</div>
              </div>
            </div>
          </td>
          <td>${escapeHtml(employee.position || "—")}</td>
          <td>${escapeHtml(employee.department || "—")}</td>
          <td>
            ${employee.phone ? `<span class="emp-contact-item">${PHONE_ICON_SVG} ${escapeHtml(employee.phone)}</span>` : "—"}
          </td>
          <td>
            ${employee.email ? `<span class="emp-contact-item">${MAIL_ICON_SVG} ${escapeHtml(employee.email)}</span>` : "—"}
          </td>
          <td>${statusBadge}</td>
          <td>
            <div class="emp-action-btns">
              <button type="button" class="emp-btn-action" data-action="view-employee" data-id="${employee.id}" title="Просмотр карточки">${EYE_ICON_SVG}</button>
              <button type="button" class="emp-btn-action" data-action="edit-employee" data-id="${employee.id}" title="Редактировать">${EDIT_ICON_SVG}</button>
              <button type="button" class="emp-btn-action btn-del" data-action="delete-employee" data-id="${employee.id}" title="Удалить">${DELETE_ICON_SVG}</button>
            </div>
          </td>
        </tr>`;
      }).join("");
    }
  }

  // Render Grid Cards
  if (cardsGrid) {
    if (!pageItems.length) {
      cardsGrid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p>Сотрудники не найдены</p></div>`;
    } else {
      cardsGrid.innerHTML = pageItems.map(({ employee, originalIndex, assetCount }) => {
        const initials = getInitials(employee.fullName);
        const avatarBg = getAvatarBgColor(employee.fullName || employee.id);
        const empId = formatEmployeeId(employee, originalIndex);
        const isInactive = employee.status === "inactive";
        const statusBadge = isInactive
          ? `<span class="emp-status-badge inactive">Уволен</span>`
          : `<span class="emp-status-badge active">Активен</span>`;

        return `<article class="emp-card" data-id="${employee.id}">
          <div class="emp-card-header">
            <div class="emp-avatar-circle" style="background-color:${avatarBg}">${escapeHtml(initials)}</div>
            <div class="emp-card-name-wrap">
              <div class="emp-card-name" title="${escapeHtml(employee.fullName)}">${escapeHtml(employee.fullName)}</div>
              <div class="emp-card-role">${escapeHtml(employee.position || "—")} · ${escapeHtml(employee.department || "—")}</div>
            </div>
            ${statusBadge}
          </div>
          <div class="emp-card-meta">
            ${employee.phone ? `<div class="emp-contact-item">${PHONE_ICON_SVG} ${escapeHtml(employee.phone)}</div>` : ""}
            ${employee.email ? `<div class="emp-contact-item">${MAIL_ICON_SVG} ${escapeHtml(employee.email)}</div>` : ""}
            <div class="emp-id-badge">${escapeHtml(empId)}${employee.site ? ` · Объект: ${escapeHtml(employee.site)}` : ""} · Техника: <strong>${assetCount} шт.</strong></div>
          </div>
          <div class="emp-card-actions">
            <button type="button" class="secondary" style="padding:6px 10px;font-size:12px" data-action="view-employee" data-id="${employee.id}">Просмотр</button>
            <button type="button" class="secondary" style="padding:6px 10px;font-size:12px" data-action="edit-employee" data-id="${employee.id}">Ред.</button>
            <button type="button" class="danger-button" style="padding:6px 10px;font-size:12px" data-action="delete-employee" data-id="${employee.id}">Удалить</button>
          </div>
        </article>`;
      }).join("");
    }
  }

  renderEmployeePagination(filtered.length);
  updateEmployeeBulkBar();
}

// ─── EMPLOYEE MODAL HANDLERS ───────────────────────────────────
function setEmployeeEditInfo(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function syncEmployeeEditAside(employee) {
  const fullName = document.getElementById("employeeFullNameInput")?.value.trim() || "";
  const department = document.getElementById("employeeDepartmentSelect")?.value || "";
  const position = document.getElementById("employeePositionInput")?.value.trim() || "";
  const site = document.getElementById("employeeSiteSelect")?.value || "";
  const phone = document.getElementById("employeePhoneInput")?.value.trim() || "";
  const email = document.getElementById("employeeEmailInput")?.value.trim() || "";
  const status = document.getElementById("employeeStatusSelect")?.value || "active";

  const avatar = document.getElementById("employeeEditAvatar");
  if (avatar) {
    avatar.textContent = getInitials(fullName);
    avatar.style.backgroundColor = getAvatarBgColor(fullName || "new");
  }
  setEmployeeEditInfo("employeeEditName", fullName || "Новый сотрудник");

  const badge = document.getElementById("employeeEditStatusBadge");
  if (badge) {
    const isInactive = status === "inactive";
    badge.textContent = isInactive ? "Уволен / Неактивен" : "Активен";
    badge.className = `emp-status-badge ${isInactive ? "inactive" : "active"}`;
  }

  setEmployeeEditInfo("employeeEditInfoPosition", position || "—");
  setEmployeeEditInfo("employeeEditInfoDepartment", department || "—");
  setEmployeeEditInfo("employeeEditInfoSite", site || "— без объекта —");
  setEmployeeEditInfo("employeeEditInfoPhone", phone || "—");
  setEmployeeEditInfo("employeeEditInfoEmail", email || "—");
  setEmployeeEditInfo("employeeEditInfoId", employee ? formatEmployeeId(employee) : "Будет присвоен");
  setEmployeeEditInfo("employeeEditInfoCreated", formatDate(employee?.createdAt || new Date().toISOString()));
}

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
  // В режиме редактирования кнопка открывает ДРУГУЮ запись и теряет
  // введённые здесь правки — формулировка честно предупреждает об этом,
  // а не только про «возможный дубль» при создании нового сотрудника.
  const title = employeeId
    ? "Похожие сотрудники уже есть в реестре:"
    : "Похожие сотрудники уже есть в реестре — возможно, это дубль:";
  const buttonText = employeeId ? "Открыть эту запись (текущие правки будут потеряны)" : "Использовать эту запись";
  panel.innerHTML = `<div class="emp-duplicate-warning-title">${title}</div>`
    + similar.map((employee) => {
      const isDeleted = employee.status === "deleted";
      const statusSuffix = isDeleted ? " (удалён)" : employee.status === "inactive" ? " (уволен)" : "";
      // Удалённая запись — отдельный, третий вариант кнопки: открытие
      // такой записи через openEditEmployeeModal молча возвращает её из
      // удалённых (у employeeStatusSelect нет варианта "deleted", при
      // сохранении статус откатится на "Активен") — текст честно
      // называет это восстановлением, а не «открытием»/«использованием».
      const itemButtonText = isDeleted ? "Восстановить эту запись" : buttonText;
      return `
      <div class="emp-duplicate-warning-item">
        <span>${escapeHtml(employee.fullName)}${statusSuffix}${employee.department ? ` — ${escapeHtml(employee.department)}` : ""}</span>
        <button type="button" class="secondary" data-use-employee-id="${escapeHtml(employee.id)}">${itemButtonText}</button>
      </div>`;
    }).join("");
}

function openAddEmployeeModal() {
  resetEmployeeForm();
  syncEmployeeEditAside(null);
  document.getElementById("employeeDuplicateWarning")?.classList.add("hidden");
  document.getElementById("employeeModalOverlay")?.classList.remove("hidden");
  document.getElementById("employeeFullNameInput")?.focus();
}

function openEditEmployeeModal(employeeId) {
  const employee = getEmployeeById(employeeId);
  if (!employee) return;
  const form = document.getElementById("employeeForm");
  if (!form) return;

  document.getElementById("employeeFormId").value = employee.id;
  document.getElementById("employeeFullNameInput").value = employee.fullName || "";
  document.getElementById("employeeDepartmentSelect").value = employee.department || "";
  document.getElementById("employeePositionInput").value = employee.position || "";
  document.getElementById("employeeSiteSelect").value = employee.site || "";
  document.getElementById("employeePhoneInput").value = employee.phone || "";
  document.getElementById("employeeEmailInput").value = employee.email || "";
  document.getElementById("employeeStatusSelect").value = employee.status || "active";

  document.getElementById("employeeModalTitle").textContent = "Редактировать сотрудника";
  document.getElementById("employeeSubmitBtn").textContent = "Сохранить изменения";
  syncEmployeeEditAside(employee);
  syncEmployeeDuplicateWarning();
  document.getElementById("employeeModalOverlay")?.classList.remove("hidden");
}

function closeEmployeeModal() {
  document.getElementById("employeeModalOverlay")?.classList.add("hidden");
}

function openEmployeeDetailsModal(employeeId) {
  const employee = getEmployeeById(employeeId);
  if (!employee) return;

  const overlay = document.getElementById("employeeDetailsOverlay");
  const body = document.getElementById("employeeProfileBody");
  if (!overlay || !body) return;

  const initials = getInitials(employee.fullName);
  const avatarBg = getAvatarBgColor(employee.fullName || employee.id);
  const empId = formatEmployeeId(employee);
  const isInactive = employee.status === "inactive";
  const statusBadge = isInactive
    ? `<span class="emp-status-badge inactive">Уволен / Неактивен</span>`
    : `<span class="emp-status-badge active">Активен</span>`;

  // Техника делится на два списка: то, что стоит на рабочем месте
  // сотрудника (остаётся столу при увольнении), и то, что числится
  // лично за ним (при увольнении возвращается на склад).
  const { personal, workplace, atWorkplace } = getEmployeeHoldings(employee.id);
  const totalCount = personal.length + atWorkplace.length;

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

  body.innerHTML = `
    <div class="emp-profile-header">
      <div class="emp-profile-avatar" style="background-color:${avatarBg}">${escapeHtml(initials)}</div>
      <div>
        <div class="emp-profile-title">${escapeHtml(employee.fullName)}</div>
        <div class="emp-profile-subtitle">${escapeHtml(employee.position || "Без должности")} · ${escapeHtml(employee.department || "Без отдела")}</div>
      </div>
      <div style="margin-left:auto">${statusBadge}</div>
    </div>

    <div class="emp-profile-grid">
      <div class="emp-profile-field">
        <div class="emp-profile-field-label">Идентификатор</div>
        <div class="emp-profile-field-value">${escapeHtml(empId)}</div>
      </div>
      <div class="emp-profile-field">
        <div class="emp-profile-field-label">Отдел</div>
        <div class="emp-profile-field-value">${escapeHtml(employee.department || "—")}</div>
      </div>
      <div class="emp-profile-field">
        <div class="emp-profile-field-label">Должность</div>
        <div class="emp-profile-field-value">${escapeHtml(employee.position || "—")}</div>
      </div>
      <div class="emp-profile-field">
        <div class="emp-profile-field-label">Объект / Площадка</div>
        <div class="emp-profile-field-value">${escapeHtml(employee.site || "—")}</div>
      </div>
      <div class="emp-profile-field">
        <div class="emp-profile-field-label">Телефон</div>
        <div class="emp-profile-field-value">${employee.phone ? `<a href="tel:${escapeHtml(employee.phone)}" style="color:var(--brand);text-decoration:none">${escapeHtml(employee.phone)}</a>` : "—"}</div>
      </div>
      <div class="emp-profile-field">
        <div class="emp-profile-field-label">Email</div>
        <div class="emp-profile-field-value">${employee.email ? `<a href="mailto:${escapeHtml(employee.email)}" style="color:var(--brand);text-decoration:none">${escapeHtml(employee.email)}</a>` : "—"}</div>
      </div>
    </div>

    <div class="emp-profile-assets-sec">
      <h4>Техника сотрудника (${totalCount} поз.)</h4>
      ${assetsHtml}
    </div>

    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px">
      <button type="button" class="secondary" onclick="closeEmployeeDetailsModal()">Закрыть</button>
      <button type="button" class="secondary" onclick="closeEmployeeDetailsModal(); openEditEmployeeModal('${employee.id}')">Редактировать</button>
      <button type="button" class="secondary" onclick="exportEmployeeHandoverCsv('${employee.id}')">Экспорт CSV</button>
      <button type="button" class="secondary" onclick="downloadHandoverSheet('${employee.id}')">Ведомость на подпись</button>
      <button type="button" class="btn-primary" onclick="closeEmployeeDetailsModal(); openOperationModal('issueModal'); setTimeout(() => { const sel = document.getElementById('issueEmployeeSelect'); if(sel) { sel.value = '${employee.id}'; sel.dispatchEvent(new Event('change')); } }, 100);">Выдать технику</button>
    </div>
  `;

  overlay.classList.remove("hidden");
}

function closeEmployeeDetailsModal() {
  document.getElementById("employeeDetailsOverlay")?.classList.add("hidden");
}

function exportEmployeesExcel() {
  const visible = getVisibleEmployees(state.employees);
  if (!visible.length) {
    showToast("Список сотрудников пуст", "warning");
    return;
  }

  const headers = ["ID", "ФИО", "Отдел", "Должность", "Объект", "Телефон", "Email", "Статус", "Техника (шт)"];
  const rows = visible.map((emp, index) => [
    formatEmployeeId(emp, index),
    emp.fullName || "",
    emp.department || "",
    emp.position || "",
    emp.site || "",
    emp.phone || "",
    emp.email || "",
    (emp.status || "active") === "inactive" ? "Уволен" : "Активен",
    getEmployeeAssetCount(emp.id),
  ]);

  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8"><style>table{border-collapse:collapse}th,td{border:1px solid #999;padding:6px 10px;font-family:Arial,sans-serif;font-size:10.5pt}th{background:#dbeafe;font-weight:bold;text-align:left}</style></head>
<body><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></body></html>`;

  const blob = new Blob(["\uFEFF" + html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `Сотрудники_${stamp}.xls`);
  showToast("Список сотрудников выгружен в Excel.", "info");
}

// ─── ОТДЕЛЫ ───────────────────────────────────────────────────
function renderDepartments() {
  const container = document.getElementById("departmentsList");
  if (!container) return;
  if (!state.departments.length) {
    container.innerHTML = `<div class="empty-state"><p>Нет отделов</p></div>`;
    return;
  }
  container.innerHTML = state.departments.map((dept) => {
    const employeesInDept = getVisibleEmployees(state.employees).filter((emp) => emp.department === dept.name);
    const employeeCount = employeesInDept.length;

    // Calculate assets allocated to this department
    const deptAssets = [];
    state.assets.forEach(asset => {
      if (asset.allocations) {
        asset.allocations.forEach(allocation => {
          if (allocation.department === dept.name && allocation.quantity > 0) {
            const existing = deptAssets.find(a => a.id === asset.id);
            if (existing) {
              existing.quantity += allocation.quantity;
            } else {
              deptAssets.push({ id: asset.id, name: asset.name, quantity: allocation.quantity });
            }
          }
        });
      }
    });
    const assetCount = deptAssets.reduce((sum, a) => sum + a.quantity, 0);

    return `<article class="card" data-id="${dept.id}">
      <div class="card-header">
        <strong>${escapeHtml(dept.name)}</strong>
        <div class="card-actions">
          <button type="button" class="secondary" data-action="export-department" data-id="${dept.id}">Экспорт CSV</button>
          <button type="button" class="edit-button" data-action="edit-department" data-id="${dept.id}">Ред.</button>
          <button type="button" class="danger-button" data-action="delete-department" data-id="${dept.id}">Удалить</button>
        </div>
      </div>
      <div class="card-body">
        <p class="card-field"><span class="field-label">Сотрудников:</span> <span class="field-value">${employeeCount}</span></p>
        ${employeesInDept.length ? `<p class="card-field"><span class="field-label">ФИО:</span> <span class="field-value">${employeesInDept.map(e => escapeHtml(e.fullName)).join(", ")}</span></p>` : ""}
        <p class="card-field"><span class="field-label">Техники:</span> <span class="field-value">${assetCount} шт.</span></p>
        ${deptAssets.length ? `<p class="card-field"><span class="field-label">Оборудование:</span> <span class="field-value">${deptAssets.map(a => `${escapeHtml(a.name)} (${a.quantity})`).join(", ")}</span></p>` : ""}
      </div>
    </article>`;
  }).join("");
}

function enterDepartmentEditMode(departmentId) {
  const dept = state.departments.find((d) => d.id === departmentId);
  if (!dept) return;
  const form = document.getElementById("departmentForm");
  form.elements.departmentId.value = dept.id;
  form.elements.name.value = dept.name;
  document.getElementById("departmentFormTitle").textContent = "Редактировать отдел";
  document.getElementById("departmentCancelBtn").classList.remove("hidden");
}

function resetDepartmentForm() {
  const form = document.getElementById("departmentForm");
  form.reset();
  form.elements.departmentId.value = "";
  document.getElementById("departmentFormTitle").textContent = "Добавить отдел";
  document.getElementById("departmentCancelBtn").classList.add("hidden");
}

async function handleDepartmentSubmit(e) {
  e.preventDefault();
  const formData = new FormData(e.target);
  const departmentId = formData.get("departmentId");
  const name = formData.get("name").trim();

  if (!name) {
    showToast("Введите название отдела", "warning");
    return;
  }

  if (departmentId) {
    const dept = state.departments.find((d) => d.id === departmentId);
    if (dept) {
      dept.name = name;
      addAuditEntry("department", departmentId, "update", { name });
      showToast("Отдел обновлен", "success");
    }
  } else {
    const newDept = { id: createId("dept"), name };
    state.departments.push(newDept);
    addAuditEntry("department", newDept.id, "create", { name });
    showToast("Отдел добавлен", "success");
  }

  await persist();
  resetDepartmentForm();
  renderDepartments();
  renderSelects();
}

async function handleDepartmentDelete(departmentId) {
  const dept = state.departments.find((d) => d.id === departmentId);
  if (!dept) return;

  const employeesInDept = getVisibleEmployees(state.employees).filter((emp) => emp.department === dept.name);

  const deptHasAssets = state.assets.some((asset) => {
    const alloc = getDepartmentAllocation(asset, dept.name);
    return alloc && alloc.quantity > 0;
  });
  const employeesWithAssets = employeesInDept.filter((emp) =>
    state.assets.some((asset) => {
      const alloc = getEmployeeAllocation(asset, emp.id);
      return alloc && alloc.quantity > 0;
    })
  );

  if (deptHasAssets || employeesWithAssets.length > 0) {
    const reasons = [];
    if (deptHasAssets) reasons.push("за отделом числится техника");
    if (employeesWithAssets.length > 0) {
      reasons.push(`за сотрудниками числится техника (${employeesWithAssets.map((e) => e.fullName).join(", ")})`);
    }
    showToast(`Невозможно удалить отдел: ${reasons.join("; ")}. Сначала верните технику на склад.`, "warning");
    return;
  }

  const confirmMessage = employeesInDept.length > 0
    ? `Удалить отдел "${dept.name}" вместе со всеми сотрудниками (${employeesInDept.length}): ${employeesInDept.map((e) => e.fullName).join(", ")}?\n\nЭто действие необратимо.`
    : `Удалить отдел "${dept.name}"?`;
  const confirmed = await showConfirm(confirmMessage);
  if (!confirmed) return;

  const employeeIds = employeesInDept.map((e) => e.id);
  // Мягкое удаление, не стирание записи и не чистка движений — см.
  // getVisibleEmployees за причиной (внешний ключ movements.employee_id
  // на сервере и требование ТЗ сохранять историю операций).
  employeesInDept.forEach((emp) => { emp.status = "deleted"; });
  // Стол остаётся, освобождается только хозяин — та же логика, что в
  // deleteEmployee/bulkDeleteEmployees: техника на столе не принадлежала
  // сотруднику лично, и без этой строки стол показывал бы удалённого
  // сотрудника своим хозяином.
  state.workplaces.forEach((workplace) => {
    if (employeeIds.includes(workplace.employeeId)) workplace.employeeId = null;
  });
  state.departments = state.departments.filter((d) => d.id !== departmentId);

  addAuditEntry("department", departmentId, "delete", { name: dept.name, employeesDeleted: employeeIds.length });

  rebuildLookupMaps();
  await persist();
  renderDepartments();
  renderEmployees();
  renderSelects();
  showToast(
    employeeIds.length > 0
      ? `Отдел удалён вместе с ${employeeIds.length} сотрудник(ами).`
      : "Отдел удалён.",
    "success"
  );
}

// ─── SITES (objects) — parallel to departments ────────────────
function renderSites() {
  const container = document.getElementById("sitesList");
  if (!container) return;
  if (!state.sites.length) {
    container.innerHTML = `<div class="empty-state"><p>Нет объектов</p></div>`;
    return;
  }
  container.innerHTML = state.sites.map((site) => {
    const employeesAtSite = getVisibleEmployees(state.employees).filter((emp) => emp.site === site.name);
    const employeeCount = employeesAtSite.length;
    const siteAssets = [];
    state.assets.forEach(asset => {
      (asset.allocations || []).forEach(allocation => {
        if (allocation.site === site.name && allocation.quantity > 0) {
          const existing = siteAssets.find(a => a.id === asset.id);
          if (existing) existing.quantity += allocation.quantity;
          else siteAssets.push({ id: asset.id, name: asset.name, quantity: allocation.quantity });
        }
      });
    });
    const assetCount = siteAssets.reduce((sum, a) => sum + a.quantity, 0);
    return `<article class="card" data-id="${site.id}">
      <div class="card-header">
        <strong>${escapeHtml(site.name)}</strong>
        <div class="card-actions">
          <button type="button" class="secondary" data-action="export-site" data-id="${site.id}">Экспорт CSV</button>
          <button type="button" class="edit-button" data-action="edit-site" data-id="${site.id}">Ред.</button>
          <button type="button" class="danger-button" data-action="delete-site" data-id="${site.id}">Удалить</button>
        </div>
      </div>
      <div class="card-body">
        <p class="card-field"><span class="field-label">Сотрудников:</span> <span class="field-value">${employeeCount}</span></p>
        ${employeesAtSite.length ? `<p class="card-field"><span class="field-label">ФИО:</span> <span class="field-value">${employeesAtSite.map(e => escapeHtml(e.fullName)).join(", ")}</span></p>` : ""}
        <p class="card-field"><span class="field-label">Техники:</span> <span class="field-value">${assetCount} шт.</span></p>
        ${siteAssets.length ? `<p class="card-field"><span class="field-label">Оборудование:</span> <span class="field-value">${siteAssets.map(a => `${escapeHtml(a.name)} (${a.quantity})`).join(", ")}</span></p>` : ""}
      </div>
    </article>`;
  }).join("");
}

function enterSiteEditMode(siteId) {
  const site = state.sites.find((s) => s.id === siteId);
  if (!site) return;
  const form = document.getElementById("siteForm");
  form.elements.siteId.value = site.id;
  form.elements.name.value = site.name;
  document.getElementById("siteFormTitle").textContent = "Редактировать объект";
  document.getElementById("siteCancelBtn").classList.remove("hidden");
}

function resetSiteForm() {
  const form = document.getElementById("siteForm");
  if (!form) return;
  form.reset();
  form.elements.siteId.value = "";
  document.getElementById("siteFormTitle").textContent = "Добавить объект";
  document.getElementById("siteCancelBtn").classList.add("hidden");
}

async function handleSiteSubmit(e) {
  e.preventDefault();
  const formData = new FormData(e.target);
  const siteId = formData.get("siteId");
  const name = (formData.get("name") || "").trim();
  if (!name) { showToast("Введите название объекта", "warning"); return; }

  if (siteId) {
    const site = state.sites.find((s) => s.id === siteId);
    if (site) {
      const oldName = site.name;
      site.name = name;
      // keep employee/allocation references in sync with the renamed object
      if (oldName !== name) {
        state.employees.forEach((emp) => { if (emp.site === oldName) emp.site = name; });
        state.assets.forEach((a) => a.allocations.forEach((al) => { if (al.site === oldName) al.site = name; }));
        state.movements.forEach((m) => { if (m.site === oldName) m.site = name; });
      }
      addAuditEntry("site", siteId, "update", { name });
      showToast("Объект обновлён", "success");
    }
  } else {
    const newSite = { id: createId("site"), name };
    state.sites.push(newSite);
    addAuditEntry("site", newSite.id, "create", { name });
    showToast("Объект добавлен", "success");
  }

  await persist();
  resetSiteForm();
  renderSites();
  renderSelects();
}

function handleSiteDelete(siteId) {
  const site = state.sites.find((s) => s.id === siteId);
  if (!site) return;
  const employeeCount = getVisibleEmployees(state.employees).filter((emp) => emp.site === site.name).length;
  if (employeeCount > 0) {
    showToast(`Невозможно удалить: к объекту привязано ${employeeCount} сотрудник(ов)`, "warning");
    return;
  }
  const hasAssets = state.assets.some((a) => a.allocations.some((al) => al.site === site.name && al.quantity > 0));
  if (hasAssets) {
    showToast("Невозможно удалить: на объекте числится техника", "warning");
    return;
  }
  if (confirm(`Удалить объект "${site.name}"?`)) {
    state.sites = state.sites.filter((s) => s.id !== siteId);
    addAuditEntry("site", siteId, "delete", { name: site.name });
    persist();
    renderSites();
    renderSelects();
    showToast("Объект удалён", "success");
  }
}

// ─── РАБОЧИЕ МЕСТА ──────────────────────────────────────────────
// Техника, числящаяся за столом.
function getWorkplaceAssets(workplaceId) {
  return state.assets
    .map((asset) => ({ asset, allocation: getWorkplaceAllocation(asset, workplaceId) }))
    .filter((entry) => entry.allocation && entry.allocation.quantity > 0);
}

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

// Общая отрисовка списка «инв.№ / название / кол-во» для обоих мест
// использования: панель выдачи и карточка сотрудника.
function renderHoldingsList(entries) {
  return `<ul class="held-list">` + entries.map(({ asset, allocation }) =>
    `<li><code>${escapeHtml(asset.inventoryNumber || "—")}</code><span>${escapeHtml(asset.name)}</span><b>${allocation.quantity} шт.</b></li>`
  ).join("") + `</ul>`;
}

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
    // Составная подпись вместо одного «Выдано:»: на рабочем месте дата
    // относится к столу, а не к текущему хозяину (стол мог сменить
    // владельца без новой выдачи), и когда движение покрывает не всё
    // количество записи (частями довыдавали), дата тоже только «последняя»,
    // а не «когда пришло всё».
    const verb = movement && movement.quantity < allocation.quantity ? "Последняя выдача" : "Выдано";
    const target = recipient.workplaceId ? " на место" : "";
    const issueLabel = `${verb}${target}`;
    return `<li>
      <code>${escapeHtml(asset.inventoryNumber || "—")}</code><span>${escapeHtml(asset.name)}</span><b>${allocation.quantity} шт.</b>
      <div class="held-item-meta">${escapeHtml(issueLabel)}: ${escapeHtml(dateText)} · ${escapeHtml(opText)} · Статус: ${escapeHtml(statusText)}${noteText}</div>
    </li>`;
  }).join("") + `</ul>`;
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

// ─── ПЕРЕМЕЩЕНИЯ: ТАБЛИЦА ────────────────────────────────────────
function renderMovementTable() {
  if (!state.movements.length) {
    dom.movementsTableBody.innerHTML = `<tr><td colspan="8"><div class="empty-state">Журнал пока пуст.</div></td></tr>`;
    return;
  }
  const query = normalizeSearchValue(dom.movementSearchInput?.value);
  const rows = [...state.movements]
    .sort((a, b) => AssetOps.movementSortValue(b) - AssetOps.movementSortValue(a))
    .filter((movement) => {
      const asset = getAssetById(movement.assetId);
      const employee = getEmployeeById(movement.employeeId);
      return matchesSearch(query, movementLabels[movement.type], movement.type, movement.date, asset?.name, asset?.category, asset?.serialNumber, employee?.fullName, movement.notes);
    });
  if (!rows.length) {
    dom.movementsTableBody.innerHTML = `<tr><td colspan="8"><div class="empty-state">Ничего не найдено.</div></td></tr>`;
    return;
  }
  dom.movementsTableBody.innerHTML = rows.map((movement) => {
    const asset = getAssetById(movement.assetId);
    const employee = getEmployeeById(movement.employeeId);
    const actButton = movement.type === "issue" || movement.type === "return"
      ? `<button type="button" class="edit-button" data-action="print-act" data-id="${movement.id}">Акт</button>`
      : "";
    return `<tr><td>${movementDateLabel(movement)}</td><td>${movementLabels[movement.type] || movement.type}</td><td>${asset ? asset.name : "-"}</td><td>${asset ? (asset.inventoryNumber || "Отсутствует") : "-"}</td><td>${movement.quantity ? movement.quantity + " шт." : "-"}</td><td>${employee ? employee.fullName : "Склад"}</td><td>${movement.notes || ""}</td><td><div class="row-actions">${actButton}</div></td></tr>`;
  }).join("");
}

// ─── ОТЧЁТЫ ───────────────────────────────────────────────────
function renderReports() {
  const query = normalizeSearchValue(dom.reportSearchInput?.value);
  const inStock = state.assets.filter((asset) => getAvailableQuantity(asset) > 0)
    .filter((asset) => matchesSearch(query, asset.name, asset.category, asset.inventoryNumber, asset.serialNumber, asset.notes));
  dom.inStockReport.innerHTML = inStock.length ? inStock.map((asset) => `<article class="list-item"><div class="title-line"><strong>${asset.name}</strong><span class="chip ok">${getAvailableQuantity(asset)} из ${asset.quantity}</span></div><p class="muted">${asset.category}</p><p>Дата покупки: ${formatDate(asset.purchaseDate)}</p></article>`).join("") : "";
  if (!inStock.length) appendEmptyState(dom.inStockReport);

  const employeesWithAssets = state.employees.map((employee) => ({
    employee,
    items: state.assets.map((asset) => {
      const allocation = getEmployeeAllocation(asset, employee.id);
      return allocation ? `${asset.name} (${allocation.quantity}) · S/N: ${asset.serialNumber || "-"}` : null;
    }).filter(Boolean),
  })).filter((entry) => entry.items.length)
    .filter((entry) => matchesSearch(query, entry.employee.fullName, entry.employee.department, entry.employee.position, entry.items.join(", ")));

  dom.employeeBalanceReport.innerHTML = employeesWithAssets.length ? employeesWithAssets.map(({ employee, items }) => `<article class="list-item"><div class="title-line"><strong>${employee.fullName}</strong><span class="chip warn">${items.length} поз.</span></div><p class="muted">${employee.department}</p><p>${items.join(", ")}</p></article>`).join("") : "";
  if (!employeesWithAssets.length) appendEmptyState(dom.employeeBalanceReport);
}

function getIssueAssets() {
  return state.assets.filter((asset) => getAvailableQuantity(asset) > 0 && asset.status !== "repair" && asset.status !== "retired");
}

function getReturnAssets(employeeId) {
  if (!employeeId) return [];
  return state.assets.filter((asset) => {
    const allocation = getEmployeeAllocation(asset, employeeId);
    return allocation && allocation.quantity > 0;
  });
}

function getDepartmentReturnAssets(department) {
  if (!department) return [];
  return state.assets.filter((asset) => {
    const allocation = getDepartmentAllocation(asset, department);
    return allocation && allocation.quantity > 0;
  });
}

function getSiteReturnAssets(site) {
  if (!site) return [];
  return state.assets.filter((asset) => {
    const allocation = getSiteAllocation(asset, site);
    return allocation && allocation.quantity > 0;
  });
}

function makeAssetOptions(assets, qtyLabel, selectedAssetId = "") {
  if (!assets.length) return `<option value="">Нет доступной техники</option>`;
  return assets.map((asset) => {
    const qty = qtyLabel(asset);
    const selected = String(asset.id) === String(selectedAssetId || "") ? " selected" : "";
    return `<option value="${asset.id}"${selected}>${assetShortLabel(asset)} (${qty})</option>`;
  }).join("");
}

// ─── ФОРМЫ ОПЕРАЦИЙ (выдача / возврат / ремонт / списание) ──────

// Откуда берутся позиции и как подписывается доступное количество.
// Возврат зависит от выбранного получателя, выдача — всегда склад.
function getOperationPool(kind) {
  if (kind === "issue") {
    return {
      assets: getIssueAssets(),
      quantity: (asset) => getAvailableQuantity(asset),
      label: "остаток",
    };
  }
  const target = document.querySelector('input[name="returnTarget"]:checked')?.value || "employee";
  if (target === "department") {
    const dept = document.getElementById("returnDepartmentSelect")?.value || "";
    return {
      assets: getDepartmentReturnAssets(dept),
      quantity: (asset) => getDepartmentAllocation(asset, dept)?.quantity || 0,
      label: "в отделе",
    };
  }
  if (target === "site") {
    const site = document.getElementById("returnSiteSelect")?.value || "";
    return {
      assets: getSiteReturnAssets(site),
      quantity: (asset) => getSiteAllocation(asset, site)?.quantity || 0,
      label: "на объекте",
    };
  }
  if (target === "workplace") {
    const workplaceId = document.getElementById("returnWorkplaceSelect")?.value || "";
    return {
      assets: state.assets.filter((asset) => (getWorkplaceAllocation(asset, workplaceId)?.quantity || 0) > 0),
      quantity: (asset) => getWorkplaceAllocation(asset, workplaceId)?.quantity || 0,
      label: "на месте",
    };
  }
  const employeeId = dom.returnEmployeeSelect?.value || "";
  return {
    assets: getReturnAssets(employeeId),
    quantity: (asset) => getEmployeeAllocation(asset, employeeId)?.quantity || 0,
    label: "на руках",
  };
}

const ASSET_PICKER_LIMIT = 40;

/**
 * Поле выбора техники: печатаешь — под полем появляются подходящие
 * позиции, щёлкаешь нужную.
 *
 * Раньше здесь были отдельные поле поиска и <select>. Поиск прятал
 * <option> и умел сравнивать запрос только с первой группой цифр, то
 * есть не работал почти никогда, а главное — не трогал выбранное
 * значение: после неудачного поиска в списке оставалась первая позиция,
 * и в выдачу уходила именно она. Здесь выбранного по умолчанию нет
 * вовсе, поэтому выдать не то, что искал, нельзя по построению.
 */
function createAssetPicker(kind) {
  const wrap = document.createElement("div");
  wrap.className = "asset-picker";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "asset-picker-input";
  input.placeholder = "Название, инв. номер или серийник";
  input.autocomplete = "off";

  // Скрытое поле хранит id выбранной позиции. Класс тот же, что был у
  // <select>, поэтому обработчики отправки читают его без изменений.
  const value = document.createElement("input");
  value.type = "hidden";
  value.className = kind === "issue" ? "issue-asset-select" : "return-asset-select";

  const list = document.createElement("div");
  list.className = "asset-picker-list hidden";

  wrap.append(input, value, list);

  let matches = [];
  let active = -1;

  const close = () => { list.classList.add("hidden"); active = -1; };

  const choose = (asset) => {
    const { quantity, label } = getOperationPool(kind);
    value.value = asset.id;
    input.value = `${asset.inventoryNumber ? asset.inventoryNumber + " · " : ""}${assetShortLabel(asset)}`;
    wrap.dataset.available = String(quantity(asset));
    wrap.classList.add("chosen");
    const qtyInput = wrap.parentElement?.querySelector("input[type=number]");
    if (qtyInput) {
      qtyInput.max = String(quantity(asset));
      qtyInput.value = String(Math.min(Number(qtyInput.value || 1) || 1, quantity(asset)));
    }
    wrap.querySelector(".asset-picker-note")?.remove();
    const note = document.createElement("span");
    note.className = "asset-picker-note";
    note.textContent = `${label}: ${quantity(asset)}`;
    wrap.appendChild(note);
    close();
  };

  const render = () => {
    const pool = getOperationPool(kind);
    matches = AssetOps.searchAssets(pool.assets, input.value);
    if (!pool.assets.length) {
      list.innerHTML = `<div class="asset-picker-empty">Нет доступной техники</div>`;
    } else if (!matches.length) {
      list.innerHTML = `<div class="asset-picker-empty">Ничего не найдено</div>`;
    } else {
      const shown = matches.slice(0, ASSET_PICKER_LIMIT);
      list.innerHTML = shown.map((asset, index) => `
        <button type="button" class="asset-picker-option${index === active ? " active" : ""}" data-id="${escapeHtml(asset.id)}">
          <span class="asset-picker-code">${escapeHtml(asset.inventoryNumber || "—")}</span>
          <span class="asset-picker-name">${escapeHtml(assetShortLabel(asset))}</span>
          <span class="asset-picker-qty">${pool.label}: ${pool.quantity(asset)}</span>
        </button>`).join("")
        + (matches.length > shown.length
          ? `<div class="asset-picker-empty">Показаны первые ${ASSET_PICKER_LIMIT} из ${matches.length} — уточните запрос</div>`
          : "");
    }
    list.classList.remove("hidden");
  };

  input.addEventListener("input", () => {
    // Правка текста снимает выбор: иначе в поле осталась бы одна
    // позиция, а отправилась другая — ровно та ошибка, что была.
    value.value = "";
    wrap.classList.remove("chosen");
    wrap.querySelector(".asset-picker-note")?.remove();
    active = -1;
    render();
  });
  input.addEventListener("focus", render);

  input.addEventListener("keydown", (event) => {
    const shown = Math.min(matches.length, ASSET_PICKER_LIMIT);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!shown) return;
      event.preventDefault();
      active = event.key === "ArrowDown"
        ? (active + 1) % shown
        : (active <= 0 ? shown - 1 : active - 1);
      render();
      list.querySelectorAll(".asset-picker-option")[active]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      if (active >= 0 && matches[active]) { event.preventDefault(); choose(matches[active]); }
    } else if (event.key === "Escape") {
      close();
    }
  });

  list.addEventListener("mousedown", (event) => {
    // mousedown, а не click: blur успел бы закрыть список раньше клика.
    const option = event.target.closest(".asset-picker-option");
    if (!option) return;
    event.preventDefault();
    const asset = getAssetById(option.dataset.id);
    if (asset) choose(asset);
  });

  input.addEventListener("blur", () => setTimeout(close, 0));

  // Пересобрать подпись остатка и снять выбор, если позиция выбыла из
  // доступных (её выдали из другого окна, отправили в ремонт и т.п.).
  wrap.refresh = () => {
    if (!value.value) return;
    const pool = getOperationPool(kind);
    const asset = pool.assets.find((item) => String(item.id) === String(value.value));
    if (!asset) {
      value.value = "";
      input.value = "";
      wrap.classList.remove("chosen");
      wrap.querySelector(".asset-picker-note")?.remove();
      return;
    }
    choose(asset);
  };

  return wrap;
}

function createOperationItemRow(kind) {
  const row = document.createElement("div");
  row.className = "operation-item-row";
  const picker = createAssetPicker(kind);
  const qty = document.createElement("input");
  qty.type = "number";
  qty.min = "1";
  qty.step = "1";
  qty.value = "1";
  qty.required = true;
  qty.className = kind === "issue" ? "issue-quantity-input" : "return-quantity-input";
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "danger-button";
  removeBtn.textContent = "Убрать";
  removeBtn.addEventListener("click", () => {
    const container = kind === "issue" ? dom.issueItems : dom.returnItems;
    row.remove();
    if (!container.children.length) {
      if (kind === "issue") addIssueItemRow();
      else addReturnItemRow();
    }
  });
  row.append(picker, qty, removeBtn);
  return row;
}

// Предвыбранная позиция приходит из комплектов и из кнопки «Выдать» в
// строке техники — подставляем её так же, как это сделал бы человек.
function presetPickerAsset(row, assetId) {
  if (!assetId) return;
  const picker = row.querySelector(".asset-picker");
  const asset = getAssetById(assetId);
  if (picker && asset) {
    picker.querySelector("input[type=hidden]").value = String(assetId);
    picker.refresh();
  }
}

function addIssueItemRow(selectedAssetId = "", quantity = 1) {
  const row = createOperationItemRow("issue");
  row.querySelector(".issue-quantity-input").value = Math.max(1, Number(quantity || 1));
  dom.issueItems.appendChild(row);
  presetPickerAsset(row, selectedAssetId);
}

function addReturnItemRow(selectedAssetId = "", quantity = 1) {
  const row = createOperationItemRow("return");
  row.querySelector(".return-quantity-input").value = Math.max(1, Number(quantity || 1));
  dom.returnItems.appendChild(row);
  presetPickerAsset(row, selectedAssetId);
}

function getManualActAssets() {
  const type = String(dom.manualActTypeSelect?.value || "issue");
  const employeeId = String(dom.manualActEmployeeSelect?.value || "");
  if (type === "return") return getReturnAssets(employeeId);
  return getIssueAssets();
}

function addManualActItemRow(selectedAssetId = "", quantity = 1) {
  const row = document.createElement("div");
  row.className = "operation-item-row";
  const select = document.createElement("select");
  select.required = true;
  select.className = "manual-act-asset-select";
  const qty = document.createElement("input");
  qty.type = "number";
  qty.min = "1";
  qty.step = "1";
  qty.value = String(Math.max(1, Number(quantity || 1)));
  qty.required = true;
  qty.className = "manual-act-quantity-input";
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "danger-button";
  removeBtn.textContent = "Убрать";
  removeBtn.addEventListener("click", () => {
    row.remove();
    if (!dom.manualActItems.children.length) addManualActItemRow();
  });
  row.append(select, qty, removeBtn);
  dom.manualActItems.appendChild(row);
  updateManualActAssetOptions();
  if (selectedAssetId) select.value = String(selectedAssetId);
}

function updateManualActAssetOptions() {
  const assets = getManualActAssets();
  const type = String(dom.manualActTypeSelect?.value || "issue");
  const employeeId = String(dom.manualActEmployeeSelect?.value || "");
  dom.manualActItems?.querySelectorAll(".manual-act-asset-select").forEach((select) => {
    const selected = select.value;
    select.innerHTML = makeAssetOptions(assets, (asset) => {
      if (type === "return") {
        const allocation = getEmployeeAllocation(asset, employeeId);
        return `на руках: ${allocation ? allocation.quantity : 0}`;
      }
      return `остаток: ${getAvailableQuantity(asset)}`;
    }, selected);
  });
}

// Позиции больше не перерисовываются списком опций — каждое поле выбора
// само пересобирает подпись остатка и снимает выбор, если позиция выбыла
// из доступных.
function updateIssueAssetOptions() {
  dom.issueItems.querySelectorAll(".asset-picker").forEach((picker) => picker.refresh());
}

function updateReturnAssetOptions() {
  dom.returnItems.querySelectorAll(".asset-picker").forEach((picker) => picker.refresh());
}

// Что уже числится за выбранным получателем выдачи. Видно сразу при
// выборе сотрудника — чтобы не выдать вторую мышь тому, у кого она есть.
function renderIssueEmployeeAssets() {
  const box = document.getElementById("issueEmployeeAssets");
  if (!box) return;
  const target = document.querySelector('input[name="issueTarget"]:checked')?.value || "employee";
  const employeeId = target === "employee" ? (dom.issueEmployeeSelect?.value || "") : "";
  if (!employeeId) { box.classList.add("hidden"); box.innerHTML = ""; return; }

  const { personal, workplace, atWorkplace } = getEmployeeHoldings(employeeId);
  box.classList.remove("hidden");
  if (!personal.length && !atWorkplace.length) {
    box.innerHTML = `<div class="held-title empty">Техники за сотрудником нет</div>`;
    return;
  }
  box.innerHTML =
    (atWorkplace.length ? `<div class="held-title">На рабочем месте · ${escapeHtml(workplace.name)}</div>` + renderHoldingsList(atWorkplace) : "")
    + (personal.length ? `<div class="held-title">Лично на руках · ${personal.length}</div>` + renderHoldingsList(personal) : "");
}

function updateRepairAssetOptions() {
  const location = parseLocationValue(dom.repairSourceSelect?.value);
  if (location.type === "employee" && !location.employeeId) {
    dom.repairAssetSelect.innerHTML = `<option value="">Нет техники у сотрудника</option>`;
    return;
  }
  const sourceAssets = state.assets.filter((asset) => {
    if (location.type === "warehouse") return getAvailableQuantity(asset) > 0;
    const allocation = getEmployeeAllocation(asset, location.employeeId);
    return allocation && allocation.quantity > 0;
  });
  dom.repairAssetSelect.innerHTML = sourceAssets.length
    ? sourceAssets.map((asset) => {
        if (location.type === "warehouse") {
          return `<option value="${asset.id}">${asset.name} (доступно: ${getAvailableQuantity(asset)})</option>`;
        }
        const allocation = getEmployeeAllocation(asset, location.employeeId);
        return `<option value="${asset.id}">${asset.name} (у сотрудника: ${allocation.quantity})</option>`;
      }).join("")
    : `<option value="">Нет техники для выбранного источника</option>`;
}

function renderSelects() {
  const employees = state.employees.filter((e) => e.department);
  const departmentOptions = state.departments.length
    ? state.departments.map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`).join("")
    : `<option value="">Нет отделов</option>`;
  const siteOptions = state.sites.length
    ? state.sites.map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join("")
    : `<option value="">Нет объектов</option>`;
  const employeeOptions = getVisibleEmployees(state.employees)
    .map((e) => `<option value="${e.id}">${escapeHtml(e.fullName)}</option>`)
    .join("");
  const activeEmployeeOptions = getActiveEmployees(state.employees)
    .map((e) => `<option value="${e.id}">${escapeHtml(e.fullName)}</option>`)
    .join("");

  const employeeDeptSelect = document.getElementById("employeeDepartmentSelect");
  if (employeeDeptSelect) {
    const current = employeeDeptSelect.value;
    employeeDeptSelect.innerHTML = '<option value="">Выберите отдел</option>' + departmentOptions;
    employeeDeptSelect.value = current;
  }
  const employeeSiteSelect = document.getElementById("employeeSiteSelect");
  if (employeeSiteSelect) {
    const current = employeeSiteSelect.value;
    employeeSiteSelect.innerHTML = '<option value="">— без объекта —</option>' +
      (state.sites.length ? state.sites.map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join("") : "");
    employeeSiteSelect.value = current;
  }
  const locationOptions = [`<option value="warehouse">Склад</option>`]
    .concat(getVisibleEmployees(state.employees).map((employee) => `<option value="employee:${employee.id}">${employee.fullName}</option>`))
    .join("");
  const stockAssets = state.assets.filter((asset) => getAvailableQuantity(asset) > 0);
  const repairAssets = state.assets.filter((asset) => Number(asset.repairQuantity || 0) > 0);
  const selectedRepairSource = dom.repairSourceSelect?.value || "warehouse";
  const selectedRepairTarget = dom.repairReturnTargetSelect?.value || "warehouse";
  dom.issueEmployeeSelect.innerHTML = activeEmployeeOptions;
  dom.returnEmployeeSelect.innerHTML = employeeOptions;
  dom.manualActEmployeeSelect.innerHTML = employeeOptions;
  const issueDeptSelect = document.getElementById("issueDepartmentSelect");
  if (issueDeptSelect) issueDeptSelect.innerHTML = departmentOptions;
  const issueSiteSelect = document.getElementById("issueSiteSelect");
  if (issueSiteSelect) issueSiteSelect.innerHTML = siteOptions;
  const returnDeptSelect = document.getElementById("returnDepartmentSelect");
  if (returnDeptSelect) {
    // For returns, only show departments that actually have allocations
    const deptsWithAlloc = new Set();
    state.assets.forEach((a) => a.allocations.forEach((al) => { if (al.department && al.quantity > 0) deptsWithAlloc.add(al.department); }));
    const deptList = [...deptsWithAlloc].sort();
    returnDeptSelect.innerHTML = deptList.length
      ? deptList.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("")
      : `<option value="">Нет отделов с техникой</option>`;
  }
  const returnSiteSelect = document.getElementById("returnSiteSelect");
  if (returnSiteSelect) {
    const sitesWithAlloc = new Set();
    state.assets.forEach((a) => a.allocations.forEach((al) => { if (al.site && al.quantity > 0) sitesWithAlloc.add(al.site); }));
    const siteList = [...sitesWithAlloc].sort();
    returnSiteSelect.innerHTML = siteList.length
      ? siteList.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")
      : `<option value="">Нет объектов с техникой</option>`;
  }
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
  updateIssueAssetOptions();
  dom.repairSourceSelect.innerHTML = locationOptions;
  dom.repairSourceSelect.value = selectedRepairSource;
  if (!dom.repairSourceSelect.value) dom.repairSourceSelect.value = "warehouse";
  updateRepairAssetOptions();
  dom.repairReturnTargetSelect.innerHTML = locationOptions;
  dom.repairReturnTargetSelect.value = selectedRepairTarget;
  if (!dom.repairReturnTargetSelect.value) dom.repairReturnTargetSelect.value = "warehouse";
  dom.repairReturnAssetSelect.innerHTML = repairAssets.length ? repairAssets.map((asset) => `<option value="${asset.id}">${asset.name} (в ремонте: ${asset.repairQuantity})</option>`).join("") : `<option value="">Нет техники в ремонте</option>`;
  dom.retireAssetSelect.innerHTML = stockAssets.length ? stockAssets.map((asset) => `<option value="${asset.id}">${asset.name} (доступно: ${getAvailableQuantity(asset)})</option>`).join("") : `<option value="">Нет техники на складе</option>`;
  updateReturnAssetOptions();
  updateManualActAssetOptions();
}

// ─── МОДАЛЬНЫЕ ОКНА И НОМЕРА АКТОВ ──────────────────────────────
function renderLastUpdate() {
  dom.lastUpdateLabel.textContent = state.meta.updatedAt ? `Обновлено: ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(state.meta.updatedAt))}` : "Нет изменений";
}

function openOperationModal(modalId) {
  dom.modalOverlay.classList.remove("hidden");
  dom.modalOverlay.querySelectorAll(".operation-modal").forEach((modal) => {
    modal.classList.toggle("hidden", modal.id !== modalId);
  });
}

function closeOperationModal() {
  dom.modalOverlay.classList.add("hidden");
  dom.modalOverlay.querySelectorAll(".operation-modal").forEach((modal) => modal.classList.add("hidden"));
}

function getNextActNumber() {
  const maxActNumber = state.movements.reduce((max, movement) => {
    return Number(movement.actNumber || 0) > max ? Number(movement.actNumber) : max;
  }, 0);
  return maxActNumber + 1;
}

function resolveActNumber(movement) {
  if (movement.actNumber) return movement.actNumber;
  const orderedActs = [...state.movements]
    .filter((entry) => entry.type === "issue" || entry.type === "return")
    .sort((a, b) => dateSortKey(a.date) - dateSortKey(b.date));
  return orderedActs.findIndex((entry) => entry.id === movement.id) + 1;
}

// ─── DASHBOARD ALERTS ──────────────────────────────────────────
// (renderDashboardAlerts() was removed here — see renderAttentionPanel()
// below. That pre-existing function duplicated warranty/low-stock/
// long-repair signals with its own hardcoded 30/14/7-day thresholds,
// independent of and disagreeing with the server-computed, admin-
// configurable attention panel. Per spec ("считается один раз на сервере,
// не дублируется"), the server-computed panel is the single source of
// truth for this — this client-side duplicate is intentionally gone, not
// merely disabled.)

const ATTENTION_LABELS = { warranty: "Гарантия", low_stock: "Мало на складе", long_repair: "Долгий ремонт" };

function renderAttentionPanel() {
  const panel = document.getElementById("attentionPanel");
  const list = document.getElementById("attentionPanelList");
  if (!panel || !list) return;
  const items = state.attentionItems || [];
  panel.classList.toggle("hidden", items.length === 0);
  if (items.length === 0) { list.innerHTML = ""; return; }
  list.innerHTML = items.map((item) => `
    <li class="attention-item attention-${item.type}" data-asset-id="${item.assetId}">
      <span class="attention-label">${ATTENTION_LABELS[item.type] || item.type}</span>
      <span class="attention-name">${escapeHtml(item.assetName)}</span>
      <span class="attention-detail">${escapeHtml(item.detail)}</span>
      ${item.type === "warranty" ? `<button type="button" class="secondary attention-action" data-action="extend-warranty" data-asset-id="${item.assetId}">Гарантия</button>` : ""}
    </li>
  `).join("");
  list.querySelectorAll(".attention-item").forEach((el) => {
    el.addEventListener("click", (event) => {
      // Кнопка «Гарантия» открывает своё окно и не должна ещё и уводить
      // на полную форму редактирования — тот же клик не должен делать
      // два разных действия сразу.
      if (event.target.closest('[data-action="extend-warranty"]')) return;
      enterAssetEditMode(el.dataset.assetId);
    });
  });
  list.querySelectorAll('[data-action="extend-warranty"]').forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      openWarrantyExtendModal(btn.dataset.assetId);
    });
  });
}

// ─── ПРОДЛЕНИЕ ГАРАНТИИ ───────────────────────────────────────────
// Дата окончания гарантии и так редактируется как обычное поле — в форме
// техники и через inline-правку в «Реестре» (setupRegistryInlineEdit).
// Это отдельное окно — не новый способ хранить дату, а быстрый путь к
// тому же полю прямо из панели «Требует внимания», в момент, когда
// пользователь и так смотрит на просроченную/истекающую гарантию, без
// похода в полную форму редактирования техники.
//
// Раньше выбор расчёта даты был отдельной галочкой «гарантия
// обновлена». Её убрали: пользователь не может знать, какой из двух
// отсчётов имел в виду автор кода, а ответ выводится из самой даты.
// Гарантия ещё действует — продлеваем на год от её окончания (обычная
// пролонгация на тот же срок); уже истекла — год от сегодня, потому что
// отсчёт от просроченной даты предложил бы дату в прошлом. В обоих
// случаях это лишь подсказка в поле, любую другую дату можно вписать
// руками.
function warrantyExtendSuggestedDate(asset, todayIso) {
  const end = asset.warrantyEnd || "";
  const base = end && end > todayIso ? new Date(end) : new Date(todayIso);
  const suggested = new Date(base);
  suggested.setFullYear(suggested.getFullYear() + 1);
  return suggested.toISOString().slice(0, 10);
}

function openWarrantyExtendModal(assetId) {
  const asset = getAssetById(assetId);
  if (!asset) return;
  document.getElementById("warrantyExtendAssetId").value = assetId;
  document.getElementById("warrantyExtendAssetName").textContent = asset.name || "";
  const dateInput = document.getElementById("warrantyExtendDateInput");
  if (dateInput) dateInput.value = warrantyExtendSuggestedDate(asset, today());
  // Кнопка «Не напоминать» бессмысленна, когда напоминать уже не о чем:
  // даты нет или её напоминание и так снято.
  const dismissBtn = document.getElementById("warrantyDismissBtn");
  if (dismissBtn) dismissBtn.hidden = !asset.warrantyEnd || Boolean(asset.warrantyReminderOff);
  document.getElementById("warrantyExtendOverlay")?.classList.remove("hidden");
}

function closeWarrantyExtendModal() {
  document.getElementById("warrantyExtendOverlay")?.classList.add("hidden");
}

// Новая дата отменяет снятое напоминание: гарантию продлили или
// исправили — значит, о ней снова есть смысл напоминать, когда срок
// подойдёт. Иначе один давний клик по «Не напоминать» молча глушил бы
// напоминание уже про ДРУГУЮ, действующую гарантию. Единая точка для
// всех трёх путей правки даты: это окно, форма техники и inline-правка
// в «Реестре».
function applyWarrantyEnd(asset, newDate) {
  const value = newDate || "";
  if ((asset.warrantyEnd || "") !== value) asset.warrantyReminderOff = false;
  asset.warrantyEnd = value;
}

async function handleWarrantyExtendSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const assetId = String(formData.get("assetId") || "");
  const asset = getAssetById(assetId);
  if (!asset) { closeWarrantyExtendModal(); return; }
  const newDate = String(formData.get("warrantyEnd") || "");
  if (!newDate) {
    showToast("Укажите дату.", "warning");
    return;
  }
  const oldDate = asset.warrantyEnd || "";
  if (newDate === oldDate) { closeWarrantyExtendModal(); return; }
  applyWarrantyEnd(asset, newDate);
  // Тот же журнал изменений, что и у inline-правки в «Реестре»
  // (commitRegistryEdit) — одно и то же поле, одна и та же запись в
  // истории, независимо от того, откуда его поменяли.
  addAuditEntry("asset", assetId, "edit", { warrantyEnd: { from: oldDate, to: newDate } });
  closeWarrantyExtendModal();
  await persist();
  showToast(`Гарантия продлена до ${formatDate(newDate)}.`, "success");
}

// Снятие напоминания — не стирание даты. У старых серверов и ИБП
// гарантия давно истекла и продлевать нечего, но дата её окончания —
// настоящий факт: обнулив поле, мы получили бы в реестре «Неизвестно»,
// то есть соврали бы о технике ради тишины в панели. Поэтому дата
// остаётся, а из «Требует внимания» запись убирает отдельный флаг
// (server.compute_attention_items).
//
// Подтверждения нет намеренно: снимать напоминания приходится пачками,
// а действие обратимо — достаточно вписать дату гарантии заново, и
// напоминание вернётся (applyWarrantyEnd).
async function handleWarrantyDismiss() {
  const assetId = String(document.getElementById("warrantyExtendAssetId")?.value || "");
  const asset = getAssetById(assetId);
  if (!asset) { closeWarrantyExtendModal(); return; }
  if (!asset.warrantyEnd || asset.warrantyReminderOff) { closeWarrantyExtendModal(); return; }
  asset.warrantyReminderOff = true;
  addAuditEntry("asset", assetId, "edit", { warrantyReminderOff: { from: false, to: true } });
  closeWarrantyExtendModal();
  await persist();
  showToast(`Напоминание снято: ${asset.name}. Гарантия до ${formatDate(asset.warrantyEnd)} осталась в реестре.`, "success");
}


// ─── CHARTS ──────────────────────────────────────────────────────
let chartMovementsInstance = null;
let chartCategoriesInstance = null;

function renderCharts() {
  if (typeof Chart === "undefined") return;
  renderMovementsChart();
  renderCategoriesChart();
}

function renderMovementsChart() {
  const ctx = document.getElementById("chartMovements");
  if (!ctx) return;

  const now = new Date();
  const labels = [];
  const issueData = [];
  const returnData = [];

  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    labels.push(key.slice(5));
    issueData.push(0);
    returnData.push(0);
  }

  state.movements.forEach((m) => {
    const idx = labels.indexOf((m.date || "").slice(5));
    if (idx === -1) return;
    if (m.type === "issue") issueData[idx] += (m.quantity || 1);
    if (m.type === "return") returnData[idx] += (m.quantity || 1);
  });

  if (chartMovementsInstance) chartMovementsInstance.destroy();
  chartMovementsInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Выдачи", data: issueData, backgroundColor: "rgba(59,130,246,0.7)", borderRadius: 3 },
        { label: "Возвраты", data: returnData, backgroundColor: "rgba(34,197,94,0.7)", borderRadius: 3 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#8aa0bc", font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: "#4e6480", font: { size: 10 } }, grid: { color: "rgba(99,136,196,0.08)" } },
        y: { beginAtZero: true, ticks: { color: "#4e6480", stepSize: 1 }, grid: { color: "rgba(99,136,196,0.08)" } },
      },
    },
  });
}

let categoryChartPage = 0;
const CATEGORIES_PER_PAGE = 6;

function getCategoryData() {
  const catMap = {};
  state.assets.forEach((a) => {
    const cat = a.category || "Без категории";
    catMap[cat] = (catMap[cat] || 0) + a.quantity;
  });
  return Object.entries(catMap).sort((a, b) => b[1] - a[1]);
}

function renderCategoriesChart() {
  const ctx = document.getElementById("chartCategories");
  if (!ctx) return;

  const allCategories = getCategoryData();
  const totalPages = Math.max(1, Math.ceil(allCategories.length / CATEGORIES_PER_PAGE));
  if (categoryChartPage >= totalPages) categoryChartPage = 0;
  const pageItems = allCategories.slice(categoryChartPage * CATEGORIES_PER_PAGE, (categoryChartPage + 1) * CATEGORIES_PER_PAGE);

  const labels = pageItems.map((e) => e[0]);
  const data = pageItems.map((e) => e[1]);
  const palette = [
    "rgba(59,130,246,0.8)", "rgba(20,184,166,0.8)", "rgba(245,158,11,0.8)",
    "rgba(244,63,94,0.8)", "rgba(139,92,246,0.8)", "rgba(34,197,94,0.8)",
  ];

  if (chartCategoriesInstance) chartCategoriesInstance.destroy();
  chartCategoriesInstance = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data, backgroundColor: palette.slice(0, data.length), borderWidth: 0 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "right", labels: { color: "#8aa0bc", font: { size: 11 }, padding: 8, boxWidth: 12 } },
      },
    },
  });

  // Pagination controls
  const nav = document.getElementById("chartCatNav");
  if (nav) {
    if (totalPages <= 1) { nav.innerHTML = ""; return; }
    nav.innerHTML = `<button class="chart-nav-btn" ${categoryChartPage <= 0 ? "disabled" : ""} id="catPrev">&laquo;</button><span class="chart-nav-info">${categoryChartPage + 1} / ${totalPages}</span><button class="chart-nav-btn" ${categoryChartPage >= totalPages - 1 ? "disabled" : ""} id="catNext">&raquo;</button>`;
    document.getElementById("catPrev")?.addEventListener("click", () => { categoryChartPage--; renderCategoriesChart(); });
    document.getElementById("catNext")?.addEventListener("click", () => { categoryChartPage++; renderCategoriesChart(); });
  }
}

// ─── DUPLICATE ASSET ──────────────────────────────────────────
function duplicateAsset(assetId) {
  const asset = getAssetById(assetId);
  if (!asset) return;
  const form = dom.assetForm;
  form.elements.assetId.value = "";
  form.elements.name.value = asset.name;
  form.elements.category.value = asset.category;
  form.elements.inventoryNumber.value = "";
  form.elements.serialNumber.value = "";
  form.elements.purchaseDate.value = today();
  form.elements.quantity.value = asset.quantity;
  form.elements.status.value = "in_stock";
  form.elements.notes.value = "";
  if (form.elements.minQuantity) form.elements.minQuantity.value = asset.minQuantity || 0;
  if (form.elements.warrantyEnd) form.elements.warrantyEnd.value = "";
  if (form.elements.price) form.elements.price.value = asset.price || 0;
  if (form.elements.location) form.elements.location.value = asset.location || "";
  renderAssetPhotoPreview({ id: "", photoUrl: "" }); // дубликат — новая позиция без фото
  dom.assetFormTitle.textContent = "Дублировать позицию";
  dom.assetSubmitBtn.textContent = "Сохранить копию";
  dom.assetCancelBtn.classList.remove("hidden");
  activateView("inventory");
  showToast("Заполнено из существующей позиции. Измените и сохраните.", "info");
}

// ─── CATEGORY AUTOCOMPLETE ──────────────────────────────────────
function getUniqueCategories() {
  const cats = new Set();
  state.assets.forEach((a) => { if (a.category && a.category !== "Без категории") cats.add(a.category); });
  return [...cats].sort();
}

function setupCategoryAutocomplete() {
  const datalist = document.getElementById("categoryDatalist");
  if (datalist) datalist.innerHTML = getUniqueCategories().map((c) => `<option value="${c}">`).join("");
  const locDatalist = document.getElementById("locationDatalist");
  if (locDatalist) {
    const locs = new Set();
    state.assets.forEach((a) => { if (a.location) locs.add(a.location); });
    locDatalist.innerHTML = [...locs].sort().map((l) => `<option value="${l}">`).join("");
  }
}

// ─── KIT TEMPLATES ────────────────────────────────────────────
function renderKitTemplates() {
  const container = document.getElementById("kitTemplatesList");
  if (!container) return;
  if (!state.kitTemplates.length) {
    container.innerHTML = '<div class="empty-state"><p>Нет шаблонов комплектов</p></div>';
    return;
  }
  container.innerHTML = state.kitTemplates.map((kit) => {
    const itemNames = kit.items.map((i) => { const a = getAssetById(i.assetId); return a ? `${a.name} ×${i.quantity}` : `[удалено] ×${i.quantity}`; }).join(", ");
    return `<article class="list-item kit-item" data-kit-id="${kit.id}"><div class="title-line"><strong>${kit.name}</strong><div class="row-actions"><button type="button" class="edit-button" data-action="issue-kit" data-kit-id="${kit.id}">Выдать</button><button type="button" class="danger-button" data-action="delete-kit" data-kit-id="${kit.id}">Удалить</button></div></div><p class="muted">${itemNames || "Пустой комплект"}</p></article>`;
  }).join("");
}

async function addKitTemplate() {
  const nameInput = document.getElementById("kitNameInput");
  const name = nameInput?.value.trim();
  if (!name) { showToast("Введите название комплекта.", "warning"); return; }
  const rows = Array.from(document.querySelectorAll("#kitItems .operation-item-row"));
  const items = [];
  rows.forEach((row) => {
    const assetId = row.querySelector(".kit-asset-select")?.value;
    const qty = Math.max(1, Number(row.querySelector(".kit-quantity-input")?.value || 1));
    if (assetId) items.push({ assetId, quantity: qty });
  });
  if (!items.length) { showToast("Добавьте позиции в комплект.", "warning"); return; }
  state.kitTemplates.push({ id: createId("kit"), name, items });
  await persist();
  if (nameInput) nameInput.value = "";
  showToast(`Комплект «${name}» сохранён.`, "success");
}

async function deleteKitTemplate(kitId) {
  const confirmed = await showConfirm("Удалить шаблон комплекта?");
  if (!confirmed) return;
  state.kitTemplates = state.kitTemplates.filter((k) => k.id !== kitId);
  await persist();
}

function addKitItemRow() {
  const container = document.getElementById("kitItems");
  if (!container) return;
  const row = document.createElement("div");
  row.className = "kit-row operation-item-row";
  const select = document.createElement("select");
  select.className = "kit-asset-select";
  state.assets.forEach((a) => {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = `${a.name} (${a.category})`;
    select.appendChild(opt);
  });
  const qty = document.createElement("input");
  qty.type = "number"; qty.min = "1"; qty.value = "1"; qty.className = "kit-quantity-input";
  const removeBtn = document.createElement("button");
  removeBtn.type = "button"; removeBtn.className = "danger-button"; removeBtn.textContent = "×";
  removeBtn.addEventListener("click", () => row.remove());
  row.append(select, qty, removeBtn);
  container.appendChild(row);
}

async function issueKitTemplate(kitId) {
  const kit = state.kitTemplates.find((k) => k.id === kitId);
  if (!kit) return;
  // getActiveEmployees, не сырой state.employees: именно им заполняется
  // issueEmployeeSelect ниже — иначе гвард пропустит комплект в модалку
  // с пустым списком, если все сотрудники мягко удалены/уволены.
  if (!getActiveEmployees(state.employees).length) { showToast("Сначала добавьте сотрудников.", "warning"); return; }
  // Open the issue modal and pre-fill it
  const issueModal = document.getElementById("issueModal");
  if (!issueModal) return;
  dom.modalOverlay.classList.remove("hidden");
  document.querySelectorAll(".operation-modal").forEach((m) => m.classList.add("hidden"));
  issueModal.classList.remove("hidden");
  dom.issueItems.innerHTML = "";
  // Позиция и количество подставляются самим addIssueItemRow: раньше здесь
  // строка создавалась пустой, а затем в ней искался <select>, которого
  // после перехода на поле выбора техники больше нет.
  kit.items.forEach((item) => addIssueItemRow(item.assetId, item.quantity));
  showToast(`Комплект «${kit.name}» загружен в форму выдачи.`, "info");
}

// Рендереры по вкладкам: после изменения данных перерисовывается только
// видимая вкладка, остальные помечаются устаревшими и обновляются при открытии.
const _staleViews = new Set();

// ─── МАРШРУТИЗАЦИЯ ПРЕДСТАВЛЕНИЙ И PERSIST ───────────────────────
function getActiveViewId() {
  return document.querySelector(".view.active")?.id || "dashboard";
}

function renderView(viewId) {
  const renderer = VIEW_RENDERERS[viewId];
  if (!renderer) return;
  renderer();
  _staleViews.delete(viewId);
}

function render() {
  Object.keys(VIEW_RENDERERS).forEach((viewId) => _staleViews.add(viewId));
  renderSelects();
  renderLastUpdate();
  setDefaultDates();
  setupCategoryAutocomplete();
  renderView(getActiveViewId());
}

// Сохранения выполняются строго по очереди: параллельные POST-запросы
// могут прийти на сервер не по порядку и затереть друг друга.
let _persistQueue = Promise.resolve();

function persist() {
  _persistQueue = _persistQueue.then(doPersist);
  return _persistQueue;
}

async function doPersist() {
  try {
    await saveState();
    document.querySelectorAll('.toast[data-kind="save-retry"]').forEach((el) => el.remove());
    showToast('Данные сохранены', 'success');
  } catch (error) {
    console.error(error);
    if (error.conflict) {
      showToast(error.message, 'warning');
    } else if (error.validation) {
      // Сервер отклонил данные — откатываемся к последнему сохранённому состоянию.
      showToast(error.message, 'error');
      await reloadFromServer();
    } else {
      // Сетевой сбой: правки уже применены к state в памяти и никуда не делись —
      // просто ещё не ушли на сервер. Кнопка «Повторить» вызывает persist()
      // заново; тост не исчезает сам, чтобы не потерялось, что сохранение не удалось.
      showToast('Не удалось сохранить — нет связи с сервером. Изменения не потеряны, но ещё не сохранены.', 'error', {
        kind: 'save-retry',
        label: 'Повторить',
        onClick: () => persist(),
      });
    }
  }
}

function addMovement({ type, assetId, employeeId = null, department = "", site = "", workplaceId = "", quantity = 0, date, notes = "", actNumber = null }) {
  state.movements.push({ id: createId("mov"), type, assetId, employeeId, department, site, workplaceId, actNumber, quantity, date, notes });
}

function enterAssetEditMode(assetId) {
  const asset = getAssetById(assetId);
  if (!asset) return;
  dom.assetForm.elements.assetId.value = asset.id;
  dom.assetForm.elements.name.value = asset.name;
  document.dispatchEvent(new Event('assetEditMode'));
  dom.assetForm.elements.category.value = asset.category;
  dom.assetForm.elements.inventoryNumber.value = asset.inventoryNumber;
  dom.assetForm.elements.serialNumber.value = asset.serialNumber;
  dom.assetForm.elements.purchaseDate.value = asset.purchaseDate;
  dom.assetForm.elements.quantity.value = asset.quantity;
  updateInventoryHint();
  dom.assetForm.elements.status.value = asset.status;
  dom.assetForm.elements.notes.value = asset.notes;
  if (dom.assetForm.elements.minQuantity) dom.assetForm.elements.minQuantity.value = asset.minQuantity || 0;
  if (dom.assetForm.elements.warrantyEnd) dom.assetForm.elements.warrantyEnd.value = asset.warrantyEnd || "";
  if (dom.assetForm.elements.price) dom.assetForm.elements.price.value = asset.price || 0;
  if (dom.assetForm.elements.location) dom.assetForm.elements.location.value = asset.location || "";
  const purchaseDateInput = document.getElementById("purchaseDateInput");
  if (purchaseDateInput) setUnknownDate(purchaseDateInput, !asset.purchaseDate);
  syncAssetStatusDot();
  // Выдача из формы правки только запутала бы учёт: для этого есть
  // отдельное окно выдачи, где видно текущий остаток.
  document.getElementById("assetIssueSection")?.classList.add("hidden");
  renderAssetPhotoPreview(asset);
  dom.assetFormTitle.textContent = "Редактировать технику";
  dom.assetSubmitBtn.textContent = "Сохранить изменения";
  dom.assetCancelBtn.classList.remove("hidden");
  activateView("inventory");
}

function enterEmployeeEditMode(employeeId) {
  openEditEmployeeModal(employeeId);
}

// ─── CRUD: УДАЛЕНИЕ И СОХРАНЕНИЕ АКТИВОВ/СОТРУДНИКОВ ─────────────
async function deleteAsset(assetId) {
  const asset = getAssetById(assetId);
  if (!asset) return;
  if (getAllocatedQuantity(asset) > 0) {
    showToast('Нельзя удалить технику, пока она числится за сотрудниками.', 'warning');
    return;
  }
  const confirmed = await showConfirm(`Удалить позицию "${asset.name}"?`);
  if (!confirmed) return;
  addAuditEntry("asset", assetId, "delete", { name: asset.name });
  state.assets = state.assets.filter((entry) => entry.id !== assetId);
  state.movements = state.movements.filter((movement) => movement.assetId !== assetId);
  await persist();
  if (dom.assetForm.elements.assetId.value === assetId) resetAssetForm();
}

async function deleteEmployee(employeeId) {
  const employee = getEmployeeById(employeeId);
  if (!employee || employee.status === "deleted") return;
  const hasAssets = state.assets.some((asset) => {
    const alloc = getEmployeeAllocation(asset, employeeId);
    return alloc && alloc.quantity > 0;
  });
  if (hasAssets) {
    showToast('Нельзя удалить сотрудника, пока за ним числится техника.', 'warning');
    return;
  }
  const confirmed = await showConfirm(`Удалить сотрудника "${employee.fullName}"?`);
  if (!confirmed) return;
  addAuditEntry("employee", employeeId, "delete", { name: employee.fullName });
  // Мягкое удаление: запись остаётся в базе со статусом "deleted", а не
  // стирается. Стереть саму запись, но оставить её движения (выдачи,
  // возвраты) на её employeeId сервер не даст — movements.employee_id
  // держит внешний ключ на employees.id (PRAGMA foreign_keys = ON,
  // server.py), сохранение просто упадёт по ошибке целостности. Стирать
  // же не запись, а движения — то, что делал этот код раньше, — тихо
  // уничтожало историю операций по технике, которая остаётся в системе
  // (§2/§8 ТЗ требуют её сохранять). Мягкое удаление снимает оба: ключ
  // цел, история цела, а сотрудник пропадает из реестра и всех списков
  // выбора (getVisibleEmployees/getActiveEmployees) — getEmployeeById
  // по-прежнему находит его по id, чтобы старые движения показывали имя.
  employee.status = "deleted";
  // Стол остаётся, освобождается только хозяин: техника на нём не
  // принадлежала сотруднику и возврата не требует. Личная техника
  // удалить сотрудника и так не даёт (проверка выше).
  state.workplaces.forEach((workplace) => {
    if (workplace.employeeId === employeeId) workplace.employeeId = null;
  });
  rebuildLookupMaps();
  await persist();
  renderEmployees();
  renderSelects();
  showToast("Сотрудник удален", "success");
}

// ─── EMPLOYEE BULK SELECT / DELETE ──────────────────────────────
function getSelectedEmployeeIds() {
  return Array.from(document.querySelectorAll(".emp-row-check:checked")).map((cb) => cb.dataset.id);
}

function updateEmployeeBulkBar() {
  const ids = getSelectedEmployeeIds();
  const rows = document.querySelectorAll(".emp-row-check");
  const btn = document.getElementById("employeeBulkDeleteBtn");
  const count = document.getElementById("employeeBulkCount");
  if (btn) btn.disabled = ids.length === 0;
  if (count) count.textContent = `${ids.length} выбрано`;
  const master = document.getElementById("empMasterCheckbox");
  if (master) {
    master.checked = rows.length > 0 && ids.length === rows.length;
    master.indeterminate = ids.length > 0 && ids.length < rows.length;
  }
}

async function bulkDeleteEmployees() {
  const ids = getSelectedEmployeeIds();
  if (!ids.length) return;

  const blocked = ids
    .map((id) => getEmployeeById(id))
    .filter((emp) => emp && state.assets.some((asset) => {
      const alloc = getEmployeeAllocation(asset, emp.id);
      return alloc && alloc.quantity > 0;
    }));
  if (blocked.length) {
    showToast(`Невозможно удалить: за сотрудниками числится техника (${blocked.map((e) => e.fullName).join(", ")}). Сначала верните технику.`, "warning");
    return;
  }

  const names = ids.map((id) => getEmployeeById(id)?.fullName).filter(Boolean);
  const confirmed = await showConfirm(`Удалить ${ids.length} сотрудник(ов)?\n\n${names.join(", ")}\n\nЭто действие необратимо.`);
  if (!confirmed) return;

  ids.forEach((id) => addAuditEntry("employee", id, "delete", { name: getEmployeeById(id)?.fullName }));
  // Мягкое удаление — см. deleteEmployee выше за причиной (внешний ключ
  // movements.employee_id на сервере и требование ТЗ сохранять историю).
  ids.forEach((id) => {
    const emp = getEmployeeById(id);
    if (emp) emp.status = "deleted";
  });
  // Стол остаётся, освобождается только хозяин: техника на нём не
  // принадлежала сотруднику и возврата не требует. Личная техника
  // удалить сотрудника и так не даёт (проверка выше).
  state.workplaces.forEach((workplace) => {
    if (ids.includes(workplace.employeeId)) workplace.employeeId = null;
  });

  rebuildLookupMaps();
  await persist();
  renderEmployees();
  renderSelects();
  showToast(`Удалено сотрудников: ${ids.length}.`, "success");
}

async function handleAssetSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const assetId = String(formData.get("assetId") || "").trim();
  // Наименование помечено звёздочкой и действительно обязательно: раньше
  // пустое поле молча превращалось в «Без названия», и такая позиция
  // терялась в списке и в поиске.
  const name = String(formData.get("name") || "").trim();
  if (!name) {
    showToast("Укажите наименование техники.", "warning");
    dom.assetForm.elements.name.focus();
    return;
  }
  const category = String(formData.get("category") || "").trim() || "Без категории";
  const serialNumber = String(formData.get("serialNumber") || "").trim() || "Отсутствует";
  const quantity = Math.max(1, Number(formData.get("quantity") || 1));
  const duplicate = findDuplicateAsset(name, category, serialNumber, assetId);

  // Блок «Выдать сразу» читается ДО любых изменений: при ошибке в нём
  // сохранение прерывается целиком, а не оставляет технику заведённой,
  // но не выданной.
  const issueRequest = readAssetIssueRequest(quantity);
  if (issueRequest === "invalid") return;
  let assetToIssue = null;

  if (assetId) {
    const asset = getAssetById(assetId);
    if (!asset) return;
    if (duplicate) {
      showToast('Уже есть позиция с таким названием, категорией и серийным номером.', 'warning');
      return;
    }
    const changes = {};
    if (asset.name !== name) changes.name = { from: asset.name, to: name };
    if (asset.category !== category) changes.category = { from: asset.category, to: category };
    asset.name = name;
    asset.category = category;
    asset.inventoryNumber = String(formData.get("inventoryNumber") || "").trim();
    asset.serialNumber = serialNumber;
    asset.purchaseDate = formData.get("purchaseDate") || "";
    asset.status = formData.get("status") || "in_stock";
    asset.notes = String(formData.get("notes") || "").trim();
    asset.quantity = Math.max(getAllocatedQuantity(asset), quantity);
    asset.minQuantity = Math.max(0, Number(formData.get("minQuantity") || 0));
    applyWarrantyEnd(asset, formData.get("warrantyEnd") || "");
    asset.price = Math.max(0, Number(formData.get("price") || 0));
    asset.location = String(formData.get("location") || "").trim();
    // photoUrl is intentionally NOT touched here: it's server-owned (set only
    // by the photo-upload endpoint, Task C1/C2) and the form no longer has a
    // field for it, so a normal edit-save must leave it exactly as-is.
    addAuditEntry("asset", asset.id, "edit", changes);
    addMovement({ type: "edit", assetId: asset.id, quantity: asset.quantity, date: today(), notes: "Обновлена карточка техники" });
  } else if (duplicate) {
    duplicate.quantity += quantity;
    if (!duplicate.purchaseDate && formData.get("purchaseDate")) duplicate.purchaseDate = formData.get("purchaseDate");
    if (!duplicate.notes && formData.get("notes")) duplicate.notes = String(formData.get("notes") || "").trim();
    addMovement({ type: "purchase", assetId: duplicate.id, quantity, date: formData.get("purchaseDate") || today(), notes: "Приход увеличил существующую позицию" });
    // Выдаём только вновь пришедшее количество, а не весь остаток позиции.
    assetToIssue = duplicate;
  } else {
    const asset = normalizeAsset({
      name,
      category,
      inventoryNumber: String(formData.get("inventoryNumber") || "").trim(),
      serialNumber,
      purchaseDate: formData.get("purchaseDate") || "",
      status: formData.get("status") || "in_stock",
      notes: String(formData.get("notes") || "").trim(),
      quantity,
      minQuantity: Math.max(0, Number(formData.get("minQuantity") || 0)),
      warrantyEnd: formData.get("warrantyEnd") || "",
      price: Math.max(0, Number(formData.get("price") || 0)),
      location: String(formData.get("location") || "").trim(),
      // No photoUrl here: a newly created asset has no photo yet (the form
      // no longer has a manual URL field to read from), normalizeAsset()
      // defaults it to "".
      allocations: [],
    });
    state.assets.push(asset);
    addAuditEntry("asset", asset.id, "create", { name });
    addMovement({ type: "purchase", assetId: asset.id, quantity: asset.quantity, date: asset.purchaseDate || today(), notes: asset.notes });
    assetToIssue = asset;
  }

  if (issueRequest && assetToIssue) issueAssetOnCreate(assetToIssue, issueRequest);

  resetAssetForm();
  await persist();
}

async function handleEmployeeSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const employeeId = String(formData.get("employeeId") || "").trim();
  const fullName = String(formData.get("fullName") || "").trim();
  const department = String(formData.get("department") || "").trim();
  const site = String(formData.get("site") || "").trim();
  const position = String(formData.get("position") || "").trim();
  const phone = String(formData.get("phone") || "").trim();
  const email = String(formData.get("email") || "").trim();
  const status = String(formData.get("status") || "active").trim();

  if (!fullName) {
    showToast("Введите ФИО сотрудника", "warning");
    return;
  }
  if (!department) {
    showToast("Выберите отдел сотрудника", "warning");
    return;
  }

  if (employeeId) {
    const employee = getEmployeeById(employeeId);
    if (!employee) return;
    employee.fullName = fullName;
    employee.department = department;
    employee.site = site;
    employee.position = position;
    employee.phone = phone;
    employee.email = email;
    employee.status = status;
    addAuditEntry("employee", employee.id, "update", { fullName, department, position, status });
    showToast("Данные сотрудника обновлены", "success");
  } else {
    const newEmployee = {
      id: createId("emp"),
      fullName,
      department,
      site,
      position,
      phone,
      email,
      status,
      createdAt: new Date().toISOString(),
    };
    state.employees.push(newEmployee);
    addAuditEntry("employee", newEmployee.id, "create", { fullName, department, position });
    showToast("Сотрудник добавлен", "success");
  }
  rebuildLookupMaps();
  closeEmployeeModal();
  await persist();
  renderEmployees();
  renderSelects();
}

// ─── ОБРАБОТКА ОПЕРАЦИЙ: ВЫДАЧА / ВОЗВРАТ / РЕМОНТ / СПИСАНИЕ ────
async function handleIssueSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const target = String(formData.get("issueTarget") || "employee");
  const employeeId = target === "employee" ? String(formData.get("employeeId") || "") : "";
  const departmentName = target === "department" ? String(formData.get("departmentName") || "").trim() : "";
  const siteName = target === "site" ? String(formData.get("siteName") || "").trim() : "";
  const workplaceId = target === "workplace" ? String(formData.get("workplaceId") || "") : "";
  if (target === "employee" && !employeeId) {
    showToast('Выберите сотрудника.', 'warning');
    return;
  }
  if (target === "department" && !departmentName) {
    showToast('Выберите отдел.', 'warning');
    return;
  }
  if (target === "site" && !siteName) {
    showToast('Выберите объект.', 'warning');
    return;
  }
  if (target === "workplace" && !workplaceId) {
    showToast('Выберите рабочее место.', 'warning');
    return;
  }
  const rows = Array.from(dom.issueItems.querySelectorAll(".operation-item-row"));
  if (!rows.length) {
    showToast('Добавьте хотя бы одну позицию для выдачи.', 'warning');
    return;
  }
  const aggregated = new Map();
  for (const row of rows) {
    const assetId = row.querySelector(".issue-asset-select")?.value;
    const quantity = Math.max(1, Number(row.querySelector(".issue-quantity-input")?.value || 1));
    // Незаполненная строка раньше молча пропускалась: можно было
    // напечатать в поиске несуществующее и всё равно оформить выдачу —
    // только другой позиции. Теперь это ошибка.
    if (!assetId) {
      showToast('В одной из строк техника не выбрана — выберите позицию из списка.', 'warning');
      row.querySelector(".asset-picker-input")?.focus();
      return;
    }
    aggregated.set(assetId, (aggregated.get(assetId) || 0) + quantity);
  }
  if (!aggregated.size) {
    showToast('Добавьте хотя бы одну позицию для выдачи.', 'warning');
    return;
  }
  for (const [assetId, quantity] of aggregated.entries()) {
    const asset = getAssetById(assetId);
    if (!asset) {
      showToast('Одна из выбранных позиций не найдена.', 'error');
      return;
    }
    const available = getAvailableQuantity(asset);
    if (quantity > available) {
      showToast(`Нельзя выдать ${quantity} шт. По позиции "${asset.name}" доступно: ${available}.`, 'warning');
      return;
    }
  }
  const actNumber = getNextActNumber();
  const employee = employeeId ? getEmployeeById(employeeId) : null;
  for (const [assetId, quantity] of aggregated.entries()) {
    const asset = getAssetById(assetId);
    AssetOps.mergeAllocation(asset.allocations, { employeeId, department: departmentName, site: siteName, workplaceId, quantity });
    addAuditEntry("asset", assetId, "issue", { employee: employee?.fullName, department: employee?.department || departmentName, site: siteName, quantity });
    addMovement({ type: "issue", assetId: asset.id, employeeId: employeeId || null, department: departmentName, site: siteName, workplaceId, actNumber, quantity, date: formData.get("date") || today(), notes: String(formData.get("notes") || "").trim() });
  }
  // Очищаем только позиции: получатель и дата остаются, потому что
  // одному человеку обычно выдают несколько вещей подряд. Панель
  // «уже на руках» тут же показывает, что выдача прошла.
  dom.issueItems.innerHTML = "";
  addIssueItemRow();
  renderIssueEmployeeAssets();
  showToast(`Выдано позиций: ${aggregated.size}. Акт №${actNumber}.`, 'success');
  await persist();
}

async function handleReturnSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const target = String(formData.get("returnTarget") || "employee");
  const employeeId = target === "employee" ? String(formData.get("employeeId") || "") : "";
  const departmentName = target === "department" ? String(formData.get("departmentName") || "").trim() : "";
  const siteName = target === "site" ? String(formData.get("siteName") || "").trim() : "";
  const workplaceId = target === "workplace" ? String(formData.get("workplaceId") || "") : "";
  if (target === "employee" && !employeeId) {
    showToast('Выберите сотрудника.', 'warning');
    return;
  }
  if (target === "department" && !departmentName) {
    showToast('Выберите отдел.', 'warning');
    return;
  }
  if (target === "site" && !siteName) {
    showToast('Выберите объект.', 'warning');
    return;
  }
  if (target === "workplace" && !workplaceId) {
    showToast('Выберите рабочее место.', 'warning');
    return;
  }
  const findAlloc = (asset) => {
    if (employeeId) return getEmployeeAllocation(asset, employeeId);
    if (workplaceId) return getWorkplaceAllocation(asset, workplaceId);
    if (siteName) return getSiteAllocation(asset, siteName);
    return getDepartmentAllocation(asset, departmentName);
  };
  const rows = Array.from(dom.returnItems.querySelectorAll(".operation-item-row"));
  if (!rows.length) {
    showToast('Добавьте хотя бы одну позицию для возврата.', 'warning');
    return;
  }
  const aggregated = new Map();
  rows.forEach((row) => {
    const assetId = row.querySelector(".return-asset-select")?.value;
    const quantity = Math.max(1, Number(row.querySelector(".return-quantity-input")?.value || 1));
    if (!assetId) return;
    aggregated.set(assetId, (aggregated.get(assetId) || 0) + quantity);
  });
  if (!aggregated.size) {
    showToast('Выберите технику для возврата.', 'warning');
    return;
  }
  for (const [assetId, quantity] of aggregated.entries()) {
    const asset = getAssetById(assetId);
    if (!asset) {
      showToast('Одна из выбранных позиций не найдена.', 'error');
      return;
    }
    const allocation = findAlloc(asset);
    const ownerLabel = employeeId ? "сотрудника"
      : workplaceId ? `места «${getWorkplaceById(workplaceId)?.name || ""}»`
      : (target === "site" ? `объекта «${siteName}»` : `отдела «${departmentName}»`);
    if (!allocation) {
      showToast(`У ${ownerLabel} нет позиции "${asset.name}".`, 'warning');
      return;
    }
    if (quantity > allocation.quantity) {
      showToast(`Нельзя вернуть ${quantity} шт. По позиции "${asset.name}" числится: ${allocation.quantity}.`, 'warning');
      return;
    }
  }
  const actNumber = getNextActNumber();
  for (const [assetId, quantity] of aggregated.entries()) {
    const asset = getAssetById(assetId);
    const allocation = findAlloc(asset);
    allocation.quantity -= quantity;
    asset.allocations = asset.allocations.filter((entry) => entry.quantity > 0);
    addMovement({ type: "return", assetId: asset.id, employeeId: employeeId || null, department: departmentName, site: siteName, workplaceId, actNumber, quantity, date: formData.get("date") || today(), notes: String(formData.get("notes") || "").trim() });
  }
  resetOperationForms();
  await persist();
}

async function handleRepairSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const asset = getAssetById(formData.get("assetId"));
  const sourceValue = String(formData.get("sourceId") || "warehouse");
  const source = parseLocationValue(sourceValue);
  const quantity = Math.max(1, Number(formData.get("quantity") || 1));
  if (!asset) return;
  if (source.type === "warehouse") {
    const available = getAvailableQuantity(asset);
    if (quantity > available) {
      showToast(`Нельзя отправить в ремонт ${quantity} шт. Доступно на складе: ${available}.`, 'warning');
      return;
    }
  } else {
    const allocation = getEmployeeAllocation(asset, source.employeeId);
    if (!allocation) {
      showToast('У выбранного сотрудника нет этой техники.', 'warning');
      return;
    }
    if (quantity > allocation.quantity) {
      showToast(`Нельзя отправить в ремонт ${quantity} шт. У сотрудника числится: ${allocation.quantity}.`, 'warning');
      return;
    }
    allocation.quantity -= quantity;
    asset.allocations = asset.allocations.filter((entry) => entry.quantity > 0);
  }
  asset.repairQuantity = Number(asset.repairQuantity || 0) + quantity;
  if (!asset.repairDate) asset.repairDate = formData.get("date") || today();
  const sourceLabel = getLocationLabel(sourceValue);
  const userNotes = String(formData.get("notes") || "").trim();
  addMovement({
    type: "repair",
    assetId: asset.id,
    employeeId: source.type === "employee" ? source.employeeId : null,
    quantity,
    date: formData.get("date") || today(),
    notes: userNotes ? `Откуда: ${sourceLabel}. ${userNotes}` : `Откуда: ${sourceLabel}`,
  });
  event.currentTarget.reset();
  event.currentTarget.elements.quantity.value = 1;
  await persist();
}

async function handleRepairReturnSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const asset = getAssetById(formData.get("assetId"));
  const targetValue = String(formData.get("targetId") || "warehouse");
  const target = parseLocationValue(targetValue);
  const quantity = Math.max(1, Number(formData.get("quantity") || 1));
  if (!asset) return;
  const inRepair = Number(asset.repairQuantity || 0);
  if (quantity > inRepair) {
    showToast(`Нельзя вернуть из ремонта ${quantity} шт. В ремонте числится: ${inRepair}.`, 'warning');
    return;
  }
  if (target.type === "employee" && !target.employeeId) {
    showToast('Выберите сотрудника, куда вернуть технику.', 'warning');
    return;
  }
  asset.repairQuantity = inRepair - quantity;
  if (asset.repairQuantity <= 0) asset.repairDate = "";
  if (target.type === "employee") {
    // Через общую функцию, а не вручную: иначе здесь появляется второе
    // определение формы записи о выдаче — эта ветка создавала её без
    // полей department, site и workplaceId.
    AssetOps.mergeAllocation(asset.allocations, { employeeId: target.employeeId, quantity });
  }
  const targetLabel = getLocationLabel(targetValue);
  const userNotes = String(formData.get("notes") || "").trim();
  addMovement({
    type: "repair_return",
    assetId: asset.id,
    employeeId: target.type === "employee" ? target.employeeId : null,
    quantity,
    date: formData.get("date") || today(),
    notes: userNotes ? `Куда: ${targetLabel}. ${userNotes}` : `Куда: ${targetLabel}`,
  });
  event.currentTarget.reset();
  event.currentTarget.elements.quantity.value = 1;
  await persist();
}

async function handleRetireSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const asset = getAssetById(formData.get("assetId"));
  const quantity = Math.max(1, Number(formData.get("quantity") || 1));
  if (!asset) return;
  const available = getAvailableQuantity(asset);
  if (quantity > available) {
    showToast(`Нельзя списать ${quantity} шт. Доступно на складе: ${available}.`, 'warning');
    return;
  }
  asset.quantity -= quantity;
  asset.retiredQuantity = Number(asset.retiredQuantity || 0) + quantity;
  addMovement({
    type: "retire",
    assetId: asset.id,
    quantity,
    date: formData.get("date") || today(),
    notes: String(formData.get("notes") || "").trim(),
  });
  event.currentTarget.reset();
  event.currentTarget.elements.quantity.value = 1;
  await persist();
}

// ─── АКТЫ: ГЕНЕРАЦИЯ И ПЕЧАТЬ ────────────────────────────────────
function getActMovements(movement) {
  if (!movement) return [];
  if (!movement.actNumber || (movement.type !== "issue" && movement.type !== "return")) return [movement];
  const rows = state.movements
    .filter((entry) => entry.type === movement.type && Number(entry.actNumber || 0) === Number(movement.actNumber || 0))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return rows.length ? rows : [movement];
}

function buildActItemPayload(entry) {
  const asset = getAssetById(entry.assetId);
  return {
    name: asset ? asset.name : "",
    serialNumber: asset ? asset.serialNumber || "" : "",
    inventoryNumber: asset ? asset.inventoryNumber || "" : "",
    quantity: Number(entry.quantity || 0),
    price: asset ? Number(asset.price || 0) : 0,
  };
}

async function downloadActDocx({ actNumber, date, employee, items, isIssue, actionPhrase, filename }) {
  try {
    const payload = {
      actNumber,
      date,
      isIssue,
      employee: employee ? {
        fullName: employee.fullName || "",
        position: employee.position || "",
        department: employee.department || "",
      } : null,
      items,
      actionPhrase: actionPhrase || undefined,
      // Real acts (printAct/printManualAct) always pass a real actNumber and
      // rely on this default; downloadHandoverSheet() passes an explicit
      // filename instead, since it always has actNumber: null (a handover
      // sheet isn't a numbered act) — without an override every handover
      // sheet would download as the same indistinguishable "Акт_документ.docx".
      filename: filename || `Акт_${actNumber || "документ"}.docx`,
    };
    const response = await apiFetch("/api/act", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      let msg = `Не удалось сформировать акт (HTTP ${response.status})`;
      try { const err = await response.json(); if (err && err.error) msg = err.error; } catch (_) {}
      showToast(msg, "error");
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = payload.filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    showToast("Акт скачан.", "info");
  } catch (err) {
    showToast(`Ошибка при скачивании акта: ${err.message || err}`, "error");
  }
}

function printAct(movementId) {
  const movement = state.movements.find((entry) => entry.id === movementId);
  if (!movement) return;
  const actMovements = getActMovements(movement);
  const primaryMovement = actMovements[0];
  const employee = getEmployeeById(primaryMovement.employeeId);
  const isIssue = primaryMovement.type === "issue";
  const actNumber = resolveActNumber(primaryMovement);
  downloadActDocx({
    actNumber,
    date: primaryMovement.date,
    employee,
    items: actMovements.map(buildActItemPayload),
    isIssue,
  });
}

function printManualAct({ type, employeeId, date, notes, items }) {
  const employee = getEmployeeById(employeeId);
  const isIssue = type === "issue";
  const actNumber = getNextActNumber();
  const itemsPayload = items.map((entry) => buildActItemPayload(entry));
  downloadActDocx({
    actNumber,
    date,
    employee,
    items: itemsPayload,
    isIssue,
  });
}

async function handleManualActSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const type = String(formData.get("type") || "issue");
  const employeeId = String(formData.get("employeeId") || "");
  const date = String(formData.get("date") || today());
  const notes = String(formData.get("notes") || "").trim();
  if (!employeeId) {
    showToast('Выберите сотрудника.', 'warning');
    return;
  }
  const rows = Array.from(dom.manualActItems.querySelectorAll(".operation-item-row"));
  if (!rows.length) {
    showToast('Добавьте хотя бы одну позицию.', 'warning');
    return;
  }
  const aggregated = new Map();
  rows.forEach((row) => {
    const assetId = row.querySelector(".manual-act-asset-select")?.value;
    const quantity = Math.max(1, Number(row.querySelector(".manual-act-quantity-input")?.value || 1));
    if (!assetId) return;
    aggregated.set(assetId, (aggregated.get(assetId) || 0) + quantity);
  });
  if (!aggregated.size) {
    showToast('Выберите позиции для акта.', 'warning');
    return;
  }
  for (const [assetId, quantity] of aggregated.entries()) {
    const asset = getAssetById(assetId);
    if (!asset) {
      showToast('Одна из выбранных позиций не найдена.', 'error');
      return;
    }
    if (type === "issue") {
      const available = getAvailableQuantity(asset);
      if (quantity > available) {
        showToast(`По позиции "${asset.name}" доступно ${available}, а в акт добавлено ${quantity}.`, 'warning');
        return;
      }
    } else {
      const allocation = getEmployeeAllocation(asset, employeeId);
      const allocated = allocation ? allocation.quantity : 0;
      if (quantity > allocated) {
        showToast(`По позиции "${asset.name}" у сотрудника числится ${allocated}, а в акт добавлено ${quantity}.`, 'warning');
        return;
      }
    }
  }
  const items = Array.from(aggregated.entries()).map(([assetId, quantity]) => ({ assetId, quantity }));
  printManualAct({ type, employeeId, date, notes, items });
}

// ─── ЭКСПОРТ / ИМПОРТ ДАННЫХ ─────────────────────────────────────
function handleExport() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `it-warehouse-export-${today()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildWorksheetXml(name, headers, rows) {
  const headerRow = `
    <Row ss:StyleID="header">
      ${headers.map((header) => `<Cell><Data ss:Type="String">${escapeXml(header)}</Data></Cell>`).join("")}
    </Row>
  `;
  const bodyRows = rows.map((row) => `
    <Row>
      ${row.map((cell) => `<Cell><Data ss:Type="${typeof cell === "number" ? "Number" : "String"}">${escapeXml(cell)}</Data></Cell>`).join("")}
    </Row>
  `).join("");
  return `
    <Worksheet ss:Name="${escapeXml(name)}">
      <Table>
        ${headerRow}
        ${bodyRows}
      </Table>
    </Worksheet>
  `;
}

function handleExcelExport() {
  const stockRows = state.assets
    .filter((asset) => getAvailableQuantity(asset) > 0)
    .map((asset) => [
      asset.name,
      asset.category,
      asset.inventoryNumber || "-",
      asset.serialNumber || "-",
      getAvailableQuantity(asset),
      Number(asset.repairQuantity || 0),
      Number(asset.retiredQuantity || 0),
      formatDate(asset.purchaseDate),
    ]);

  const employeeRows = getVisibleEmployees(state.employees).map((employee) => {
    const items = state.assets
      .map((asset) => {
        const allocation = getEmployeeAllocation(asset, employee.id);
        return allocation ? `${asset.name} (${allocation.quantity})` : null;
      })
      .filter(Boolean)
      .join(", ");
    return [employee.fullName, employee.department, employee.position || "-", employee.email || "-", items || "-"];
  });

  const historyRows = [...state.movements]
    .sort((a, b) => dateSortKey(b.date) - dateSortKey(a.date))
    .map((movement) => {
      const asset = getAssetById(movement.assetId);
      const employee = getEmployeeById(movement.employeeId);
      return [
        formatDate(movement.date),
        movementLabels[movement.type] || movement.type,
        asset ? asset.name : "-",
        employee ? employee.fullName : "Склад",
        Number(movement.quantity || 0),
        movement.notes || "-",
      ];
    });

  const workbookXml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
  <Styles>
    <Style ss:ID="Default" ss:Name="Normal">
      <Alignment ss:Vertical="Center"/>
      <Font ss:FontName="Calibri" ss:Size="11"/>
    </Style>
    <Style ss:ID="header">
      <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1"/>
      <Interior ss:Color="#F1E4D3" ss:Pattern="Solid"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
        <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
        <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
        <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
      </Borders>
    </Style>
  </Styles>
  ${buildWorksheetXml(
    "Склад",
    ["Наименование", "Тип", "Инв. номер", "Серийный номер", "На складе", "В ремонте", "Списано", "Дата покупки"],
    stockRows
  )}
  ${buildWorksheetXml(
    "Сотрудники",
    ["ФИО", "Отдел", "Должность", "Email", "Закрепленная техника"],
    employeeRows
  )}
  ${buildWorksheetXml(
    "История",
    ["Дата", "Тип операции", "Техника", "Сотрудник", "Количество", "Комментарий"],
    historyRows
  )}
</Workbook>`;

  const blob = new Blob([`\ufeff${workbookXml}`], { type: "application/vnd.ms-excel;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `warehouse-report-${today()}.xls`;
  link.click();
  URL.revokeObjectURL(url);
}

function handleImport(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      state = hydrateState(JSON.parse(reader.result));
      rebuildLookupMaps();
      resetAssetForm();
      resetEmployeeForm();
      resetOperationForms();
      await persist();
    } catch {
      showToast('Не удалось импортировать файл. Проверьте формат JSON.', 'error');
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file);
}

// ─── ПЕРЕКЛЮЧЕНИЕ ВКЛАДОК И ОБРАБОТКА КЛИКОВ ─────────────────────
function activateView(viewId) {
  dom.views.forEach((view) => view.classList.toggle("active", view.id === viewId));
  dom.menuLinks.forEach((link) => link.classList.toggle("active", link.dataset.view === viewId));
  if (_staleViews.has(viewId)) renderView(viewId);
}

function handleAssetTableClick(event) {
  // Checkbox clicks (bulk select)
  const checkbox = event.target.closest("input.asset-bulk-check");
  if (checkbox) { updateBulkBar(); return; }
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "edit-asset") enterAssetEditMode(id);
  if (action === "delete-asset") deleteAsset(id);
  if (action === "quick-label") quickPrintLabel(id);
  if (action === "duplicate-asset") duplicateAsset(id);
}

function getSelectedAssetIds() {
  return Array.from(document.querySelectorAll("input.asset-bulk-check:checked")).map((cb) => cb.dataset.id);
}

function updateBulkBar() {
  const bar = document.getElementById("bulkBar");
  const count = getSelectedAssetIds().length;
  if (bar) bar.classList.toggle("hidden", count === 0);
  const span = document.getElementById("bulkCount");
  if (span) span.textContent = `${count} выбрано`;
}

async function bulkDeleteAssets() {
  const ids = getSelectedAssetIds();
  if (!ids.length) return;
  const confirmed = await showConfirm(`Удалить ${ids.length} позиций?`);
  if (!confirmed) return;
  const blocked = ids.filter((id) => { const a = getAssetById(id); return a && getAllocatedQuantity(a) > 0; });
  if (blocked.length) { showToast(`${blocked.length} позиций нельзя удалить (числятся за сотрудниками).`, "warning"); return; }
  ids.forEach((id) => {
    addAuditEntry("asset", id, "delete", { name: getAssetById(id)?.name });
    state.assets = state.assets.filter((a) => a.id !== id);
    state.movements = state.movements.filter((m) => m.assetId !== id);
  });
  await persist();
}

function bulkSelectAll(checked) {
  document.querySelectorAll("input.asset-bulk-check").forEach((cb) => { cb.checked = checked; });
  updateBulkBar();
}

function handleEmployeeListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "edit-employee") enterEmployeeEditMode(id);
  if (action === "delete-employee") deleteEmployee(id);
}

function handleMovementTableClick(event) {
  const button = event.target.closest("button[data-action='print-act']");
  if (!button) return;
  printAct(button.dataset.id);
}

function handleOperationLauncherClick(event) {
  const button = event.target.closest("[data-modal]");
  if (!button) return;
  openOperationModal(button.dataset.modal);
}

function bindEvents() {
  dom.menuLinks.forEach((link) => link.addEventListener("click", () => activateView(link.dataset.view)));
  dom.assetForm.addEventListener("submit", handleAssetSubmit);

  // ── Name length counter ───────────────────────────────────────
  const nameInput = document.getElementById('assetNameInput');
  const nameCount = document.getElementById('nameCharCount');
  const nameHint  = document.getElementById('nameCharHint');
  const NAME_WARN = 60, NAME_MAX = 80;
  if (nameInput && nameCount) {
    const updateCounter = () => {
      const len = nameInput.value.length;
      nameCount.textContent = `${len}/${NAME_MAX}`;
      if (len >= NAME_MAX) {
        nameCount.style.color = 'var(--danger)';
        nameHint.textContent = 'Максимум 80 символов. Используйте краткое название — подробности в комментарий.';
        nameHint.style.color = 'var(--danger)';
        nameHint.style.display = 'block';
      } else if (len >= NAME_WARN) {
        nameCount.style.color = 'var(--warn)';
        nameHint.textContent = `Рекомендуется до ${NAME_WARN} символов для корректного отображения на этикетках.`;
        nameHint.style.color = 'var(--warn)';
        nameHint.style.display = 'block';
      } else {
        nameCount.style.color = 'var(--text-3)';
        nameHint.style.display = 'none';
      }
    };
    nameInput.addEventListener('input', updateCounter);
    // update counter when edit mode fills the field
    const _origEnterEdit = enterAssetEditMode;
    document.addEventListener('assetEditMode', updateCounter);
  }
  dom.assetCancelBtn.addEventListener("click", resetAssetForm);
  // Ввод в само поле номера снимает отметку "сгенерировано автоматически"
  // (значение перестаёт совпадать с запомненным), и дальше приложение в
  // поле не пишет, пока не нажмут 📋.
  document.getElementById("inventoryNumberInput")?.addEventListener("input", updateInventoryHint);
  document.getElementById("autoInventoryBtn")?.addEventListener("click", autoFillInventoryNumber);
  document.getElementById("assetCodeReferenceBtn")?.addEventListener("click", openAssetCodeReference);
  document.getElementById("assetCodeReferenceClose")?.addEventListener("click", closeAssetCodeReference);
  document.getElementById("assetCodeReferenceModal")?.addEventListener("click", (event) => {
    if (event.target.id === "assetCodeReferenceModal") closeAssetCodeReference();
  });
  // Префикс зависит и от категории, и от наименования: тип техники бывает
  // виден только в одном из них.
  dom.assetForm.elements.category?.addEventListener("input", refreshInventoryNumber);
  nameInput?.addEventListener("input", refreshInventoryNumber);

  // Галочки «Неизвестно» у дат — по data-атрибуту, чтобы добавить их к
  // ещё одному полю можно было одной строкой в разметке.
  document.querySelectorAll("[data-unknown-toggle]").forEach(bindUnknownDateToggle);

  document.getElementById("assetStatusSelect")?.addEventListener("change", syncAssetStatusDot);
  document.getElementById("assetIssueNow")?.addEventListener("change", syncAssetIssueFields);
  document.querySelectorAll('input[name="assetIssueTarget"]').forEach((radio) => {
    radio.addEventListener("change", syncAssetIssueFields);
  });
  dom.assetForm.elements.quantity?.addEventListener("input", syncAssetIssueQuantity);
  document.getElementById("assetIssueQuantity")?.addEventListener("input", (event) => {
    // Тронули руками — перестаём подставлять общее количество.
    delete event.target.dataset.autoFilled;
  });
  dom.employeeForm?.addEventListener("submit", handleEmployeeSubmit);
  const handleEmployeeAsideSync = () => {
    const employeeId = document.getElementById("employeeFormId")?.value;
    syncEmployeeEditAside(employeeId ? getEmployeeById(employeeId) : null);
    syncEmployeeDuplicateWarning();
  };
  dom.employeeForm?.addEventListener("input", handleEmployeeAsideSync);
  dom.employeeForm?.addEventListener("change", handleEmployeeAsideSync);
  document.getElementById("employeeDuplicateWarning")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-use-employee-id]");
    if (!button) return;
    openEditEmployeeModal(button.dataset.useEmployeeId);
  });
  dom.employeeCancelBtn?.addEventListener("click", closeEmployeeModal);
  document.getElementById("departmentForm")?.addEventListener("submit", handleDepartmentSubmit);
  document.getElementById("departmentCancelBtn")?.addEventListener("click", resetDepartmentForm);
  document.getElementById("siteForm")?.addEventListener("submit", handleSiteSubmit);
  document.getElementById("siteCancelBtn")?.addEventListener("click", resetSiteForm);
  document.getElementById("workplaceForm")?.addEventListener("submit", handleWorkplaceSubmit);
  document.getElementById("workplaceCancelBtn")?.addEventListener("click", resetWorkplaceForm);
  document.getElementById("workplacesList")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const id = button.dataset.workplaceId;
    if (button.dataset.action === "edit-workplace") enterWorkplaceEditMode(id);
    if (button.dataset.action === "delete-workplace") deleteWorkplace(id);
  });
  dom.manualActForm?.addEventListener("submit", handleManualActSubmit);
  dom.issueForm.addEventListener("submit", handleIssueSubmit);
  dom.returnForm.addEventListener("submit", handleReturnSubmit);
  dom.repairForm.addEventListener("submit", handleRepairSubmit);
  dom.repairReturnForm.addEventListener("submit", handleRepairReturnSubmit);
  dom.retireForm.addEventListener("submit", handleRetireSubmit);
  dom.returnEmployeeSelect.addEventListener("change", updateReturnAssetOptions);
  document.getElementById("returnDepartmentSelect")?.addEventListener("change", updateReturnAssetOptions);
  document.getElementById("returnSiteSelect")?.addEventListener("change", updateReturnAssetOptions);
  document.getElementById("returnWorkplaceSelect")?.addEventListener("change", updateReturnAssetOptions);
  document.getElementById("issueEmployeeSelect")?.addEventListener("change", (e) => {
    const emp = getEmployeeById(e.target.value);
    const field = document.getElementById("issueDepartmentField");
    if (field) field.value = emp?.department || "";
    renderIssueEmployeeAssets();
  });

  // Toggle issue target between employee / department / site
  const show = (el, on) => { if (el) el.style.display = on ? "block" : "none"; };
  document.querySelectorAll('input[name="issueTarget"]').forEach(radio => {
    radio.addEventListener("change", (e) => {
      const target = e.target.value;
      show(document.getElementById("issueEmployeeField"), target === "employee");
      show(document.getElementById("issueDepartmentAutoField"), target === "employee");
      show(document.getElementById("issueDepartmentSelectField"), target === "department");
      show(document.getElementById("issueSiteField"), target === "site");
      show(document.getElementById("issueWorkplaceField"), target === "workplace");
      renderIssueEmployeeAssets();
    });
  });
  // Toggle return target between employee / department / site
  document.querySelectorAll('input[name="returnTarget"]').forEach(radio => {
    radio.addEventListener("change", (e) => {
      const target = e.target.value;
      show(document.getElementById("returnEmployeeField"), target === "employee");
      show(document.getElementById("returnDepartmentField"), target === "department");
      show(document.getElementById("returnSiteField"), target === "site");
      show(document.getElementById("returnWorkplaceField"), target === "workplace");
      updateReturnAssetOptions();
    });
  });
  dom.manualActTypeSelect?.addEventListener("change", updateManualActAssetOptions);
  dom.manualActEmployeeSelect?.addEventListener("change", updateManualActAssetOptions);
  dom.repairSourceSelect?.addEventListener("change", updateRepairAssetOptions);
  dom.addIssueItemBtn?.addEventListener("click", () => addIssueItemRow());
  dom.addReturnItemBtn?.addEventListener("click", () => addReturnItemRow());
  dom.addManualActItemBtn?.addEventListener("click", () => addManualActItemRow());
  dom.exportDataBtn.addEventListener("click", handleExport);
  dom.exportExcelBtn.addEventListener("click", handleExcelExport);
  dom.importDataInput.addEventListener("change", handleImport);
  document.getElementById("printLabelsBtn")?.addEventListener("click", openLabelsModal);
  document.getElementById("closeLabelsBtn")?.addEventListener("click", closeLabelsModal);
  document.getElementById("labelsOverlay")?.addEventListener("click", (e) => { if (e.target === document.getElementById("labelsOverlay")) closeLabelsModal(); });
  document.getElementById("logoutBtn")?.addEventListener("click", handleLogout);
  document.getElementById("showLanQrBtn")?.addEventListener("click", openUsersModal);
  document.getElementById("closeLanQrBtn")?.addEventListener("click", closeLanQrModal);
  document.getElementById("lanQrOverlay")?.addEventListener("click", (e) => { if (e.target === document.getElementById("lanQrOverlay")) closeLanQrModal(); });
  document.getElementById("usersTableBody")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const userId = btn.closest("tr").dataset.userId;
    if (btn.dataset.action === "toggle-active") {
      const isActive = btn.dataset.nextActive === "true";
      const response = await apiFetch(`/api/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (!response.ok) {
        // Сервер отклоняет, например, отключение последнего активного админа —
        // без этого кнопка молча ничего не делала.
        const data = await response.json().catch(() => ({}));
        showToast(data.error || "Не удалось изменить статус пользователя.", "error");
        return;
      }
      await renderUsersTable();
    }
    if (btn.dataset.action === "generate-qr") {
      document.getElementById("usersOverlay").classList.add("hidden");
      await openLanQrModal(userId);
    }
  });
  document.getElementById("toggleNewUserPassword")?.addEventListener("click", () => {
    const input = document.getElementById("newUserPassword");
    const btn = document.getElementById("toggleNewUserPassword");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    input.classList.toggle("has-eye", true);
    btn.classList.toggle("is-on", show);
    btn.title = show ? "Скрыть пароль" : "Показать пароль";
    btn.setAttribute("aria-label", btn.title);
  });
  document.getElementById("createUserForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("newUserUsername").value.trim();
    const password = document.getElementById("newUserPassword").value;
    const role = document.getElementById("newUserRole").value;
    const response = await apiFetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, role }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showToast(data.error || "Не удалось создать пользователя.", "error");
      return;
    }
    e.target.reset();
    await renderUsersTable();
  });
  document.getElementById("closeUsersBtn")?.addEventListener("click", closeUsersModal);
  document.getElementById("usersOverlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("usersOverlay")) closeUsersModal();
  });
  document.getElementById("showBackupsBtn")?.addEventListener("click", openBackupsModal);
  document.getElementById("closeBackupsBtn")?.addEventListener("click", closeBackupsModal);
  document.getElementById("backupsOverlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("backupsOverlay")) closeBackupsModal();
  });
  document.getElementById("showInventoryBtn")?.addEventListener("click", openInventoryModal);
  document.getElementById("closeInventoryBtn")?.addEventListener("click", closeInventoryModal);
  document.getElementById("inventoryOverlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("inventoryOverlay")) closeInventoryModal();
  });
  document.getElementById("inventorySessionsBody")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".download-inventory-act-btn");
    if (btn) downloadInventoryAct(btn.dataset.sessionId);
  });
  document.getElementById("showSettingsBtn")?.addEventListener("click", openSettingsModal);
  document.getElementById("closeSettingsBtn")?.addEventListener("click", closeSettingsModal);
  document.getElementById("settingsOverlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("settingsOverlay")) closeSettingsModal();
  });
  document.getElementById("checkUpdatesInput")?.addEventListener("change", async (e) => {
    const response = await apiFetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkUpdates: e.target.checked }),
    });
    if (!response.ok) {
      showToast("Не удалось сохранить настройку", "warning");
      e.target.checked = !e.target.checked;
      return;
    }
    showToast(e.target.checked ? "Проверка обновлений включена" : "Проверка обновлений выключена", "success");
  });
  document.getElementById("attentionWarrantyDaysInput")?.addEventListener("change", async (e) => {
    const value = parseInt(e.target.value, 10);
    if (!Number.isFinite(value) || value <= 0) {
      showToast("Порог гарантии должен быть положительным числом дней", "warning");
      e.target.value = e.target.dataset.lastGood ?? 30;
      return;
    }
    const response = await apiFetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attentionWarrantyDays: value }),
    });
    if (!response.ok) {
      showToast("Не удалось сохранить настройку", "warning");
      e.target.value = e.target.dataset.lastGood ?? 30;
      return;
    }
    e.target.dataset.lastGood = String(value);
    showToast("Порог гарантии сохранён", "success");
  });
  document.getElementById("attentionRepairDaysInput")?.addEventListener("change", async (e) => {
    const value = parseInt(e.target.value, 10);
    if (!Number.isFinite(value) || value <= 0) {
      showToast("Порог ремонта должен быть положительным числом дней", "warning");
      e.target.value = e.target.dataset.lastGood ?? 14;
      return;
    }
    const response = await apiFetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attentionRepairDays: value }),
    });
    if (!response.ok) {
      showToast("Не удалось сохранить настройку", "warning");
      e.target.value = e.target.dataset.lastGood ?? 14;
      return;
    }
    e.target.dataset.lastGood = String(value);
    showToast("Порог ремонта сохранён", "success");
  });
  document.getElementById("dismissUpdateBtn")?.addEventListener("click", () => {
    updateBannerDismissed = true;
    renderUpdateBanner();
  });
  document.getElementById("backupsTableBody")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action='restore-backup']");
    if (!btn) return;
    const filename = btn.closest("tr").dataset.filename;
    if (!(await showConfirm(`Восстановить базу данных из «${filename}»? Откатится вся база, включая пользователей, сессии и привязанные телефоны — может потребоваться повторный вход и повторная привязка. Текущее состояние будет сохранено как резервная копия перед откатом.`))) return;
    const response = await apiFetch("/api/backups/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showToast(data.error || "Не удалось восстановить базу данных.", "error");
      return;
    }
    closeBackupsModal();
    await boot();
  });
  document.getElementById("labelSelectAllBtn")?.addEventListener("click", () => labelSelectAll(true));
  document.getElementById("labelDeselectAllBtn")?.addEventListener("click", () => labelSelectAll(false));
  document.getElementById("labelSizeSelect")?.addEventListener("change", updateLabelSizeHint);
  document.getElementById("labelColsInput")?.addEventListener("input", updateLabelSizeHint);
  document.getElementById("labelSearchInput")?.addEventListener("input", debounce(renderLabelGrid));
  document.getElementById("labelFilterCategory")?.addEventListener("change", renderLabelGrid);
  document.getElementById("labelFilterLocation")?.addEventListener("change", renderLabelGrid);
  document.getElementById("labelUnprintedCheck")?.addEventListener("change", renderLabelGrid);
  document.getElementById("labelAddEmployeeAssetsBtn")?.addEventListener("click", addEmployeeAssetsToLabelSelection);
  document.getElementById("printLabelsPrintBtn")?.addEventListener("click", printLabels);
  document.getElementById("exportLabelsExcelBtn")?.addEventListener("click", exportLabelsExcel);
  document.getElementById("exportLabelsWordBtn")?.addEventListener("click", exportLabelsWord);
  document.getElementById("exportLabelsPdfBtn")?.addEventListener("click", exportLabelsPdf);
  document.getElementById("exportLabelsJpgBtn")?.addEventListener("click", exportLabelsJpg);
  document.getElementById("previewLabelsBtn")?.addEventListener("click", openLabelPreview);
  document.getElementById("closeLabelPreviewBtn")?.addEventListener("click", closeLabelPreview);
  document.getElementById("labelPreviewOverlay")?.addEventListener("click", (e) => { if (e.target === document.getElementById("labelPreviewOverlay")) closeLabelPreview(); });
  document.getElementById("labelPreviewPrev")?.addEventListener("click", () => labelPreviewNav(-1));
  document.getElementById("labelPreviewNext")?.addEventListener("click", () => labelPreviewNav(1));
  dom.dashboardSearchInput?.addEventListener("input", debounce(() => {
    renderRecentMovements();
    renderAssignedSummary();
  }));
  dom.assetSearchInput.addEventListener("input", debounce(() => { assetCurrentPage = 1; renderAssetsTable(); }));
  dom.movementSearchInput?.addEventListener("input", debounce(renderMovementTable));
  dom.reportSearchInput?.addEventListener("input", debounce(renderReports));
  dom.assetsTableBody.addEventListener("click", handleAssetTableClick);
  document.getElementById("departmentsList")?.addEventListener("click", (e) => {
    const action = e.target.closest("button")?.dataset.action;
    const id = e.target.closest("button")?.dataset.id;
    if (!action || !id) return;
    if (action === "edit-department") enterDepartmentEditMode(id);
    if (action === "delete-department") handleDepartmentDelete(id);
    if (action === "export-department") exportDepartmentHandoverCsv(id);
  });
  document.getElementById("sitesList")?.addEventListener("click", (e) => {
    const action = e.target.closest("button")?.dataset.action;
    const id = e.target.closest("button")?.dataset.id;
    if (!action || !id) return;
    if (action === "edit-site") enterSiteEditMode(id);
    if (action === "delete-site") handleSiteDelete(id);
    if (action === "export-site") exportSiteHandoverCsv(id);
  });
  dom.movementsTableBody.addEventListener("click", handleMovementTableClick);
  document.querySelector(".operation-actions").addEventListener("click", handleOperationLauncherClick);
  dom.modalOverlay.addEventListener("click", (event) => {
    if (event.target === dom.modalOverlay || event.target.closest("[data-close-modal]")) {
      closeOperationModal();
    }
  });

  // Filter & sort events for assets table
  document.getElementById('assetFilterStatus')?.addEventListener('change', () => { assetCurrentPage = 1; renderAssetsTable(); });
  document.getElementById('assetFilterCategory')?.addEventListener('change', () => { assetCurrentPage = 1; renderAssetsTable(); });
  document.getElementById('assetSortField')?.addEventListener('change', renderAssetsTable);
  document.getElementById('assetSortDir')?.addEventListener('change', renderAssetsTable);

  // Theme toggle
  document.getElementById("themeToggleBtn")?.addEventListener("click", toggleTheme);

  // Продление гарантии (панель «Требует внимания»)
  document.getElementById("warrantyExtendForm")?.addEventListener("submit", handleWarrantyExtendSubmit);
  document.getElementById("warrantyDismissBtn")?.addEventListener("click", handleWarrantyDismiss);
  document.getElementById("warrantyExtendCancelBtn")?.addEventListener("click", closeWarrantyExtendModal);
  document.getElementById("closeWarrantyExtendBtn")?.addEventListener("click", closeWarrantyExtendModal);
  document.getElementById("warrantyExtendOverlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("warrantyExtendOverlay")) closeWarrantyExtendModal();
  });

  // Employee events
  document.getElementById("openAddEmployeeModalBtn")?.addEventListener("click", openAddEmployeeModal);
  document.getElementById("closeEmployeeModalBtn")?.addEventListener("click", closeEmployeeModal);
  document.getElementById("employeeModalCancelBtn")?.addEventListener("click", closeEmployeeModal);
  document.getElementById("closeEmployeeDetailsBtn")?.addEventListener("click", closeEmployeeDetailsModal);
  document.getElementById("employeeExportBtn")?.addEventListener("click", exportEmployeesExcel);

  // Close modals when clicking backdrop
  document.getElementById("employeeModalOverlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("employeeModalOverlay")) closeEmployeeModal();
  });
  document.getElementById("employeeDetailsOverlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("employeeDetailsOverlay")) closeEmployeeDetailsModal();
  });

  // Table vs Cards switch
  document.getElementById("empViewTableBtn")?.addEventListener("click", () => {
    employeeViewMode = "table";
    document.getElementById("empViewTableBtn")?.classList.add("active");
    document.getElementById("empViewCardsBtn")?.classList.remove("active");
    renderEmployees();
  });
  document.getElementById("empViewCardsBtn")?.addEventListener("click", () => {
    employeeViewMode = "cards";
    document.getElementById("empViewCardsBtn")?.classList.add("active");
    document.getElementById("empViewTableBtn")?.classList.remove("active");
    renderEmployees();
  });

  // Master checkbox
  document.getElementById("empMasterCheckbox")?.addEventListener("change", (e) => {
    const checked = e.target.checked;
    document.querySelectorAll(".emp-row-check").forEach((cb) => { cb.checked = checked; });
    updateEmployeeBulkBar();
  });

  // Row checkboxes (bulk select) & bulk delete button
  document.getElementById("employeesTableBody")?.addEventListener("change", (e) => {
    if (e.target.closest(".emp-row-check")) updateEmployeeBulkBar();
  });
  document.getElementById("employeeBulkDeleteBtn")?.addEventListener("click", bulkDeleteEmployees);

  // Per page select
  document.getElementById("employeePerPageSelect")?.addEventListener("change", (e) => {
    employeePerPage = parseInt(e.target.value, 10) || 10;
    employeeCurrentPage = 1;
    renderEmployees();
  });

  // Filter & sort change events
  document.getElementById("employeeSortSelect")?.addEventListener("change", () => {
    employeeCurrentPage = 1;
    renderEmployees();
  });
  document.getElementById("employeeFilterDepartment")?.addEventListener("change", () => {
    employeeCurrentPage = 1;
    renderEmployees();
  });
  document.getElementById("employeeFilterPosition")?.addEventListener("change", () => {
    employeeCurrentPage = 1;
    renderEmployees();
  });
  document.getElementById("employeeFilterStatus")?.addEventListener("change", () => {
    employeeCurrentPage = 1;
    renderEmployees();
  });
  document.getElementById("employeeSearchInput")?.addEventListener("input", debounce(() => {
    employeeCurrentPage = 1;
    renderEmployees();
  }));

  // Reset filters
  document.getElementById("employeeResetAllFiltersBtn")?.addEventListener("click", () => {
    const searchInput = document.getElementById("employeeSearchInput");
    if (searchInput) searchInput.value = "";
    const dept = document.getElementById("employeeFilterDepartment");
    if (dept) dept.value = "";
    const pos = document.getElementById("employeeFilterPosition");
    if (pos) pos.value = "";
    const st = document.getElementById("employeeFilterStatus");
    if (st) st.value = "";
    const sort = document.getElementById("employeeSortSelect");
    if (sort) sort.value = "name_asc";
    employeeCurrentPage = 1;
    renderEmployees();
  });

  // Active chips clear click
  document.getElementById("employeeActiveChips")?.addEventListener("click", (e) => {
    const target = e.target.closest("[data-clear]");
    if (!target) return;
    const kind = target.dataset.clear;
    if (kind === "status") document.getElementById("employeeFilterStatus").value = "";
    if (kind === "department") document.getElementById("employeeFilterDepartment").value = "";
    if (kind === "position") document.getElementById("employeeFilterPosition").value = "";
    if (kind === "query") document.getElementById("employeeSearchInput").value = "";
    employeeCurrentPage = 1;
    renderEmployees();
  });

  // Pagination navigation clicks
  document.getElementById("employeePaginationNav")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-emp-page]");
    if (!btn || btn.disabled) return;
    employeeCurrentPage = parseInt(btn.dataset.empPage, 10);
    renderEmployees();
  });

  // Table row actions & Cards actions
  const handleEmpAction = (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const { action, id } = btn.dataset;
    if (action === "view-employee") openEmployeeDetailsModal(id);
    if (action === "edit-employee") openEditEmployeeModal(id);
    if (action === "delete-employee") deleteEmployee(id);
  };
  document.getElementById("employeesTableBody")?.addEventListener("click", handleEmpAction);
  document.getElementById("employeesCardsGrid")?.addEventListener("click", handleEmpAction);

  // Registry events
  document.getElementById('registrySearchInput')?.addEventListener('input', debounce(() => { registryCurrentPage = 1; renderRegistry(); }));
  document.getElementById('registryFilterStatus')?.addEventListener('change', () => { registryCurrentPage = 1; renderRegistry(); });
  document.getElementById('registryFilterCategory')?.addEventListener('change', () => { registryCurrentPage = 1; renderRegistry(); });
  document.getElementById('registryFilterLocation')?.addEventListener('change', () => { registryCurrentPage = 1; renderRegistry(); });
  document.getElementById('registrySortField')?.addEventListener('change', () => { registryCurrentPage = 1; renderRegistry(); });
  document.getElementById('registrySortDir')?.addEventListener('change', () => { registryCurrentPage = 1; renderRegistry(); });
  document.getElementById('exportRegistryCsvBtn')?.addEventListener('click', exportRegistryCsv);
  document.getElementById('exportRegistryXlsBtn')?.addEventListener('click', exportRegistryXls);
  document.getElementById('exportBalanceCsvBtn')?.addEventListener('click', exportBalanceCsv);
  document.getElementById('registryPerPageSelect')?.addEventListener('change', (e) => {
    registryPerPage = parseInt(e.target.value, 10);
    registryCurrentPage = 1;
    renderRegistry();
  });

  // Filter toggle buttons
  document.querySelectorAll('.filter-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const target = document.getElementById(targetId);
      if (target) {
        const isHidden = target.style.display === 'none';
        target.style.display = isHidden ? 'flex' : 'none';
        btn.classList.toggle('active', isHidden);
      }
    });
  });

  // Burger menu for mobile
  const burgerBtn = document.getElementById('burgerBtn');
  const sidebar = document.getElementById('sidebar');
  if (burgerBtn && sidebar) {
    burgerBtn.addEventListener('click', () => sidebar.classList.toggle('open'));
    dom.menuLinks.forEach((link) => link.addEventListener('click', () => sidebar.classList.remove('open')));
  }

  // Kit templates
  document.getElementById("addKitItemBtn")?.addEventListener("click", addKitItemRow);
  document.getElementById("saveKitBtn")?.addEventListener("click", addKitTemplate);
  document.getElementById("kitTemplatesList")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const kitId = btn.dataset.kitId;
    if (btn.dataset.action === "delete-kit") deleteKitTemplate(kitId);
    if (btn.dataset.action === "issue-kit") issueKitTemplate(kitId);
  });
}

// ─── LABEL PRINTING ───────────────────────────────────────────

function quickPrintLabel(assetId) {
  const asset = getAssetById(assetId);
  if (!asset) return;
  // Открываем окно этикеток с этой позицией предвыбранной и ничем другим.
  labelSelection = new Map([[assetId, "1"]]);
  openLabelsModal();
}


function openLabelsModal() {
  document.getElementById("labelsOverlay").classList.remove("hidden");
  populateLabelFilterDropdowns();
  populateLabelEmployeeSelect();
  renderLabelGrid();
  updateLabelSizeHint();
}

function closeLabelsModal() {
  document.getElementById("labelsOverlay").classList.add("hidden");
}

async function openLanQrModal(userId) {
  const overlay = document.getElementById("lanQrOverlay");
  const body = document.getElementById("lanQrBody");
  overlay.classList.remove("hidden");
  body.innerHTML = `<p class="muted">Загрузка…</p>`;
  let info;
  try {
    const response = await apiFetch("/api/lan-info");
    info = await response.json();
  } catch {
    body.innerHTML = `<p class="muted">Не удалось получить данные с сервера.</p>`;
    return;
  }
  if (!info.lanMode || !info.lanIp) {
    body.innerHTML = `<p class="muted">Сетевой режим выключен — телефон не сможет подключиться.<br>Запустите <code>setup_lan.bat</code> от имени администратора, затем перезапустите приложение.</p>`;
    return;
  }
  let pairing;
  try {
    const pairResponse = await apiFetch("/api/pair/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    pairing = await pairResponse.json();
    if (!pairResponse.ok) throw new Error(pairing.error || "Не удалось сгенерировать код сопряжения.");
  } catch (error) {
    body.innerHTML = `<p class="muted">${error.message}</p>`;
    return;
  }
  const url = `http://${info.lanIp}:${info.port}`;
  const payload = `WHC1:${JSON.stringify({ url, code: pairing.code, secret: pairing.secret })}`;
  body.innerHTML = `
    <div class="lan-qr-code">${qrHtml(payload, 60)}</div>
    <p class="muted">Отсканируйте в приложении на телефоне (Настройки → «Сканировать QR сервера») в течение 10 минут.<br>Адрес: <code>${url}</code></p>
  `;
}

function closeLanQrModal() {
  document.getElementById("lanQrOverlay").classList.add("hidden");
}

async function openUsersModal() {
  document.getElementById("usersOverlay").classList.remove("hidden");
  await renderUsersTable();
}

function closeUsersModal() {
  document.getElementById("usersOverlay").classList.add("hidden");
}

async function renderUsersTable() {
  const response = await apiFetch("/api/users");
  const data = await response.json();
  const qrIcon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="5" height="5" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="2" width="5" height="5" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="9" width="5" height="5" stroke="currentColor" stroke-width="1.3"/><path d="M9 9h2v2H9zM12 9h2v2h-2zM9 12h2v2H9zM12 12h2v2h-2z" fill="currentColor"/></svg>`;
  const deactivateIcon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="5" r="2.25" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 13c0-2.05 1.79-3.5 4-3.5 .53 0 1.03.08 1.5.23" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M10.5 9.5l3.5 3.5M14 9.5l-3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
  const activateIcon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="5" r="2.25" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 13c0-2.05 1.79-3.5 4-3.5 .53 0 1.03.08 1.5.23" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M10.25 11.5l1.75 1.75 3-3.25" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (!data.users.length) {
    document.getElementById("usersTableBody").innerHTML = `<tr><td colspan="4" class="users-empty">Пользователей пока нет.</td></tr>`;
    return;
  }
  document.getElementById("usersTableBody").innerHTML = data.users.map((u) => `
    <tr data-user-id="${escapeHtml(u.id)}">
      <td>${escapeHtml(u.username)}</td>
      <td class="users-role">${escapeHtml(u.role)}</td>
      <td>
        <span class="chip ${u.isActive ? "ok" : "muted"} users-status"><span class="chip-dot"></span>${u.isActive ? "Активен" : "Отключён"}</span>
      </td>
      <td>
        <div class="users-row-actions">
          <button type="button" data-action="toggle-active" data-next-active="${u.isActive ? "false" : "true"}">${u.isActive ? deactivateIcon : activateIcon}${u.isActive ? "Деактивировать" : "Активировать"}</button>
          <button type="button" class="secondary users-qr-btn" data-action="generate-qr">${qrIcon} QR</button>
        </div>
      </td>
    </tr>
  `).join("");
}

async function openBackupsModal() {
  document.getElementById("backupsOverlay").classList.remove("hidden");
  await renderBackupsTable();
}

function closeBackupsModal() {
  document.getElementById("backupsOverlay").classList.add("hidden");
}

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

async function openSettingsModal() {
  const response = await apiFetch("/api/settings");
  const data = await response.json();
  document.getElementById("checkUpdatesInput").checked = Boolean(data.checkUpdates);
  const warrantyInput = document.getElementById("attentionWarrantyDaysInput");
  warrantyInput.value = data.attentionWarrantyDays ?? 30;
  warrantyInput.dataset.lastGood = warrantyInput.value;
  const repairInput = document.getElementById("attentionRepairDaysInput");
  repairInput.value = data.attentionRepairDays ?? 14;
  repairInput.dataset.lastGood = repairInput.value;
  document.getElementById("currentVersionLabel").textContent =
    `Версия программы: ${state.currentVersion || "неизвестна"}`;
  document.getElementById("settingsOverlay").classList.remove("hidden");
}

function closeSettingsModal() {
  document.getElementById("settingsOverlay").classList.add("hidden");
}

let updateBannerDismissed = false;

function renderUpdateBanner() {
  const banner = document.getElementById("updateBanner");
  if (!banner) return;
  const latest = state.latestVersion;
  if (!latest || updateBannerDismissed) {
    banner.classList.add("hidden");
    return;
  }
  document.getElementById("updateBannerText").textContent =
    `Доступна версия ${latest} (у вас ${state.currentVersion}).`;
  // releaseUrl comes from a local cache file populated by updates.py parsing
  // a GitHub API response — not directly attacker-controlled — but a scheme
  // check here is cheap defense-in-depth against a stray javascript: value
  // ever reaching a clickable link.
  const releaseUrl = typeof state.releaseUrl === "string" && state.releaseUrl.startsWith("https://")
    ? state.releaseUrl
    : "https://github.com/ssk1tlz/warehouse/releases";
  document.getElementById("updateBannerLink").href = releaseUrl;
  banner.classList.remove("hidden");
}

function formatBytes(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / (1024 * 1024)).toFixed(1)} МБ`;
}

async function renderBackupsTable() {
  const response = await apiFetch("/api/backups");
  const data = await response.json();
  document.getElementById("backupsTableBody").innerHTML = data.backups.map((b) => `
    <tr data-filename="${escapeHtml(b.filename)}">
      <td>${escapeHtml(b.filename)}</td>
      <td>${escapeHtml(new Date(b.createdAt).toLocaleString("ru-RU"))}</td>
      <td>${formatBytes(b.sizeBytes)}</td>
      <td><button type="button" data-action="restore-backup">Восстановить</button></td>
    </tr>
  `).join("");
}

function getLabelAssets() {
  // Показываем всю технику, не только ту что на складе
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

function populateLabelEmployeeSelect() {
  const select = document.getElementById("labelEmployeeSelect");
  if (!select) return;
  const current = select.value;
  // Все сотрудники, а не только активные — как в окне возврата
  // (returnEmployeeSelect): уволенный может всё ещё числить на себе
  // технику, которую нужно промаркировать при передаче.
  const employees = getVisibleEmployees(state.employees).sort((a, b) => a.fullName.localeCompare(b.fullName, "ru"));
  select.innerHTML = `<option value="">— сотрудник —</option>`
    + employees.map((employee) =>
      `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.fullName)}</option>`).join("");
  select.value = current;
}

// Выбор в сетке этикеток хранится не в DOM, а здесь: DOM пересоздаётся при
// каждой смене фильтра, и позиция, переставшая проходить фильтр, раньше
// пропадала бы из выбора без возврата — даже после того, как фильтр снова
// сбрасывали, потому что следующая отрисовка опять читала только то, что
// сейчас в DOM. assetId -> количество этикеток (строка, как в поле ввода).
let labelSelection = new Map();

function renderLabelGrid() {
  const grid = document.getElementById("labelGrid");
  if (!grid) return;
  const assets = getLabelAssets();
  if (!assets.length) {
    grid.innerHTML = '<div class="empty-state">Нет техники на складе.</div>';
    updateLabelCount();
    return;
  }

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

function labelSelectAll(checked) {
  document.getElementById("labelGrid").querySelectorAll(".label-item").forEach(item => {
    item.classList.toggle("selected", checked);
    const cb = item.querySelector("input[type=checkbox]");
    cb.checked = checked;
    const assetId = item.dataset.id;
    if (checked) labelSelection.set(assetId, item.querySelector(".label-qty-input")?.value || "1");
    else labelSelection.delete(assetId);
  });
  updateLabelCount();
}

// «Добавить технику сотрудника»: находит всю технику сотрудника — и
// закреплённую лично, и стоящую на его рабочем месте (см.
// getEmployeeHoldings — то же самое сотрудник видит на своей карточке;
// без рабочего места здесь техника с целого стола просто не находилась
// бы) — и довыбирает её, дополняя то, что уже отмечено вручную (§5 ТЗ:
// «уже выбранные вручную этикетки не должны удаляться»). Выбор хранится
// в labelSelection, а не в DOM (см. renderLabelGrid), поэтому добавление
// не зависит от того, что сейчас проходит фильтр — сбрасываем фильтры
// только чтобы пользователь увидел добавленное, а не потому что иначе
// нельзя было бы отметить чекбокс. Повторное добавление уже выбранной
// позиции — no-op, отдельная защита от дублей не нужна: одна запись в
// Map на asset.id.
function addEmployeeAssetsToLabelSelection() {
  const select = document.getElementById("labelEmployeeSelect");
  const employeeId = select?.value || "";
  if (!employeeId) {
    showToast("Выберите сотрудника.", "warning");
    return;
  }
  const { personal, atWorkplace } = getEmployeeHoldings(employeeId);
  const employeeAssetIds = new Set([...personal, ...atWorkplace].map((entry) => entry.asset.id));
  if (!employeeAssetIds.size) {
    showToast("За этим сотрудником не закреплена техника — ни лично, ни на рабочем месте.", "warning");
    return;
  }

  let added = 0;
  employeeAssetIds.forEach((assetId) => {
    if (!labelSelection.has(assetId)) added += 1;
    labelSelection.set(assetId, labelSelection.get(assetId) || "1");
  });

  const searchInput = document.getElementById("labelSearchInput");
  const categorySelect = document.getElementById("labelFilterCategory");
  const locationSelect = document.getElementById("labelFilterLocation");
  const unprintedCheck = document.getElementById("labelUnprintedCheck");
  if (searchInput) searchInput.value = "";
  if (categorySelect) categorySelect.value = "";
  if (locationSelect) locationSelect.value = "";
  if (unprintedCheck) unprintedCheck.checked = false;
  renderLabelGrid();

  showToast(`Добавлено позиций: ${added} (найдено за сотрудником: ${employeeAssetIds.size}).`, "success");
}

function updateLabelCount() {
  const el = document.getElementById("labelCountSpan");
  if (el) el.textContent = `${labelSelection.size} выбрано`;
}

function getSelectedLabelItems() {
  const items = [];
  labelSelection.forEach((qtyValue, assetId) => {
    const asset = getAssetById(assetId);
    if (!asset) return;
    items.push({ asset, qty: Math.max(1, parseInt(qtyValue || 1)) });
  });
  return items;
}

function getLabelSize() {
  const val = document.getElementById("labelSizeSelect")?.value || "58x40";
  const [w, h] = val.split("x").map(Number);
  return { w, h, label: val };
}

// The library's default stringToBytes() truncates each UTF-16 code unit to
// its low byte, which mangles Cyrillic (asset names/locations). Switch it to
// the library's own proper UTF-8 encoder.
if (typeof qrcode !== 'undefined' && qrcode.stringToBytesFuncs && qrcode.stringToBytesFuncs['UTF-8']) {
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
}

// Build the module matrix for `text` using the vendored qrcode-lib.js
// (Kazuhiko Arase's QR encoder, loaded before app.js — see index.html).
// typeNumber 0 = smallest version that fits the data; 'M' = 15% error correction,
// a reasonable default for printed asset labels that may get scuffed.
function qrModuleGrid(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  const modules = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    modules.push(row);
  }
  return { n, modules };
}

// Render a QR code as pure HTML cells (no canvas/SVG), one row <div> of
// inline-block <span> modules — same technique as the old barcode used, so
// it prints and embeds in Word reliably.
function qrHtml(text, sizeMm) {
  const { n, modules } = qrModuleGrid(text);
  const cell = (sizeMm / n).toFixed(4);
  let rows = '';
  for (let r = 0; r < n; r++) {
    let cells = '';
    for (let c = 0; c < n; c++) {
      const on = modules[r][c];
      cells += `<span style="display:inline-block;width:${cell}mm;height:${cell}mm;background:${on ? '#000' : 'transparent'}"></span>`;
    }
    rows += `<div style="font-size:0;line-height:0;white-space:nowrap;height:${cell}mm">${cells}</div>`;
  }
  return `<div style="width:${sizeMm}mm;margin:0 auto">${rows}</div>`;
}

// Пропорции подогнаны под эталонный шаблон этикетки (TAB-0020):
// имя ≈ 8% высоты, мелкие строки ≈ 5.6%, код под штрих-кодом той же величины.
function labelFontSizes(heightMm) {
  const LHpt = heightMm * 72 / 25.4;
  const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
  const name = clamp(6, 9, LHpt * 0.081);
  const small = clamp(4.5, 7, name * 0.7);
  const code = clamp(4.5, 6.5, small);
  return { name, small, code };
}
const LABEL_PAD_MM = 2.2;   // внутренние поля этикетки
const SMALL_LINE_H = 1.45;  // межстрочный интервал мелких строк

const MM2PX = 96 / 25.4;   // CSS pixels per mm at 96 dpi
const PT2PX = 96 / 72;     // CSS pixels per pt
const NAME_LINE_H = 1.2;   // line-height factor for the product name

// Returns a width(px) measuring function for the given font, using a cached
// canvas. Falls back to a rough estimate when there is no DOM (e.g. unit tests).
let _labelMeasureCanvas = null;
function makeTextMeasurer(fontPx, bold) {
  if (typeof document === 'undefined' || !document.createElement) {
    return (s) => String(s).length * fontPx * 0.55;
  }
  if (!_labelMeasureCanvas) _labelMeasureCanvas = document.createElement('canvas');
  const ctx = _labelMeasureCanvas.getContext('2d');
  ctx.font = `${bold ? '700 ' : ''}${fontPx}px Arial, Helvetica, sans-serif`;
  return (s) => ctx.measureText(String(s)).width;
}

// Wrap `text` into lines that fit maxWidthPx, breaking on spaces and
// hard-breaking any single word wider than the line. Returns the lines array.
function wrapTextLines(text, maxWidthPx, measure) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let cur = '';
  const flush = () => { if (cur) { lines.push(cur); cur = ''; } };
  for (const word of words) {
    if (measure(word) > maxWidthPx) {       // overlong token: break by chars
      flush();
      let chunk = '';
      for (const ch of word) {
        if (measure(chunk + ch) <= maxWidthPx) chunk += ch;
        else { if (chunk) lines.push(chunk); chunk = ch; }
      }
      cur = chunk;
      continue;
    }
    const test = cur ? cur + ' ' + word : word;
    if (measure(test) <= maxWidthPx) cur = test;
    else { flush(); cur = word; }
  }
  flush();
  return lines.length ? lines : [''];
}

function wrappedLineCount(text, maxWidthPx, measure) {
  return wrapTextLines(text, maxWidthPx, measure).length;
}

// Truncate a single line with an ellipsis so it fits maxWidthPx.
function clipToWidth(str, maxWidthPx, measure) {
  str = String(str || '');
  if (measure(str) <= maxWidthPx) return str;
  while (str.length > 1 && measure(str + '…') > maxWidthPx) str = str.slice(0, -1);
  return str + '…';
}

// Pick the largest font (pt) from maxPt down to minPt such that the wrapped
// name fits within availHeightPx. Returns { pt, lines }.
function fitNameFont(text, maxWidthPx, availHeightPx, maxPt, minPt) {
  for (let pt = maxPt; pt >= minPt; pt -= 0.25) {
    const px = pt * PT2PX;
    const lines = wrappedLineCount(text, maxWidthPx, makeTextMeasurer(px, true));
    if (lines * px * NAME_LINE_H <= availHeightPx) return { pt: Math.round(pt * 100) / 100, lines };
  }
  const px = minPt * PT2PX;
  return { pt: minPt, lines: wrappedLineCount(text, maxWidthPx, makeTextMeasurer(px, true)) };
}

function buildLabelHtml(asset, { showInv = true, showQr = true, showLoc = false, width, height }) {
  const f = labelFontSizes(height);
  const pad = LABEL_PAD_MM;
  const contentW = Math.max(1, width - pad * 2);
  const bcData = (showInv && asset.inventoryNumber)
    ? asset.inventoryNumber
    : (asset.serialNumber && asset.serialNumber !== 'Отсутствует' ? asset.serialNumber : (asset.inventoryNumber || asset.name || ''));
  // The QR encodes the stable asset id, not bcData — the mobile app's scanner
  // (mobile/www/js/qr.js, WAREHOUSE_QR_PREFIX) only recognizes this prefix.
  // The printed caption below still shows bcData (inventory/serial number).
  const qrData = asset.id ? `WH1:${asset.id}` : '';

  const catLine = asset.category
    ? `<div style="font-size:${f.small}pt;color:#666;line-height:${SMALL_LINE_H};margin-top:0.5pt;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(asset.category)}</div>` : '';
  const snLine = (asset.serialNumber && asset.serialNumber !== 'Отсутствует')
    ? `<div style="font-size:${f.small}pt;color:#808080;line-height:${SMALL_LINE_H};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">S/N: ${escapeHtml(asset.serialNumber)}</div>` : '';
  const locLine = (showLoc && asset.location)
    ? `<div style="font-size:${f.small}pt;color:#2563eb;line-height:${SMALL_LINE_H};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Локация: ${escapeHtml(asset.location)}</div>` : '';
  const invLine = (showInv && asset.inventoryNumber && !showQr)
    ? `<div style="font-size:${f.small}pt;color:#555;line-height:${SMALL_LINE_H}">Инв: ${escapeHtml(asset.inventoryNumber)}</div>` : '';
  const empName = getAssetEmployeeName(asset);
  const empLine = empName
    ? `<div style="font-size:${f.small}pt;color:#000;font-weight:600;line-height:${SMALL_LINE_H};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(empName)}</div>` : '';

  let bottom = '';
  let bcBlockMm = 0;
  if (showQr && bcData) {
    const stripH = Math.max(6, height * 0.34);
    const qrSize = Math.min(stripH, contentW * 0.4);
    // separator + paddings (~5pt) + code text line (code size * 1.2) + margin (1.5pt)
    bcBlockMm = qrSize + (5 + f.code * 1.2 + 1.5) * (25.4 / 72);
    bottom = `<div style="border-top:0.4pt solid #ccc;margin-top:2pt;padding-top:2pt;text-align:center">
        ${qrHtml(qrData, qrSize)}
        <div style="font-size:${f.code}pt;text-align:center;color:#000;margin-top:1.5pt;letter-spacing:0.3px">${escapeHtml(bcData)}</div>
      </div>`;
  }

  // Auto-fit the product name: shrink the font and wrap until it fits the
  // space left after the small lines and the QR block.
  const smallLineMm = f.small * SMALL_LINE_H * (25.4 / 72);
  const smallLinesCount = (catLine ? 1 : 0) + (snLine ? 1 : 0) + (locLine ? 1 : 0) + (invLine ? 1 : 0) + (empLine ? 1 : 0);
  const availNameMm = Math.max(smallLineMm, height - pad * 2 - bcBlockMm - smallLinesCount * smallLineMm - 0.5);
  const fit = fitNameFont(asset.name || '', contentW * MM2PX, availNameMm * MM2PX, f.name, 4);

  return `<div style="
    width:${width}mm; height:${height}mm;
    border:0.5pt solid #d0d0d0;
    padding:${pad}mm; display:flex; flex-direction:column;
    overflow:hidden; background:#fff; font-family:Arial,Helvetica,sans-serif;
    box-sizing:border-box; page-break-inside:avoid;
  ">
    <div style="flex:1 1 auto;min-width:0;overflow:hidden">
      <div style="font-size:${fit.pt}pt;font-weight:700;line-height:${NAME_LINE_H};color:#000;word-break:break-word;overflow-wrap:anywhere">${escapeHtml(asset.name)}</div>
      ${catLine}
      ${snLine}
      ${locLine}
      ${invLine}
      ${empLine}
    </div>
    ${bottom}
  </div>`;
}

// Draw one label onto a canvas context, mirroring buildLabelHtml. Coordinates
// are in mm; S is the pixels-per-mm scale.
function drawLabelOnCanvas(ctx, asset, x0mm, y0mm, wMm, hMm, opts, S) {
  const { showInv = true, showQr = true, showLoc = false } = opts || {};
  const f = labelFontSizes(hMm);
  const PADmm = LABEL_PAD_MM;
  const ptToPx = (pt) => pt * 25.4 / 72 * S;
  const x = x0mm * S, y = y0mm * S, w = wMm * S, h = hMm * S, pad = PADmm * S;
  const contentWmm = wMm - PADmm * 2;
  const cw = contentWmm * S;

  // background + square border (без скруглений: рамки соседних этикеток
  // совпадают по координате и сливаются в одну линию реза)
  ctx.fillStyle = '#fff';
  ctx.fillRect(x, y, w, h);
  ctx.lineWidth = Math.max(1, 0.5 * S * 0.3528);
  ctx.strokeStyle = '#d0d0d0';
  ctx.strokeRect(x, y, w, h);

  const bcData = (showInv && asset.inventoryNumber)
    ? asset.inventoryNumber
    : (asset.serialNumber && asset.serialNumber !== 'Отсутствует' ? asset.serialNumber : (asset.inventoryNumber || asset.name || ''));
  // See buildLabelHtml: QR encodes the asset id (WH1: prefix), not bcData.
  const qrData = asset.id ? `WH1:${asset.id}` : '';
  const hasCat = !!asset.category;
  const hasSn = !!(asset.serialNumber && asset.serialNumber !== 'Отсутствует');
  const hasLoc = !!(showLoc && asset.location);
  const hasInv = !!(showInv && asset.inventoryNumber && !showQr);
  const empName = getAssetEmployeeName(asset);
  const hasEmp = !!empName;

  const codePx = ptToPx(f.code);
  const stripHmm = Math.max(6, hMm * 0.34);
  const qrSizeMm = Math.min(stripHmm, contentWmm * 0.4);
  const bcBlockMm = showQr && bcData ? qrSizeMm + (5 + f.code * 1.2 + 1.5) * (25.4 / 72) : 0;
  const slh = ptToPx(f.small) * SMALL_LINE_H;
  const smallMm = f.small * SMALL_LINE_H * (25.4 / 72);
  const smallCount = (hasCat ? 1 : 0) + (hasSn ? 1 : 0) + (hasLoc ? 1 : 0) + (hasInv ? 1 : 0) + (hasEmp ? 1 : 0);
  const availNameMm = Math.max(smallMm, hMm - PADmm * 2 - bcBlockMm - smallCount * smallMm - 0.5);

  // auto-fit name (in output px units)
  let nPt = f.name, nameLines = [''];
  for (; nPt >= 4; nPt -= 0.25) {
    const fpx = ptToPx(nPt);
    const lines = wrapTextLines(asset.name || '', cw, makeTextMeasurer(fpx, true));
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

  if (showQr && bcData) {
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
    ctx.fillText(String(bcData), x + w / 2, codeTop);
    ctx.textAlign = 'left';
  }
}

// Лист печати — A4 книжный. Этикетки лежат вплотную и заполняют лист без
// остатка: от края бумаги до стикера остаётся SHEET_MARGIN_MM, а вся
// оставшаяся площадь делится между колонками и рядами нацело. Поэтому
// размер этикетки здесь — следствие раскладки, а не наоборот: из списка
// размеров берётся только высота, и то как ориентир для числа рядов.
const SHEET_W_MM = 210, SHEET_H_MM = 297;
const SHEET_MARGIN_MM = 4.65;   // поле от края листа до стикера

// Read current label modal settings (size, columns, toggles) + selected labels,
// and compute the sheet layout shared by print, preview, JPG, PDF and Word.
function getLabelSheetPlan() {
  const items = getSelectedLabelItems();
  const nominal = getLabelSize();
  const cols = Math.max(1, parseInt(document.getElementById('labelColsInput')?.value || 5));
  const opts = {
    showInv: document.getElementById('labelInvCheck')?.checked ?? true,
    showQr: document.getElementById('labelQrCheck')?.checked ?? true,
    showLoc: document.getElementById('labelLocCheck')?.checked ?? false,
  };
  const labels = [];
  items.forEach(({ asset, qty }) => { for (let i = 0; i < qty; i++) labels.push(asset); });

  // Ячейка равна самой этикетке: зазора между ними нет, соседние рамки
  // ложатся на одну линию и образуют сплошную сетку реза.
  const areaW = SHEET_W_MM - SHEET_MARGIN_MM * 2;
  const areaH = SHEET_H_MM - SHEET_MARGIN_MM * 2;
  const useCols = cols;
  const w = areaW / useCols;
  // Рядов столько, сколько ближе всего к номинальной высоте; дальше высота
  // растягивается, чтобы ряды легли ровно от поля до поля.
  const rowsPerPage = Math.max(1, Math.round(areaH / nominal.h));
  const h = areaH / rowsPerPage;
  const offsetXmm = SHEET_MARGIN_MM, offsetYmm = SHEET_MARGIN_MM;
  const perPage = useCols * rowsPerPage;
  const pageCount = Math.max(1, Math.ceil(labels.length / perPage));

  return { labels, w, h, opts, sheetW: SHEET_W_MM, sheetH: SHEET_H_MM,
           offsetXmm, offsetYmm, useCols, rowsPerPage, perPage, pageCount };
}

// Фактический размер этикетки — производная от раскладки, а не от списка
// размеров, поэтому показываем его рядом с настройками.
function updateLabelSizeHint() {
  const el = document.getElementById('labelSizeHint');
  if (!el) return;
  const { w, h, useCols, rowsPerPage, perPage } = getLabelSheetPlan();
  el.textContent = `Факт. размер: ${w.toFixed(1)} × ${h.toFixed(1)} мм · сетка ${useCols} × ${rowsPerPage} = ${perPage} на листе`;
}

// Render one sheet of labels onto a fresh canvas at the given pixels-per-mm scale.
function renderLabelSheet(plan, pageIndex, S) {
  const { labels, w, h, opts, sheetW, sheetH, offsetXmm, offsetYmm, useCols, perPage } = plan;
  const slice = labels.slice(pageIndex * perPage, (pageIndex + 1) * perPage);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sheetW * S);
  canvas.height = Math.round(sheetH * S);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  slice.forEach((asset, idx) => {
    const col = idx % useCols, row = Math.floor(idx / useCols);
    const lx = offsetXmm + col * w;
    const ly = offsetYmm + row * h;
    drawLabelOnCanvas(ctx, asset, lx, ly, w, h, opts, S);
  });
  return canvas;
}

function exportLabelsJpg() {
  const plan = getLabelSheetPlan();
  if (!plan.labels.length) { showToast('Выберите хотя бы одну позицию.', 'warning'); return; }
  const S = 300 / 25.4; // 300 dpi → A4 = 2480 × 3508 px
  const stamp = new Date().toISOString().slice(0, 10);
  for (let pg = 0; pg < plan.pageCount; pg++) {
    const canvas = renderLabelSheet(plan, pg, S);
    const suffix = plan.pageCount > 1 ? `_${pg + 1}` : '';
    canvas.toBlob((blob) => {
      if (!blob) { showToast('Не удалось создать JPG.', 'error'); return; }
      triggerDownload(blob, `Этикетки_A4_${stamp}${suffix}.jpg`);
    }, 'image/jpeg', 0.92);
  }
  showToast(`JPG (A4) скачан: ${plan.labels.length} этикеток, ${plan.pageCount} стр.`, 'success');
}

// ─── LABEL PREVIEW (A4 sheet on screen) ───────────────────────
let _labelPreviewPage = 0;
let _labelPreviewPlan = null;

function openLabelPreview() {
  const plan = getLabelSheetPlan();
  if (!plan.labels.length) { showToast('Выберите хотя бы одну позицию.', 'warning'); return; }
  _labelPreviewPlan = plan;
  _labelPreviewPage = 0;
  document.getElementById('labelPreviewOverlay')?.classList.remove('hidden');
  renderLabelPreviewPage();
}

function closeLabelPreview() {
  document.getElementById('labelPreviewOverlay')?.classList.add('hidden');
  _labelPreviewPlan = null;
}

function renderLabelPreviewPage() {
  const plan = _labelPreviewPlan;
  if (!plan) return;
  const holder = document.getElementById('labelPreviewCanvasHolder');
  const info = document.getElementById('labelPreviewPageInfo');
  if (!holder) return;
  const S = 150 / 25.4; // 150 dpi is plenty for on-screen preview
  const canvas = renderLabelSheet(plan, _labelPreviewPage, S);
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  canvas.style.display = 'block';
  holder.innerHTML = '';
  holder.appendChild(canvas);
  if (info) info.textContent = `Лист ${_labelPreviewPage + 1} из ${plan.pageCount} · ${plan.labels.length} этикеток · ${plan.w.toFixed(1)} × ${plan.h.toFixed(1)} мм`;
  const prev = document.getElementById('labelPreviewPrev');
  const next = document.getElementById('labelPreviewNext');
  if (prev) prev.disabled = _labelPreviewPage <= 0;
  if (next) next.disabled = _labelPreviewPage >= plan.pageCount - 1;
}

function labelPreviewNav(delta) {
  if (!_labelPreviewPlan) return;
  const n = _labelPreviewPlan.pageCount;
  _labelPreviewPage = Math.max(0, Math.min(n - 1, _labelPreviewPage + delta));
  renderLabelPreviewPage();
}

function printLabels() {
  const plan = getLabelSheetPlan();
  if (!plan.labels.length) { showToast('Выберите хотя бы одну позицию.', 'warning'); return; }
  const { labels, w, h, opts, sheetW, sheetH, offsetYmm, useCols, rowsPerPage, perPage, pageCount } = plan;

  // Одна .sheet-обёртка на страницу — разрывы страниц ложатся ровно туда же,
  // где их показывает предпросмотр и куда их ставят экспорты JPG/PDF.
  let sheetsHtml = "";
  for (let pg = 0; pg < pageCount; pg++) {
    const slice = labels.slice(pg * perPage, (pg + 1) * perPage);
    let rows = "";
    for (let i = 0; i < slice.length; i += useCols) {
      rows += "<tr>" + slice.slice(i, i + useCols)
        .map(a => `<td>${buildLabelHtml(a, { ...opts, width: w, height: h })}</td>`).join("") + "</tr>";
    }
    sheetsHtml += `<div class="sheet"><table>${rows}</table></div>`;
  }

  const pw = window.open("", "_blank", "width=1100,height=800");
  if (!pw) return;
  pw.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Этикетки</title>
  <style>
    @page { size: A4 portrait; margin: 0; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: Arial, sans-serif; background: #fff; margin: 0; }
    /* Высота .sheet не задаётся: поле сверху + сетка = ${(offsetYmm + rowsPerPage * h).toFixed(2)}мм
       при ${sheetH}мм страницы, а лишний миллиметр выдавил бы пустую страницу. */
    .sheet { width: ${sheetW}mm; padding-top: ${offsetYmm}mm; page-break-after: always; }
    .sheet:last-child { page-break-after: auto; }
    table { border-collapse: collapse; table-layout: fixed; width: ${useCols * w}mm; margin: 0 auto; }
    td { padding: 0; vertical-align: top; }
  </style></head><body>
  ${sheetsHtml}
  <script>window.onload = () => { setTimeout(() => { window.print(); }, 800); }<\/script>
  </body></html>`);
  pw.document.close();

  markLabelsPrinted([...new Set(labels.map((a) => a.id))]);
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

function exportLabelsExcel() {
  const items = getSelectedLabelItems();
  if (!items.length) { showToast('Выберите хотя бы одну позицию.', 'warning'); return; }

  const rows = [];
  items.forEach(({ asset, qty }) => {
    for (let i = 0; i < qty; i++) {
      rows.push([
        asset.name,
        asset.category || "-",
        asset.inventoryNumber || "-",
        asset.serialNumber || "-",
        asset.purchaseDate ? formatDate(asset.purchaseDate) : "-",
        statusLabels[getAssetStatus(asset)] || asset.status,
        asset.location || "-",
      ]);
    }
  });

  const workbookXml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="Default">
      <Font ss:FontName="Calibri" ss:Size="11"/>
    </Style>
    <Style ss:ID="h">
      <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1"/>
      <Interior ss:Color="#DBEAFE" ss:Pattern="Solid"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2"/>
      </Borders>
    </Style>
    <Style ss:ID="row">
      <Font ss:FontName="Calibri" ss:Size="11"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/>
      </Borders>
    </Style>
  </Styles>
  <Worksheet ss:Name="Этикетки">
    <Table>
      <Column ss:Width="180"/>
      <Column ss:Width="120"/>
      <Column ss:Width="110"/>
      <Column ss:Width="140"/>
      <Column ss:Width="100"/>
      <Column ss:Width="100"/>
      <Column ss:Width="150"/>
      <Row ss:StyleID="h">
        <Cell><Data ss:Type="String">Наименование</Data></Cell>
        <Cell><Data ss:Type="String">Категория</Data></Cell>
        <Cell><Data ss:Type="String">Инв. номер</Data></Cell>
        <Cell><Data ss:Type="String">Серийный номер</Data></Cell>
        <Cell><Data ss:Type="String">Дата покупки</Data></Cell>
        <Cell><Data ss:Type="String">Статус</Data></Cell>
        <Cell><Data ss:Type="String">Локация</Data></Cell>
      </Row>
      ${rows.map(function(r){ return '<Row ss:StyleID="row">' + r.map(function(c){ return '<Cell><Data ss:Type="String">' + escapeXml(c) + '</Data></Cell>'; }).join("") + '</Row>'; }).join("")}
    </Table>
  </Worksheet>
</Workbook>`;

  const blob = new Blob(["\ufeff" + workbookXml], { type: "application/vnd.ms-excel;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `labels-${today()}.xls`;
  link.click();
  URL.revokeObjectURL(url);
}

function exportLabelsWord() {
  const plan = getLabelSheetPlan();
  if (!plan.labels.length) { showToast('Выберите хотя бы одну позицию.', 'warning'); return; }
  const { labels, w, h, opts, sheetW, sheetH, offsetXmm, offsetYmm, useCols } = plan;

  let tableHtml = "";
  for (let i = 0; i < labels.length; i += useCols) {
    const chunk = labels.slice(i, i + useCols);
    tableHtml += "<tr>" + chunk.map(a => `<td style="padding:0;vertical-align:top">${buildLabelHtml(a, { ...opts, width: w, height: h })}</td>`).join("") + "</tr>";
  }

  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8">
<title>Этикетки</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>
  @page { size: ${sheetW}mm ${sheetH}mm; margin: ${offsetYmm}mm ${offsetXmm}mm; }
  body { font-family: Arial, sans-serif; }
  table { border-collapse: collapse; table-layout: fixed; width: ${useCols * w}mm; }
  td { padding: 0; vertical-align: top; }
</style>
</head>
<body>
<table>${tableHtml}</table>
</body></html>`;

  const blob = new Blob([html], { type: "application/msword;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `labels-${today()}.doc`;
  link.click();
  URL.revokeObjectURL(url);
}


// ─── ТЕМА ОФОРМЛЕНИЯ (СВЕТЛАЯ / ТЁМНАЯ) ───────────────────────────
function initTheme() {
  const saved = localStorage.getItem("warehouse_theme") || "light";
  setTheme(saved);
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("warehouse_theme", theme);
  const icon = document.getElementById("themeToggleIcon");
  const text = document.getElementById("themeToggleText");
  if (icon) icon.textContent = theme === "dark" ? "🌙" : "☀️";
  if (text) text.textContent = theme === "dark" ? "Тёмная" : "Светлая";
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  setTheme(next);
}

// ─── ИНИЦИАЛИЗАЦИЯ ────────────────────────────────────────────────
async function init() {
  initTheme();
  bindEvents();
  bindAuthEvents();
  const ready = await ensureAuthenticated();
  if (!ready) return;
  await boot();
}

async function boot() {
  try {
    state = await loadState();
    rebuildLookupMaps();
  } catch (error) {
    if (error.sessionExpired) {
      // apiFetch already cleared the token and showed the login overlay —
      // that's the correct UI response on its own; don't also flash a
      // "can't connect" toast or reset the app to an empty state under it.
      return;
    }
    console.error(error);
    showToast('Не удалось подключиться к серверу. Запускайте через start_server.bat.', 'error');
    state = createEmptyState();
    rebuildLookupMaps();
  }
  resetAssetForm();
  resetEmployeeForm();
  resetOperationForms();
  applyRoleVisibility();
  renderUpdateBanner();
  render();
}

init();

// PDF button uses the same label layout through the browser print dialog.
function exportLabelsPdf() {
  const plan = getLabelSheetPlan();
  if (!plan.labels.length) { showToast('Выберите хотя бы одну позицию.', 'warning'); return; }

  // Страницы рендерятся тем же canvas-движком, что JPG и предпросмотр
  // (полная поддержка кириллицы), и вкладываются в PDF как JPEG 300 dpi.
  const S = 300 / 25.4;
  const PW = 595.28, PH = 841.89; // A4 книжный, в pt
  const pages = [];
  for (let pg = 0; pg < plan.pageCount; pg++) {
    const canvas = renderLabelSheet(plan, pg, S);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    pages.push({ bytes, w: canvas.width, h: canvas.height });
  }

  // Минимальный PDF: каждая страница — JPEG XObject на весь лист A4.
  const enc = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xFF; return u; };
  const chunks = [];
  let offset = 0;
  const push = (part) => { const u = typeof part === 'string' ? enc(part) : part; chunks.push(u); offset += u.length; };

  const offsets = [];
  const objCount = 2 + pages.length * 3;
  push('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  const pageIds = pages.map((_, i) => 3 + i * 3 + 2);
  offsets[1] = offset;
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offsets[2] = offset;
  push(`2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((p) => p + ' 0 R').join(' ')}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((p, i) => {
    const imgId = 3 + i * 3, cntId = imgId + 1, pgId = imgId + 2;
    offsets[imgId] = offset;
    push(`${imgId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`);
    push(p.bytes);
    push('\nendstream\nendobj\n');
    const content = `q ${PW.toFixed(2)} 0 0 ${PH.toFixed(2)} 0 0 cm /Im${i} Do Q`;
    offsets[cntId] = offset;
    push(`${cntId} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    offsets[pgId] = offset;
    push(`${pgId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Contents ${cntId} 0 R /Resources << /XObject << /Im${i} ${imgId} 0 R >> >> >>\nendobj\n`);
  });

  const xrefPos = offset;
  let xref = `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= objCount; id++) xref += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
  push(xref);
  push(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  chunks.forEach((c) => { out.set(c, pos); pos += c.length; });

  const blob = new Blob([out], { type: 'application/pdf' });
  triggerDownload(blob, `Этикетки_${new Date().toISOString().slice(0, 10)}.pdf`);
  showToast(`PDF скачан: ${plan.labels.length} этикеток, ${plan.pageCount} стр.`, 'success');
}
