if (!window.capacitorCapacitorSQLite) {
  throw new Error('@capacitor-community/sqlite plugin bundle not loaded — check index.html script tags.');
}
const { CapacitorSQLite, SQLiteConnection } = window.capacitorCapacitorSQLite;

const sqliteConnection = new SQLiteConnection(CapacitorSQLite);
const DB_NAME = 'warehouse_cache';
let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT, inventory_number TEXT,
  serial_number TEXT, status TEXT, quantity INTEGER, repair_quantity INTEGER,
  retired_quantity INTEGER, location TEXT, purchase_date TEXT, warranty_end TEXT,
  rev INTEGER NOT NULL DEFAULT 0, is_shared INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY, full_name TEXT NOT NULL, department TEXT, site TEXT
);
CREATE TABLE IF NOT EXISTS departments (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS allocations (
  asset_id TEXT NOT NULL, employee_id TEXT, department TEXT, site TEXT, quantity INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_actions (
  client_action_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', server_error TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS movements (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, asset_id TEXT NOT NULL, employee_id TEXT,
  department TEXT, site TEXT, act_number INTEGER, quantity INTEGER, date TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS movements_history (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, asset_id TEXT NOT NULL, asset_name TEXT,
  employee_id TEXT, department TEXT, site TEXT, act_number INTEGER, quantity INTEGER, date TEXT, notes TEXT
);
`;

async function open() {
  db = await sqliteConnection.createConnection(DB_NAME, false, 'no-encryption', 1, false);
  await db.open();
  await db.execute(SCHEMA);
  try {
    await db.execute('ALTER TABLE assets ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0');
  } catch (err) {
    // Та же история, что и с rev ниже: на свежей установке колонку уже создал
    // CREATE TABLE, на обновлённой — предыдущий запуск.
  }
  try {
    await db.execute('ALTER TABLE assets ADD COLUMN rev INTEGER NOT NULL DEFAULT 0');
  } catch (err) {
    // Already has the column — either a fresh install (CREATE TABLE above already
    // added it) or a device that's already been through this upgrade once. SQLite
    // has no "ADD COLUMN IF NOT EXISTS", so a failed ALTER here is the expected,
    // safe outcome on every launch after the first; a genuinely different error
    // would surface immediately on the next db.query/db.run call anyway.
  }
}

async function replaceState(state) {
  // NOTE: deliberately NOT using db.execute('BEGIN TRANSACTION'/'COMMIT'/'ROLLBACK') here.
  // db.execute()/db.run() default their `transaction` parameter to true, which makes each
  // call auto-open its own native transaction. A manual literal-SQL BEGIN would collide with
  // that auto-open (Android's Database.beginTransaction() throws "Already in transaction" if
  // one is already active) and the whole call would fail before anything ran. Instead we use
  // the plugin's own SQLiteDBConnection.executeTransaction(txn) helper, which begins/commits/
  // rolls back the transaction itself and passes `transaction: false` on every statement run
  // inside it — this is the API the plugin is meant to be driven through for a multi-statement,
  // multi-table transaction like this one.
  const txn = [
    { statement: 'DELETE FROM assets' },
    { statement: 'DELETE FROM employees' },
    { statement: 'DELETE FROM departments' },
    { statement: 'DELETE FROM sites' },
    { statement: 'DELETE FROM allocations' },
    { statement: 'DELETE FROM movements' },
    { statement: 'DELETE FROM movements_history' },
  ];
  const assetNameById = new Map(state.assets.map((a) => [a.id, a.name]));
  for (const a of state.assets) {
    txn.push({
      statement: `INSERT INTO assets (id, name, category, inventory_number, serial_number, status, quantity,
       repair_quantity, retired_quantity, location, purchase_date, warranty_end, rev, is_shared)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      values: [a.id, a.name, a.category, a.inventoryNumber, a.serialNumber, a.status, a.quantity,
        a.repairQuantity, a.retiredQuantity, a.location, a.purchaseDate, a.warrantyEnd, a.rev || 0,
        a.isShared ? 1 : 0],
    });
    for (const alloc of a.allocations || []) {
      txn.push({
        statement: 'INSERT INTO allocations (asset_id, employee_id, department, site, quantity) VALUES (?,?,?,?,?)',
        values: [a.id, alloc.employeeId, alloc.department, alloc.site, alloc.quantity],
      });
    }
  }
  for (const e of state.employees) {
    txn.push({
      statement: 'INSERT INTO employees (id, full_name, department, site) VALUES (?,?,?,?)',
      values: [e.id, e.fullName, e.department, e.site],
    });
  }
  for (const d of state.departments) {
    txn.push({ statement: 'INSERT INTO departments (id, name) VALUES (?,?)', values: [d.id, d.name] });
  }
  for (const s of state.sites) {
    txn.push({ statement: 'INSERT INTO sites (id, name) VALUES (?,?)', values: [s.id, s.name] });
  }
  // Cache only the last 3 movements per asset (matches spec section C). The server's
  // /api/state already returns state.movements ordered newest-first (ORDER BY date DESC,
  // id DESC), so grouping by assetId and taking the first 3 encountered per group gives
  // the most recent 3 per asset without needing to sort here ourselves.
  const movementsByAsset = new Map();
  for (const m of state.movements || []) {
    if (!movementsByAsset.has(m.assetId)) movementsByAsset.set(m.assetId, []);
    const list = movementsByAsset.get(m.assetId);
    if (list.length < 3) list.push(m);
  }
  for (const list of movementsByAsset.values()) {
    for (const m of list) {
      txn.push({
        statement: 'INSERT INTO movements (id, type, asset_id, employee_id, department, site, act_number, quantity, date, notes) VALUES (?,?,?,?,?,?,?,?,?,?)',
        values: [m.id, m.type, m.assetId, m.employeeId, m.department, m.site, m.actNumber, m.quantity, m.date, m.notes],
      });
    }
  }
  // Full (uncapped) issue/return log for the global "История" screen — unlike
  // `movements` above, this isn't trimmed to 3-per-asset, since its whole
  // purpose is showing more than the asset card already does.
  for (const m of state.movements || []) {
    if (m.type !== 'issue' && m.type !== 'return') continue;
    txn.push({
      statement: 'INSERT INTO movements_history (id, type, asset_id, asset_name, employee_id, department, site, act_number, quantity, date, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      values: [m.id, m.type, m.assetId, assetNameById.get(m.assetId) || '', m.employeeId, m.department, m.site, m.actNumber, m.quantity, m.date, m.notes],
    });
  }
  // executeTransaction() begins the transaction, runs each task with transaction:false,
  // commits on success, and rolls back + rejects on any failure — equivalent to (and safer
  // than) the manual begin/try/commit/catch/rollback pattern this replaces.
  await db.executeTransaction(txn);
}

async function getAssetById(id) {
  // format.js (getAssetStatus, getAvailableQuantity, holderLabel) expects
  // camelCase fields matching the server's JSON shape — normalize the
  // snake_case SQLite columns here so every consumer downstream of Db can
  // treat "asset" the same way whether it came from the cache or the server.
  const assetResult = await db.query('SELECT * FROM assets WHERE id = ?', [id]);
  if (!assetResult.values.length) return null;
  const row = assetResult.values[0];
  const allocResult = await db.query('SELECT * FROM allocations WHERE asset_id = ?', [id]);
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    inventoryNumber: row.inventory_number,
    serialNumber: row.serial_number,
    status: row.status,
    quantity: row.quantity,
    repairQuantity: row.repair_quantity,
    retiredQuantity: row.retired_quantity,
    location: row.location,
    purchaseDate: row.purchase_date,
    warrantyEnd: row.warranty_end,
    rev: row.rev,
    isShared: Boolean(row.is_shared),
    allocations: allocResult.values.map((alloc) => ({
      employeeId: alloc.employee_id,
      department: alloc.department,
      site: alloc.site,
      quantity: alloc.quantity,
    })),
  };
}

async function listEmployeesById() {
  // format.js's holderLabel() expects {fullName, department, site} (camelCase,
  // matching the server's JSON) — translate from the snake_case SQLite columns here.
  const result = await db.query('SELECT * FROM employees');
  return new Map(result.values.map((row) => [
    row.id,
    { fullName: row.full_name, department: row.department, site: row.site },
  ]));
}

async function listMovementsForAsset(assetId) {
  // format.js's MOVEMENT_LABELS keys on `m.type` (camelCase-free, matches directly);
  // normalize snake_case SQLite columns to the camelCase shape used everywhere else
  // (assetId, employeeId, actNumber), same convention as getAssetById/listEmployeesById.
  const result = await db.query(
    'SELECT * FROM movements WHERE asset_id = ? ORDER BY date DESC, id DESC LIMIT 3',
    [assetId]
  );
  return result.values.map((row) => ({
    id: row.id,
    type: row.type,
    assetId: row.asset_id,
    employeeId: row.employee_id,
    department: row.department,
    site: row.site,
    actNumber: row.act_number,
    quantity: row.quantity,
    date: row.date,
    notes: row.notes,
  }));
}

async function listMovementHistory(limit = 200) {
  const result = await db.query(
    'SELECT * FROM movements_history ORDER BY date DESC, id DESC LIMIT ?',
    [limit]
  );
  return result.values.map((row) => ({
    id: row.id,
    type: row.type,
    assetId: row.asset_id,
    assetName: row.asset_name,
    employeeId: row.employee_id,
    department: row.department,
    site: row.site,
    actNumber: row.act_number,
    quantity: row.quantity,
    date: row.date,
    notes: row.notes,
  }));
}

async function searchAssets(query, limit = 30) {
  // Manual fallback for when scanning isn't possible (no camera, damaged
  // label) — matches by substring against name/inventory/serial, same three
  // fields the printed label itself shows. Empty query intentionally matches
  // everything (LIKE '%%'), so opening the screen with no input yet browses
  // the first `limit` assets alphabetically instead of showing nothing.
  const q = `%${String(query || '').trim()}%`;
  const result = await db.query(
    'SELECT * FROM assets WHERE name LIKE ? OR inventory_number LIKE ? OR serial_number LIKE ? ORDER BY name LIMIT ?',
    [q, q, q, limit]
  );
  const assets = [];
  for (const row of result.values) {
    const allocResult = await db.query('SELECT * FROM allocations WHERE asset_id = ?', [row.id]);
    assets.push({
      id: row.id,
      name: row.name,
      category: row.category,
      inventoryNumber: row.inventory_number,
      serialNumber: row.serial_number,
      status: row.status,
      quantity: row.quantity,
      repairQuantity: row.repair_quantity,
      retiredQuantity: row.retired_quantity,
      isShared: Boolean(row.is_shared),
      allocations: allocResult.values.map((alloc) => ({
        employeeId: alloc.employee_id,
        department: alloc.department,
        site: alloc.site,
        quantity: alloc.quantity,
      })),
    });
  }
  return assets;
}

function generateClientActionId() {
  // RFC-4122-ish v4 UUID, good enough as a dedup key — Capacitor's JS runtime
  // has crypto.randomUUID() on modern Android WebViews; fall back if not.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function enqueueAction(action) {
  const clientActionId = generateClientActionId();
  await db.run(
    'INSERT INTO pending_actions (client_action_id, payload_json, status, created_at) VALUES (?,?,?,?)',
    [clientActionId, JSON.stringify({ ...action, clientActionId }), 'pending', new Date().toISOString()]
  );
  return clientActionId;
}

async function listPendingActions() {
  const result = await db.query("SELECT * FROM pending_actions WHERE status != 'synced' ORDER BY created_at ASC");
  return result.values.map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
}

async function markActionSynced(clientActionId) {
  await db.run("UPDATE pending_actions SET status = 'synced', server_error = NULL WHERE client_action_id = ?", [clientActionId]);
}

async function markActionFailed(clientActionId, error) {
  await db.run("UPDATE pending_actions SET status = 'failed', server_error = ? WHERE client_action_id = ?", [error, clientActionId]);
}

async function retryAction(clientActionId) {
  await db.run("UPDATE pending_actions SET status = 'pending', server_error = NULL WHERE client_action_id = ?", [clientActionId]);
}

async function markActionConflict(clientActionId, currentAsset) {
  await db.run(
    "UPDATE pending_actions SET status = 'conflict', server_error = ? WHERE client_action_id = ?",
    [JSON.stringify(currentAsset), clientActionId]
  );
}

async function retryActionOnTop(clientActionId, newBaseRev) {
  const result = await db.query('SELECT payload_json FROM pending_actions WHERE client_action_id = ?', [clientActionId]);
  if (!result.values.length) return;
  const payload = JSON.parse(result.values[0].payload_json);
  payload.baseRev = newBaseRev;
  await db.run(
    "UPDATE pending_actions SET status = 'pending', server_error = NULL, payload_json = ? WHERE client_action_id = ?",
    [JSON.stringify(payload), clientActionId]
  );
}

async function cancelAction(clientActionId) {
  await db.run('DELETE FROM pending_actions WHERE client_action_id = ?', [clientActionId]);
}

window.Db = { open, replaceState, getAssetById, listEmployeesById, listMovementsForAsset, listMovementHistory, searchAssets, enqueueAction, listPendingActions, markActionSynced, markActionFailed, retryAction, markActionConflict, retryActionOnTop, cancelAction, generateClientActionId };
