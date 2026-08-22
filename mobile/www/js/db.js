const { CapacitorSQLite, SQLiteConnection } = window.CapacitorSQLitePlugin
  ? { CapacitorSQLite: window.CapacitorSQLitePlugin, SQLiteConnection: window.SQLiteConnection }
  : Capacitor.Plugins.CapacitorSQLite
    ? { CapacitorSQLite: Capacitor.Plugins.CapacitorSQLite, SQLiteConnection: window.SQLiteConnection }
    : (() => { throw new Error('@capacitor-community/sqlite plugin not found — did npx cap sync run?'); })();

const sqliteConnection = new SQLiteConnection(CapacitorSQLite);
const DB_NAME = 'warehouse_cache';
let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT, inventory_number TEXT,
  serial_number TEXT, status TEXT, quantity INTEGER, repair_quantity INTEGER,
  retired_quantity INTEGER, location TEXT, purchase_date TEXT, warranty_end TEXT
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
`;

async function open() {
  db = await sqliteConnection.createConnection(DB_NAME, false, 'no-encryption', 1, false);
  await db.open();
  await db.execute(SCHEMA);
}

async function replaceState(state) {
  await db.execute('BEGIN TRANSACTION');
  try {
    await db.execute('DELETE FROM assets; DELETE FROM employees; DELETE FROM departments; DELETE FROM sites; DELETE FROM allocations;');
    for (const a of state.assets) {
      await db.run(
        `INSERT INTO assets (id, name, category, inventory_number, serial_number, status, quantity,
         repair_quantity, retired_quantity, location, purchase_date, warranty_end)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [a.id, a.name, a.category, a.inventoryNumber, a.serialNumber, a.status, a.quantity,
         a.repairQuantity, a.retiredQuantity, a.location, a.purchaseDate, a.warrantyEnd]
      );
      for (const alloc of a.allocations || []) {
        await db.run(
          'INSERT INTO allocations (asset_id, employee_id, department, site, quantity) VALUES (?,?,?,?,?)',
          [a.id, alloc.employeeId, alloc.department, alloc.site, alloc.quantity]
        );
      }
    }
    for (const e of state.employees) {
      await db.run('INSERT INTO employees (id, full_name, department, site) VALUES (?,?,?,?)',
        [e.id, e.fullName, e.department, e.site]);
    }
    for (const d of state.departments) {
      await db.run('INSERT INTO departments (id, name) VALUES (?,?)', [d.id, d.name]);
    }
    for (const s of state.sites) {
      await db.run('INSERT INTO sites (id, name) VALUES (?,?)', [s.id, s.name]);
    }
    await db.execute('COMMIT');
  } catch (err) {
    await db.execute('ROLLBACK');
    throw err;
  }
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

window.Db = { open, replaceState, getAssetById, listEmployeesById, enqueueAction, listPendingActions, markActionSynced, markActionFailed, generateClientActionId };
