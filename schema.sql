-- Актуальная схема warehouse.db.
-- Сгенерировано из живой базы 2026-08-21 (sqlite_master + миграции из server.py).
-- Держите этот файл в синхроне: при добавлении ALTER TABLE в server.py дублируйте изменение сюда.

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  department TEXT,
  position TEXT,
  email TEXT,
  phone TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  inventory_number TEXT,
  serial_number TEXT,
  purchase_date TEXT,
  status TEXT NOT NULL DEFAULT 'in_stock',
  notes TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  repair_quantity INTEGER NOT NULL DEFAULT 0,
  retired_quantity INTEGER NOT NULL DEFAULT 0,
  min_quantity INTEGER NOT NULL DEFAULT 0,
  warranty_end TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  repair_date TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS asset_allocations (
  asset_id TEXT NOT NULL,
  employee_id TEXT,
  department TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);

CREATE TABLE IF NOT EXISTS movements (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  employee_id TEXT,
  department TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  act_number INTEGER,
  quantity INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  notes TEXT,
  FOREIGN KEY (asset_id) REFERENCES assets(id),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL DEFAULT '',
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kit_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS mobile_action_log (
  client_action_id TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','storekeeper','viewer')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_secret TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
