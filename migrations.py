from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone
from typing import Callable

import asset_codes
import assignment_codes
import workplace_codes

Migration = tuple[int, str, "Callable[[sqlite3.Connection], None]"]


def _add_column_if_missing(connection: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    existing = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}
    if column not in existing:
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def _migrate_001(c): _add_column_if_missing(c, "assets", "repair_quantity", "repair_quantity INTEGER NOT NULL DEFAULT 0")
def _migrate_002(c): _add_column_if_missing(c, "assets", "retired_quantity", "retired_quantity INTEGER NOT NULL DEFAULT 0")
def _migrate_003(c): _add_column_if_missing(c, "assets", "min_quantity", "min_quantity INTEGER NOT NULL DEFAULT 0")
def _migrate_004(c): _add_column_if_missing(c, "assets", "warranty_end", "warranty_end TEXT NOT NULL DEFAULT ''")
def _migrate_005(c): _add_column_if_missing(c, "assets", "price", "price REAL NOT NULL DEFAULT 0")
def _migrate_006(c): _add_column_if_missing(c, "assets", "repair_date", "repair_date TEXT NOT NULL DEFAULT ''")
def _migrate_007(c): _add_column_if_missing(c, "assets", "location", "location TEXT NOT NULL DEFAULT ''")
def _migrate_008(c): _add_column_if_missing(c, "assets", "photo_url", "photo_url TEXT NOT NULL DEFAULT ''")
def _migrate_009(c): _add_column_if_missing(c, "employees", "phone", "phone TEXT NOT NULL DEFAULT ''")
def _migrate_010(c): _add_column_if_missing(c, "employees", "site", "site TEXT NOT NULL DEFAULT ''")
def _migrate_011(c): _add_column_if_missing(c, "employees", "status", "status TEXT NOT NULL DEFAULT 'active'")
def _migrate_012(c): _add_column_if_missing(c, "movements", "act_number", "act_number INTEGER")
def _migrate_013(c): _add_column_if_missing(c, "movements", "department", "department TEXT NOT NULL DEFAULT ''")
def _migrate_014(c): _add_column_if_missing(c, "movements", "site", "site TEXT NOT NULL DEFAULT ''")


def _migrate_015_asset_allocations_rebuild(connection: sqlite3.Connection) -> None:
    # Check if table exists
    table_check = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='asset_allocations'"
    ).fetchone()
    if table_check is None:
        return

    alloc_info = list(connection.execute("PRAGMA table_info(asset_allocations)"))
    alloc_cols = {row["name"] for row in alloc_info}
    emp_col = next((row for row in alloc_info if row["name"] == "employee_id"), None)
    needs_migration = ("department" not in alloc_cols) or (emp_col is not None and emp_col["notnull"] == 1)
    if not needs_migration:
        return
    # SQLite silently ignores `PRAGMA foreign_keys` while a transaction is open,
    # and by now migrations 1-14 have each INSERTed into schema_version, which
    # makes Python's sqlite3 open an implicit transaction. Without this commit
    # the pragma below is a no-op and the rebuild INSERT runs with FK checks
    # still on — a legacy row pointing at a since-deleted asset then aborts the
    # whole migration, and init_db() (called at startup) fails to start the server.
    connection.commit()
    connection.execute("PRAGMA foreign_keys = OFF")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS asset_allocations_new (
            asset_id TEXT NOT NULL,
            employee_id TEXT,
            department TEXT NOT NULL DEFAULT '',
            quantity INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (asset_id) REFERENCES assets(id)
        );
        """
    )
    select_dept = "department" if "department" in alloc_cols else "''"
    connection.execute(
        f"INSERT INTO asset_allocations_new (asset_id, employee_id, department, quantity) "
        f"SELECT asset_id, employee_id, {select_dept}, quantity FROM asset_allocations"
    )
    connection.execute("DROP TABLE asset_allocations")
    connection.execute("ALTER TABLE asset_allocations_new RENAME TO asset_allocations")
    connection.execute("PRAGMA foreign_keys = ON")


def _migrate_016(connection: sqlite3.Connection) -> None:
    # Check if table exists
    table_check = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='asset_allocations'"
    ).fetchone()
    if table_check is None:
        return
    _add_column_if_missing(connection, "asset_allocations", "site", "site TEXT NOT NULL DEFAULT ''")


def _migrate_017_sites_table(c):
    c.execute("CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, name TEXT NOT NULL)")


def _migrate_018_audit_log_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            action TEXT NOT NULL,
            changes TEXT NOT NULL DEFAULT '{}',
            timestamp TEXT NOT NULL
        )
        """
    )


def _migrate_019_kit_templates_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS kit_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            items TEXT NOT NULL DEFAULT '[]'
        )
        """
    )


def _migrate_020_mobile_action_log_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS mobile_action_log (
            client_action_id TEXT PRIMARY KEY,
            response_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )


def _migrate_021_users_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            iterations INTEGER NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin','storekeeper','viewer')),
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        )
        """
    )


def _migrate_022_sessions_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id),
            device_secret TEXT,
            created_at TEXT NOT NULL,
            last_used_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )
        """
    )


def _migrate_023_pairing_codes_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS pairing_codes (
            code TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id),
            device_secret TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            used_at TEXT
        )
        """
    )


def _migrate_024_audit_log_actor(c):
    _add_column_if_missing(c, "audit_log", "actor", "actor TEXT NOT NULL DEFAULT ''")


def _migrate_025_assets_rev(c):
    _add_column_if_missing(c, "assets", "rev", "rev INTEGER NOT NULL DEFAULT 0")


def _migrate_026_inventory_tables(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS inventory_sessions (
          id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          started_by TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open'
        )
        """
    )
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS inventory_scans (
          session_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          status TEXT NOT NULL,
          found_location TEXT NOT NULL DEFAULT '',
          FOREIGN KEY (session_id) REFERENCES inventory_sessions(id),
          FOREIGN KEY (asset_id) REFERENCES assets(id)
        )
        """
    )


def _migrate_027_label_printed_at(c):
    _add_column_if_missing(c, "assets", "label_printed_at", "label_printed_at TEXT")


_BARE_NUMBER_RE = re.compile(r"^(\d+)$")
_PREFIXED_NUMBER_RE = re.compile(r"^([A-Za-z]+)-(\d+)$")


def _renumber_order_key(row: sqlite3.Row) -> tuple[int, int, str]:
    """Порядок, в котором активы получают новые номера.

    Сначала голая нумерация (001-181) в порядке возрастания, затем уже
    префиксные номера, затем всё остальное. Смысл в том, чтобы 175 единиц
    с привычными номерами сохранили и порядок, и — по возможности — сами
    числа: голый "008" становится MON-0008, а не уезжает в середину
    списка. Префиксные проставлены позже и оказываются в конце.

    Третий элемент ключа — id, чтобы порядок был устойчивым у строк без
    разбираемого номера и результат не зависел от порядка выдачи SQLite.
    """
    raw = (row["inventory_number"] or "").strip()
    bare = _BARE_NUMBER_RE.match(raw)
    if bare:
        return (0, int(bare.group(1)), row["id"])
    prefixed = _PREFIXED_NUMBER_RE.match(raw)
    if prefixed:
        return (1, int(prefixed.group(2)), row["id"])
    return (2, 0, row["id"])


def _migrate_028_asset_code_renumber(connection: sqlite3.Connection) -> None:
    """Сводит инвентарные номера к сквозному виду ПРЕФИКС-NNNN.

    До этой миграции в базе два несовместимых формата: 175 единиц с голой
    нумерацией 001-181 и 28 с буквенным префиксом 0001-0029. Числовые
    части пересекаются — голый "001" и "SVR-0001" это одно и то же число
    у разных единиц, — поэтому просто дописать буквы нельзя, нужна
    сквозная перенумерация.

    Буквы у уже префиксных строк сохраняются как есть, даже когда
    расходятся с правилами справочника: RTR-0007 ("Без категории" /
    "Opical Network Terminal") и UPS-0004 (категория "Периферийные
    устройства") проставлены вручную осознанно. Меняется только число.

    rev растёт у каждой изменённой строки, иначе мобильное приложение с
    закэшированной карточкой не увидит новый номер. state_version растёт
    один раз, чтобы открытый на компьютере интерфейс получил 409 на
    следующем сохранении и перезагрузил данные вместо записи старых
    номеров поверх новых.
    """
    table = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='assets'"
    ).fetchone()
    if table is None:
        return

    # Самая старая форма assets — только id, name, quantity. schema.sql её
    # не чинит (CREATE TABLE IF NOT EXISTS пропускает существующую
    # таблицу), а category/inventory_number не добавляет ни одна миграция:
    # они считались всегда существующими. Нумеровать тогда нечего.
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(assets)")}
    if "inventory_number" not in columns:
        return
    category_column = "category" if "category" in columns else "''"

    rows = list(connection.execute(
        f"SELECT id, name, {category_column} AS category, inventory_number FROM assets"
    ))
    rows.sort(key=_renumber_order_key)

    changed = 0
    for position, row in enumerate(rows, start=1):
        raw = (row["inventory_number"] or "").strip()
        prefixed = _PREFIXED_NUMBER_RE.match(raw)
        prefix = (
            prefixed.group(1).upper()
            if prefixed
            else asset_codes.guess_prefix(row["category"] or "", row["name"] or "")
        )
        new_number = f"{prefix}-{position:04d}"
        if new_number == raw:
            continue
        connection.execute(
            "UPDATE assets SET inventory_number = ?, rev = rev + 1 WHERE id = ?",
            (new_number, row["id"]),
        )
        changed += 1

    # Ни одна строка не поменялась — база уже в нужном виде. Не трогаем
    # state_version, иначе повторный прогон заставил бы десктоп зря
    # перезагружаться.
    if changed == 0:
        return

    # app_meta заводит schema.sql, но run_migrations вызывают и на
    # соединениях, которые его не видели: так мигрируется старая база,
    # заведённая до появления таблицы. Создаём идемпотентно, как это
    # делают миграции 017-023 со своими таблицами.
    connection.execute("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)")
    current = connection.execute(
        "SELECT value FROM app_meta WHERE key = 'state_version'"
    ).fetchone()
    next_version = (int(current["value"]) if current and current["value"] else 0) + 1
    connection.execute(
        "INSERT INTO app_meta (key, value) VALUES ('state_version', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(next_version),),
    )


def _migrate_029_workplaces_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS workplaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          employee_id TEXT REFERENCES employees(id),
          site TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT ''
        )
        """
    )


def _migrate_030_allocation_workplace(connection: sqlite3.Connection) -> None:
    # Таблицы выдач может ещё не быть: её создаёт миграция 015 при
    # переносе старой базы. Проверка та же, что в 015 и 016.
    table = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='asset_allocations'"
    ).fetchone()
    if table is None:
        return
    _add_column_if_missing(
        connection, "asset_allocations", "workplace_id",
        "workplace_id TEXT NOT NULL DEFAULT ''",
    )


def _migrate_031_movement_workplace(c):
    _add_column_if_missing(c, "movements", "workplace_id", "workplace_id TEXT NOT NULL DEFAULT ''")


def _migrate_032_warranty_reminder_off(c):
    # Отказ от гарантии — не то же самое, что её отсутствие. У старых
    # серверов и ИБП дата окончания известна и истекла: стереть её ради
    # тишины в панели «Требует внимания» значило бы соврать в реестре.
    # Поэтому напоминание снимается отдельным флагом, а warranty_end
    # остаётся нетронутым. 0 по умолчанию: никто не отключал напоминания
    # у техники, заведённой до этой миграции.
    _add_column_if_missing(
        c, "assets", "warranty_reminder_off",
        "warranty_reminder_off INTEGER NOT NULL DEFAULT 0",
    )


def _employees_have_department(connection: sqlite3.Connection) -> bool:
    # Совсем старые базы (до появления schema.sql в нынешнем виде) могут не
    # иметь ни таблицы сотрудников, ни колонки отдела в ней. Проверка та же,
    # что в миграциях 015, 016 и 030.
    table = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='employees'"
    ).fetchone()
    if table is None:
        return False
    return "department" in {row["name"] for row in connection.execute("PRAGMA table_info(employees)")}


def _migrate_033_workplaces_department(c):
    _add_column_if_missing(c, "workplaces", "department", "department TEXT NOT NULL DEFAULT ''")
    # Бэкофилл. У рабочих мест, заведённых до этой миграции, отдела нет, а
    # validate_state отклоняет сохранение состояния с пустым отделом. Десктоп
    # шлёт состояние целиком, поэтому одна такая строка блокировала бы вообще
    # любое сохранение после обновления — вплоть до полной невозможности
    # работать. Чиним в самой миграции, а не разово при старте: тогда это же
    # лечится и при восстановлении из бэкапа, где миграции гоняются заново.
    # Сначала пытаемся угадать отдел по хозяину места.
    if _employees_have_department(c):
        c.execute(
            """
            UPDATE workplaces SET department = COALESCE(
                (SELECT TRIM(e.department) FROM employees e
                 WHERE e.id = workplaces.employee_id AND TRIM(e.department) != ''),
                '')
            WHERE TRIM(department) = ''
            """
        )
    # Всё, что угадать не вышло, получает явный литерал: пустого отдела после
    # миграции остаться не должно.
    c.execute("UPDATE workplaces SET department = 'Без отдела' WHERE TRIM(department) = ''")
    # Разводим дубли (название, отдел), которые мог создать бэкофилл:
    # validate_state запрещает одинаковые названия внутри одного отдела, а
    # миграция не имеет права оставить базу в состоянии, которое сервер потом
    # откажется сохранять. Два одноимённых стола, попавших в один отдел (оба
    # ушли в «Без отдела» или у хозяев совпал отдел), надо различить.
    rows = list(c.execute("SELECT id, name, department FROM workplaces ORDER BY name, id"))
    seen: set[tuple[str, str]] = set()
    for row in rows:
        name = row["name"]
        department = row["department"].strip()
        key = (name.strip().lower(), department)
        if key in seen:
            # Суффикс подбираем свободный: рядом уже может лежать стол,
            # который так и называется — «Стол 1 (2)».
            suffix = 2
            while (f"{name} ({suffix})".strip().lower(), department) in seen:
                suffix += 1
            name = f"{name} ({suffix})"
            key = (name.strip().lower(), department)
            c.execute("UPDATE workplaces SET name = ? WHERE id = ?", (name, row["id"]))
        seen.add(key)


def _migrate_034_workplaces_code(connection: sqlite3.Connection) -> None:
    _add_column_if_missing(connection, "workplaces", "code", "code TEXT NOT NULL DEFAULT ''")
    rows = list(connection.execute(
        "SELECT id FROM workplaces WHERE code = '' ORDER BY name, id"
    ))
    if not rows:
        return
    next_num = workplace_codes.next_number(connection)
    for row in rows:
        connection.execute(
            "UPDATE workplaces SET code = ? WHERE id = ?",
            (workplace_codes.assign_code(next_num), row["id"]),
        )
        next_num += 1

def _migrate_035_assignments_tables(connection: sqlite3.Connection) -> None:
    """Слой выдач: операция ASSIGN-NNNN и её позиции.

    До этой миграции текущее состояние (asset_allocations) и история
    (movements) были двумя независимыми списками: состояние знало, за кем
    техника числится, история — когда её выдали, но связать одно с другим
    можно было только угадыванием по совпадению получателя. Отсюда и
    расхождения в боевой базе. Теперь правда одна — assignment_items, а
    asset_allocations становится её проекцией (миграция 036).

    Отдельная таблица позиций, а не колонка в movements: одна операция
    выдачи несёт несколько единиц техники (§5 ТЗ), и возвращают их
    поштучно и вразнобой — returned_quantity живёт у позиции, а не у
    операции.
    """
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS assignments (
          id TEXT PRIMARY KEY,
          -- ASSIGN-NNNN, назначается сервером (assignment_codes.py).
          -- Это номер ОПЕРАЦИИ, а не техники: инвентарный номер живёт в
          -- assets.inventory_number и при выдаче не меняется.
          code TEXT NOT NULL DEFAULT '',
          -- Получатель. Отдел и объект — самостоятельные получатели и
          -- ни с чем не сочетаются. Сотрудник и стол сочетаются между
          -- собой: выдача бывает на человека, на человека и его стол,
          -- и на один только стол — последнее нужно, когда сотрудник
          -- ушёл, а техника осталась на месте (§15 ТЗ). Проверяется в
          -- validate_state.
          employee_id TEXT,
          workplace_id TEXT NOT NULL DEFAULT '',
          department TEXT NOT NULL DEFAULT '',
          site TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          issued_at TEXT NOT NULL,
          returned_at TEXT,
          -- Номер акта остаётся: по нему печатаются существующие акты,
          -- и старые движения ссылаются именно на него.
          act_number INTEGER,
          notes TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS assignment_items (
          id TEXT PRIMARY KEY,
          assignment_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          quantity INTEGER NOT NULL DEFAULT 1,
          -- Возврат не удаляет строку, а наращивает это число (§12 ТЗ):
          -- позиция закрыта, когда returned_quantity = quantity.
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
        """
    )
    _add_column_if_missing(
        connection, "movements", "assignment_id",
        "assignment_id TEXT NOT NULL DEFAULT ''",
    )
    # employee_id есть в schema.sql, но не во всех живых базах: в самых
    # старых движение хранило только технику, а получателя не хранило
    # вовсе, и ни одна прежняя миграция колонку не добавляла. Бэкофилл
    # 036 читает её у каждого движения — без этой строки он падает на
    # такой базе, и приложение не стартует.
    _add_column_if_missing(connection, "movements", "employee_id", "employee_id TEXT")


class MigrationDataError(RuntimeError):
    """Данные, которые нельзя перенести без потерь.

    Поднимается из миграции до того, как run_migrations успеет
    закоммитить: транзакция откатывается, база остаётся на прежней
    версии схемы, и приложение продолжает работать по-старому. Это
    лучше, чем стартовать на схеме, где часть техники потерялась.
    """


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    return connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is not None


_MOVEMENT_ID_RE = re.compile(r"^mov_(\d+)_")


def _movement_sort_value(movement_id: str, date: str) -> int:
    """Момент движения в миллисекундах — для порядка, не для показа.

    Тот же приём, что у AssetOps.movementSortValue в asset_ops.js, и по
    той же причине: у выдачи «Выдать сразу» дата пустая (технику часто
    заводят задним числом), а момент создания записи зашит в её id вида
    ``mov_<timestamp>_<rand>``. Без этого запаса все недатированные
    выдачи сортируются как самые ранние и слипаются в начало нумерации.
    """
    if date:
        try:
            parsed = datetime.strptime(date[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
            return int(parsed.timestamp() * 1000)
        except ValueError:
            pass
    match = _MOVEMENT_ID_RE.match(str(movement_id or ""))
    return int(match.group(1)) if match else 0


def _recipient_key(row) -> tuple[str, str, str, str]:
    """Получатель выдачи — четвёрка, по которой сходятся движение и состояние.

    Нормализуется до одного получателя: старый мобильный клиент писал
    выдачу с сотрудником И объектом, а выдачу с двумя хозяевами
    отвергает серверная валидация — первое же сохранение с десктопа
    после обновления упало бы. Побеждает сотрудник, как и при поиске
    записи в find_employee_allocation. Правило совпадает с
    normalize_recipient в assignment_store.py; здесь оно продублировано
    намеренно — миграция не должна зависеть от кода, который будет
    меняться после неё.
    """
    employee_id = row["employee_id"] or ""
    department = row["department"] or ""
    site = row["site"] or ""
    workplace_id = row["workplace_id"] or ""
    if employee_id:
        return (employee_id, "", "", "")
    if department:
        return ("", department, "", "")
    if site:
        return ("", "", site, "")
    return ("", "", "", workplace_id)


_RECOVERED_NOTE = "Восстановлено при миграции: исходная операция выдачи неизвестна."


def _migrate_036_assignments_backfill(connection: sqlite3.Connection) -> None:
    """Собирает выдачи ASSIGN-NNNN из движений и текущего состояния.

    Источников два, и они не равны в правах. Движения (`movements`)
    рассказывают, что когда-то произошло; состояние
    (`asset_allocations`) говорит, как дела обстоят сейчас. Расходятся
    они регулярно — правки задним числом, ручной импорт, возвраты без
    движения. Поэтому **состояние главнее**: сколько единиц числится за
    получателем сейчас, столько и останется активными; остаток истории
    закрывается как возвращённый, начиная со старых выдач.

    Обратный случай — за получателем числится техника, которой не
    объясняет ни одно движение — встречается в старых базах и в
    восстановленных бэкапах. Уронить на нём миграцию нельзя: приложение
    просто не стартует. Выбросить строку тоже нельзя: это потеря
    техники, ровно то, что §22 запрещает. Поэтому недостача
    восстанавливается отдельной выдачей с пустой датой и пометкой
    _RECOVERED_NOTE — правдоподобную дату не выдумываем.

    MigrationDataError остаётся только на последнюю проверку: если
    итоговая проекция не сошлась с исходным состоянием, значит, ошибка в
    самой миграции, и коммитить такое нельзя.
    """
    if not _table_exists(connection, "assignments"):
        return
    if not _table_exists(connection, "asset_allocations") or not _table_exists(connection, "movements"):
        return
    if connection.execute("SELECT COUNT(*) FROM assignments").fetchone()[0]:
        return

    issues = list(connection.execute(
        "SELECT id, asset_id, employee_id, department, site, workplace_id, "
        "act_number, quantity, date FROM movements WHERE type = 'issue' "
        "ORDER BY date, act_number, id"
    ))
    allocations = list(connection.execute(
        "SELECT asset_id, employee_id, department, site, workplace_id, quantity "
        "FROM asset_allocations WHERE quantity > 0"
    ))
    if not issues and not allocations:
        return

    # ── Группировка движений в операции ───────────────────────────
    # Ключ — номер акта ВМЕСТЕ с получателем, а не один номер: акт мог
    # быть проставлен двум разным людям (ручная правка, старый импорт),
    # и слить их в одну выдачу значило бы приписать технику чужому.
    groups: dict[tuple, dict] = {}
    for row in issues:
        recipient = _recipient_key(row)
        key = (row["act_number"] or 0,) + recipient
        group = groups.get(key)
        if group is None:
            group = groups[key] = {
                "date": "",
                "sort": None,
                "act_number": row["act_number"],
                "recipient": recipient,
                "movements": [],
                "quantities": {},
                "notes": "",
            }
        group["movements"].append(row["id"])
        # issued_at — самая ранняя НАСТОЯЩАЯ дата акта: если часть
        # движений датирована, а часть нет, пустая строка не должна
        # вытеснить известную дату.
        date = row["date"] or ""
        if date and (not group["date"] or date < group["date"]):
            group["date"] = date
        sort_value = _movement_sort_value(row["id"], date)
        if group["sort"] is None or sort_value < group["sort"]:
            group["sort"] = sort_value
        asset_id = row["asset_id"]
        group["quantities"][asset_id] = (
            group["quantities"].get(asset_id, 0) + max(1, int(row["quantity"] or 1))
        )

    ordered = sorted(groups.values(), key=lambda g: (g["sort"] or 0, g["act_number"] or 0))
    items: list[dict] = []

    def add_items(group: dict, sequence_id: str) -> None:
        employee_id, _department, _site, workplace_id = group["recipient"]
        # Выдача на стол без человека — техника закреплена за местом и
        # переживает смену сотрудника; всё остальное личное.
        scope = "workplace" if workplace_id and not employee_id else "personal"
        for index, (asset_id, quantity) in enumerate(sorted(group["quantities"].items()), start=1):
            items.append({
                "id": f"asgi_{sequence_id}_{index:03d}",
                "assignment_id": group["id"],
                "asset_id": asset_id,
                "quantity": quantity,
                "returned_quantity": 0,
                "returned_at": None,
                "scope": scope,
                "group": group,
            })

    for sequence, group in enumerate(ordered, start=1):
        group["id"] = f"asg_mig_{sequence:05d}"
        add_items(group, f"mig_{sequence:05d}")

    # ── Сверка с текущим состоянием ───────────────────────────────
    outstanding: dict[tuple, int] = {}
    for row in allocations:
        key = (row["asset_id"],) + _recipient_key(row)
        outstanding[key] = outstanding.get(key, 0) + int(row["quantity"] or 0)

    returns: dict[tuple, list[str]] = {}
    for row in connection.execute(
        "SELECT asset_id, employee_id, department, site, workplace_id, date "
        "FROM movements WHERE type = 'return' ORDER BY date"
    ):
        returns.setdefault((row["asset_id"],) + _recipient_key(row), []).append(row["date"] or "")

    items_by_key: dict[tuple, list[dict]] = {}
    for item in items:
        items_by_key.setdefault((item["asset_id"],) + item["group"]["recipient"], []).append(item)

    # Получатель -> {техника: сколько не объяснено движениями}.
    recovered: dict[tuple, dict[str, int]] = {}

    def recover(key: tuple, quantity: int) -> None:
        asset_id, recipient = key[0], key[1:]
        bucket = recovered.setdefault(recipient, {})
        bucket[asset_id] = bucket.get(asset_id, 0) + quantity

    for key, bucket in items_by_key.items():
        # Свежие выдачи остаются активными, старые закрываются: если
        # ноутбук выдавали дважды, «на руках» он по свежему акту (§14).
        bucket.sort(key=lambda i: (i["group"]["sort"] or 0, i["group"]["act_number"] or 0), reverse=True)
        remaining = outstanding.pop(key, 0)
        last_return = returns.get(key, [""])[-1] or None
        for item in bucket:
            active = min(remaining, item["quantity"])
            item["returned_quantity"] = item["quantity"] - active
            remaining -= active
            if item["returned_quantity"] >= item["quantity"]:
                item["returned_at"] = last_return
        if remaining > 0:
            recover(key, remaining)

    for key, quantity in outstanding.items():
        recover(key, quantity)

    # Восстановленные выдачи идут в конец нумерации: даты у них нет, и
    # место в хронологии определить нечем.
    for sequence, (recipient, quantities) in enumerate(sorted(recovered.items(), key=str), start=1):
        group = {
            "id": f"asg_rec_{sequence:05d}",
            "date": "",
            "sort": None,
            "act_number": None,
            "recipient": recipient,
            "movements": [],
            "quantities": quantities,
            "notes": _RECOVERED_NOTE,
        }
        ordered.append(group)
        add_items(group, f"rec_{sequence:05d}")

    next_number = assignment_codes.next_number(connection)
    for group in ordered:
        group["code"] = assignment_codes.assign_code(next_number)
        next_number += 1

    # ── Запись ────────────────────────────────────────────────────
    items_by_assignment: dict[str, list[dict]] = {}
    for item in items:
        items_by_assignment.setdefault(item["assignment_id"], []).append(item)

    for group in ordered:
        bucket = items_by_assignment.get(group["id"], [])
        closed = bool(bucket) and all(
            item["returned_quantity"] >= item["quantity"] for item in bucket
        )
        returned_dates = [item["returned_at"] for item in bucket if item["returned_at"]]
        employee_id, department, site, workplace_id = group["recipient"]
        connection.execute(
            "INSERT INTO assignments (id, code, employee_id, workplace_id, department, "
            "site, status, issued_at, returned_at, act_number, notes, created_by) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')",
            (
                group["id"], group["code"], employee_id or None, workplace_id,
                department, site,
                "returned" if closed else "active",
                group["date"],
                max(returned_dates) if (closed and returned_dates) else None,
                group["act_number"],
                group["notes"],
            ),
        )
        for movement_id in group["movements"]:
            connection.execute(
                "UPDATE movements SET assignment_id = ? WHERE id = ?",
                (group["id"], movement_id),
            )

    for item in items:
        connection.execute(
            "INSERT INTO assignment_items (id, assignment_id, asset_id, quantity, "
            "returned_quantity, scope, returned_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                item["id"], item["assignment_id"], item["asset_id"], item["quantity"],
                item["returned_quantity"], item["scope"], item["returned_at"],
            ),
        )

    # ── Проверка §22: проекция обязана совпасть с исходным состоянием ──
    projected: dict[tuple, int] = {}
    for row in connection.execute(
        "SELECT ai.asset_id, a.employee_id, a.department, a.site, a.workplace_id, "
        "SUM(ai.quantity - ai.returned_quantity) AS quantity "
        "FROM assignment_items ai JOIN assignments a ON a.id = ai.assignment_id "
        "WHERE ai.quantity > ai.returned_quantity "
        "GROUP BY ai.asset_id, a.employee_id, a.department, a.site, a.workplace_id"
    ):
        projected[(row["asset_id"],) + _recipient_key(row)] = int(row["quantity"])

    original: dict[tuple, int] = {}
    for row in allocations:
        key = (row["asset_id"],) + _recipient_key(row)
        original[key] = original.get(key, 0) + int(row["quantity"] or 0)

    if projected != original:
        raise MigrationDataError(
            "Проекция выдач не совпала с asset_allocations: "
            f"было {sorted(original.items(), key=str)}, стало {sorted(projected.items(), key=str)}"
        )

    # Проекция сошлась с исходным состоянием с точностью до нормализации
    # получателя — переписываем asset_allocations по ней. Для обычных
    # строк ничего не меняется; строка «сотрудник + объект» становится
    # строкой сотрудника, и база сразу согласована с выдачами, а не
    # только после первого сохранения с десктопа.
    connection.execute("DELETE FROM asset_allocations")
    for (asset_id, employee_id, department, site, workplace_id), quantity in sorted(projected.items(), key=str):
        connection.execute(
            "INSERT INTO asset_allocations (asset_id, employee_id, department, site, "
            "workplace_id, quantity) VALUES (?, ?, ?, ?, ?, ?)",
            (asset_id, employee_id or None, department, site, workplace_id, quantity),
        )


def _migrate_037_acts_table(c):
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS acts (
          act_number INTEGER PRIMARY KEY,
          kind TEXT NOT NULL,
          employee_id TEXT,
          date TEXT NOT NULL,
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT ''
        )
        """
    )


MIGRATIONS: list[Migration] = [
    (1, "assets.repair_quantity", _migrate_001),
    (2, "assets.retired_quantity", _migrate_002),
    (3, "assets.min_quantity", _migrate_003),
    (4, "assets.warranty_end", _migrate_004),
    (5, "assets.price", _migrate_005),
    (6, "assets.repair_date", _migrate_006),
    (7, "assets.location", _migrate_007),
    (8, "assets.photo_url", _migrate_008),
    (9, "employees.phone", _migrate_009),
    (10, "employees.site", _migrate_010),
    (11, "employees.status", _migrate_011),
    (12, "movements.act_number", _migrate_012),
    (13, "movements.department", _migrate_013),
    (14, "movements.site", _migrate_014),
    (15, "asset_allocations rebuild (department, nullable employee_id)", _migrate_015_asset_allocations_rebuild),
    (16, "asset_allocations.site", _migrate_016),
    (17, "sites table", _migrate_017_sites_table),
    (18, "audit_log table", _migrate_018_audit_log_table),
    (19, "kit_templates table", _migrate_019_kit_templates_table),
    (20, "mobile_action_log table", _migrate_020_mobile_action_log_table),
    (21, "users table", _migrate_021_users_table),
    (22, "sessions table", _migrate_022_sessions_table),
    (23, "pairing_codes table", _migrate_023_pairing_codes_table),
    (24, "audit_log.actor", _migrate_024_audit_log_actor),
    (25, "assets.rev", _migrate_025_assets_rev),
    (26, "inventory_sessions + inventory_scans tables", _migrate_026_inventory_tables),
    (27, "assets.label_printed_at", _migrate_027_label_printed_at),
    (28, "assets.inventory_number: сквозная нумерация ПРЕФИКС-NNNN", _migrate_028_asset_code_renumber),
    (29, "workplaces table", _migrate_029_workplaces_table),
    (30, "asset_allocations.workplace_id", _migrate_030_allocation_workplace),
    (31, "movements.workplace_id", _migrate_031_movement_workplace),
    (32, "assets.warranty_reminder_off", _migrate_032_warranty_reminder_off),
    (33, "workplaces.department", _migrate_033_workplaces_department),
    (34, "workplaces.code: бэкофилл WP-NNNN", _migrate_034_workplaces_code),
    (35, "assignments + assignment_items", _migrate_035_assignments_tables),
    (36, "assignments: бэкофилл ASSIGN-NNNN из движений", _migrate_036_assignments_backfill),
    (37, "acts table: reservation ledger for manual/employee-snapshot act numbers", _migrate_037_acts_table),
]


def current_version(connection: sqlite3.Connection) -> int:
    connection.execute(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    row = connection.execute("SELECT MAX(version) AS v FROM schema_version").fetchone()
    return row["v"] or 0


def pending_migrations(connection: sqlite3.Connection) -> list[Migration]:
    applied = current_version(connection)
    return [m for m in MIGRATIONS if m[0] > applied]


def run_migrations(connection: sqlite3.Connection) -> list[int]:
    applied_versions: list[int] = []
    for version, _name, func in pending_migrations(connection):
        func(connection)
        connection.execute(
            "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
            (version, datetime.now(timezone.utc).isoformat()),
        )
        applied_versions.append(version)
    connection.commit()
    return applied_versions
