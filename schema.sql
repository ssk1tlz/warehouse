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
  -- Напоминание о гарантии снято вручную (кнопка «Гарантия» →
  -- «Не напоминать»): дата остаётся настоящей, но в панель «Требует
  -- внимания» техника больше не попадает. См. миграцию 032.
  warranty_reminder_off INTEGER NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  repair_date TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  label_printed_at TEXT,
  rev INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS asset_allocations (
  asset_id TEXT NOT NULL,
  employee_id TEXT,
  department TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  workplace_id TEXT NOT NULL DEFAULT '',
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
  workplace_id TEXT NOT NULL DEFAULT '',
  act_number INTEGER,
  quantity INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  notes TEXT,
  -- Операция выдачи, к которой относится движение (миграция 035).
  -- Пустая строка у движений, не связанных с выдачей: покупка, правка.
  assignment_id TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS inventory_sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  started_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS inventory_scans (
  session_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  status TEXT NOT NULL,
  found_location TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (session_id) REFERENCES inventory_sessions(id),
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);

CREATE TABLE IF NOT EXISTS workplaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  employee_id TEXT REFERENCES employees(id),
  site TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  -- Собственный отдел рабочего места (не department сотрудника — он
  -- может временно сидеть на месте другого подразделения). Текст, а не
  -- FK на departments.id — как employees.department. См. миграцию 033.
  department TEXT NOT NULL DEFAULT '',
  -- Внутренний идентификатор вида WP-0001, назначается сервером
  -- (workplace_codes.py), клиент не редактирует. См. миграцию 034.
  code TEXT NOT NULL DEFAULT ''
);

-- Операция выдачи: связывает получателя, дату и несколько единиц
-- техники одним номером ASSIGN-NNNN (миграция 035). Единственный
-- источник правды о том, у кого что находится; asset_allocations —
-- её проекция, а не самостоятельное хранилище.
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  -- ASSIGN-NNNN, назначается сервером (assignment_codes.py). Это номер
  -- ОПЕРАЦИИ, а не техники: инвентарный номер живёт в
  -- assets.inventory_number и при выдаче не меняется.
  code TEXT NOT NULL DEFAULT '',
  -- Получатель. Отдел и объект — самостоятельные получатели и ни с чем
  -- не сочетаются. Сотрудник и стол сочетаются между собой: выдача
  -- бывает на человека, на человека и его стол, и на один только стол —
  -- последнее нужно, когда сотрудник ушёл, а техника осталась на месте.
  employee_id TEXT,
  workplace_id TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  issued_at TEXT NOT NULL,
  returned_at TEXT,
  -- Номер акта остаётся: по нему печатаются существующие акты.
  act_number INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS assignment_items (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  -- Возврат не удаляет строку, а наращивает это число: позиция закрыта,
  -- когда returned_quantity = quantity. Так история переживает возврат.
  returned_quantity INTEGER NOT NULL DEFAULT 0,
  -- personal — едет с человеком при пересадке;
  -- workplace — остаётся столу при смене сотрудника.
  scope TEXT NOT NULL DEFAULT 'personal',
  returned_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_assignment_items_assignment
  ON assignment_items (assignment_id);
CREATE INDEX IF NOT EXISTS idx_assignment_items_asset
  ON assignment_items (asset_id);
CREATE INDEX IF NOT EXISTS idx_assignments_employee
  ON assignments (employee_id);
CREATE INDEX IF NOT EXISTS idx_assignments_workplace
  ON assignments (workplace_id);
