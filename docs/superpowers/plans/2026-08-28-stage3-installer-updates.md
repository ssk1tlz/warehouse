# Этап 3: установщик, подпись сборок и обновления — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Данные отделены от программы (`%ProgramData%\Warehouse`), Windows-установщик на Inno Setup, подписанный release-APK с единой версией продукта, и опциональное уведомление о новой версии через публичные GitHub Releases.

**Architecture:** Два новых Python-модуля — `paths.py` (единственный источник путей к данным и к поставляемым ресурсам) и `updates.py` (проверка GitHub Releases, изолирована от `server.py`, который уже 1100+ строк). Единая версия продукта живёт в файле `VERSION`; `bump_version.py` генерирует из неё три синхронных файла (`mobile/www/js/version.js`, `mobile/android/version.properties`), которые коммитятся. Установщик и Gradle читают эти сгенерированные файлы, не вычисляя версию сами.

**Tech Stack:** Python stdlib (`urllib.request`, `logging.handlers`, `shutil`, `pathlib`), pytest; Inno Setup 6; Gradle/Groovy; ванильный JS, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-28-stage3-installer-updates-design.md`

## Global Constraints

- Проект полностью бесплатный: никаких платных библиотек, подписок, облачных API. Python — только stdlib. Разрешённые внешние инструменты: Inno Setup (бесплатный), GitHub Releases, `keytool` из JDK.
- Язык интерфейса, сообщений об ошибках и пользовательской документации — русский. Стиль кода — как в существующих файлах.
- Работа приложения полностью офлайн не ломается ни в одной задаче. Проверка обновлений — строго опциональна, любая сетевая ошибка тиха и безвредна, никакой телеметрии.
- Не трогать складскую логику (выдача/возврат/ремонт/списание, конфликты, миграции схемы БД, роли/токены/HMAC из Этапов 1-2).
- Репозиторий обновлений: `ssk1tlz/warehouse`, публичный, запросы к GitHub API **без токена**.
- `AppId` установщика `{{FD91C08C-6D2F-45E6-A98B-F77C8CDDE02F}}` фиксирован навсегда — не перегенерировать ни в этом плане, ни в будущих релизах (Inno Setup по нему находит предыдущую установку).
- Версия продукта одна на десктоп и мобильное. `VERSION` — единственный редактируемый источник; `mobile/www/js/version.js` и `mobile/android/version.properties` — **сгенерированные, но коммитятся** и всегда должны быть в синхроне с `VERSION`.
- Формула `versionCode = major*10000 + minor*100 + patch` вычисляется **только** в `bump_version.py` (Python), Gradle её не дублирует — читает готовое число.
- Все ссылки вида `file.py:123` указывают на номера строк ДО начала этого плана — реальные номера сдвинутся. Искать по показанному фрагменту кода/имени функции.
- Коммит по завершении каждой отдельно нумерованной задачи.
- После каждой задачи: `python -m pytest -q` и `node --test mobile/tests/*.test.js`.

### Отклонение от спеки (зафиксировано до начала реализации)

Спека помещала логику проверки обновлений в `server.py`. План выносит её в
новый модуль `updates.py`: `server.py` уже 1100+ строк, а логика проверки
(парсинг версий, HTTP к GitHub, кэш, интервал) самодостаточна и тестируется
изолированно. `server.py` получает только вызовы. Это то самое «включить
целевое улучшение в код, который правишь», а не расширение объёма.

### Открытие, которого не было в спеке: ресурсы в собранном EXE

`WarehouseApp_New.spec` собирает **onefile**-EXE (`EXE(pyz, a.scripts,
a.binaries, a.datas, ...)`, без `COLLECT`). PyInstaller в этом режиме
распаковывает всё из `datas` во временную папку и кладёт её путь в
`sys._MEIPASS` — **рядом с .exe этих файлов нет**. При этом `server.py`
ищет `schema.sql` и статику как `ROOT / ...`, где `ROOT` для frozen-сборки
= папка с .exe, и `sys._MEIPASS` не используется нигде в проекте
(проверено `grep`).

Сейчас это не проявляется только потому, что .exe лежит в `D:\warehouse`
рядом с настоящими исходниками. **Установка в `Program Files` сломала бы
приложение полностью**: `init_db()` не нашёл бы `schema.sql`, вся статика
отдавала бы 404. Задача A1 это чинит (`RESOURCE_DIR`), иначе Задача B
бессмысленна.

---

## Задача A — разделение программы и данных

### Task A1: `paths.py` — пути к данным и к поставляемым ресурсам

**Files:**
- Create: `paths.py`
- Test: `tests/test_paths.py` (создать)

**Interfaces:**
- Produces: `paths.DATA_DIR`, `paths.DB_PATH`, `paths.BACKUP_DIR`, `paths.CONFIG_PATH`, `paths.LOG_DIR`, `paths.UPDATE_CACHE_PATH`, `paths.RESOURCE_DIR`, `paths.SCHEMA_PATH` (все — `pathlib.Path`); `paths.data_dir() -> Path`, `paths.resource_dir() -> Path` (функции, из которых вычисляются константы — тестируются напрямую). Потребляются задачами A2, A3, A4, D1, D2, D3.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_paths.py`:

```python
import sys
from pathlib import Path

import paths


def test_data_dir_lives_under_program_data(monkeypatch):
    monkeypatch.setenv("ProgramData", r"C:\TestProgramData")
    assert paths.data_dir() == Path(r"C:\TestProgramData") / "Warehouse"


def test_data_dir_falls_back_when_env_var_missing(monkeypatch):
    monkeypatch.delenv("ProgramData", raising=False)
    assert paths.data_dir() == Path(r"C:\ProgramData") / "Warehouse"


def test_resource_dir_uses_meipass_when_frozen(monkeypatch, tmp_path):
    # PyInstaller onefile: ресурсы распакованы во временную папку, а НЕ
    # лежат рядом с .exe. Без этой ветки установленная в Program Files
    # программа не найдёт ни schema.sql, ни index.html.
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    assert paths.resource_dir() == tmp_path


def test_resource_dir_is_the_source_directory_when_not_frozen(monkeypatch):
    monkeypatch.delattr(sys, "_MEIPASS", raising=False)
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    assert paths.resource_dir() == Path(paths.__file__).resolve().parent


def test_all_data_paths_live_inside_the_data_dir():
    for path in (paths.DB_PATH, paths.BACKUP_DIR, paths.CONFIG_PATH,
                 paths.LOG_DIR, paths.UPDATE_CACHE_PATH):
        assert paths.DATA_DIR in path.parents


def test_schema_is_a_resource_not_data():
    # schema.sql поставляется с программой и не должен оказаться в DATA_DIR
    assert paths.SCHEMA_PATH.parent == paths.RESOURCE_DIR
    assert paths.DATA_DIR not in paths.SCHEMA_PATH.parents
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_paths.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'paths'`.

- [ ] **Step 3: Implement**

Create `paths.py`:

```python
"""Единственное место, где вычисляются пути приложения.

Данные (база, бэкапы, конфиг, логи) живут в %ProgramData%\\Warehouse —
отдельно от программы, которая ставится в Program Files и при обновлении
перезаписывается целиком. Ресурсы (schema.sql, index.html, app.js...)
поставляются вместе с программой и доступны только на чтение.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def data_dir() -> Path:
    """Папка с изменяемыми данными пользователя.

    %ProgramData%, а не %APPDATA%: сервер обслуживает LAN независимо от
    того, какой пользователь Windows сейчас залогинен, и данные не должны
    уезжать вместе с роуминг-профилем.
    """
    base = os.environ.get("ProgramData") or r"C:\ProgramData"
    return Path(base) / "Warehouse"


def resource_dir() -> Path:
    """Папка с файлами, поставляемыми вместе с программой (только чтение).

    PyInstaller в режиме onefile распаковывает datas во временную папку и
    кладёт её путь в sys._MEIPASS — рядом с самим .exe этих файлов НЕТ.
    Без этой ветки установленная в Program Files программа не найдёт ни
    schema.sql, ни index.html: раньше это не проявлялось только потому,
    что .exe лежал в папке с исходниками.
    """
    bundled = getattr(sys, "_MEIPASS", None)
    if bundled:
        return Path(bundled)
    return Path(__file__).resolve().parent


DATA_DIR = data_dir()
DB_PATH = DATA_DIR / "warehouse.db"
BACKUP_DIR = DATA_DIR / "backups"
CONFIG_PATH = DATA_DIR / "config.json"
LOG_DIR = DATA_DIR / "logs"
UPDATE_CACHE_PATH = DATA_DIR / "update_check.json"

RESOURCE_DIR = resource_dir()
SCHEMA_PATH = RESOURCE_DIR / "schema.sql"
VERSION_PATH = RESOURCE_DIR / "VERSION"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_paths.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add paths.py tests/test_paths.py
git commit -m "Task A1: add paths.py with ProgramData data dir and _MEIPASS-aware resource dir"
```

---

### Task A2: `paths.migrate_legacy_data()` — переезд данных из папки рядом с EXE

**Files:**
- Modify: `paths.py`
- Test: `tests/test_paths.py`

**Interfaces:**
- Consumes: `paths.DB_PATH`, `paths.DATA_DIR`, `paths.BACKUP_DIR`, `paths.CONFIG_PATH` (Task A1).
- Produces: `paths.legacy_root() -> Path`; `paths.migrate_legacy_data(copy_database) -> bool`. `copy_database` — **обязательный** параметр вида `(source: Path, dest: Path) -> None`; вызывающий передаёт `server._copy_database` (WAL-safe копия через `Connection.backup()`, добавлена в Этапе 2). Возвращает `True`, если миграция реально выполнялась.

**Почему `copy_database` — параметр, а не импорт:** `paths.py` не должен зависеть от `server.py` (тот сам импортирует `paths`) — иначе循環ный импорт. Плюс это делает функцию тестируемой без поднятия сервера.

**Почему нельзя `shutil.copy2` для базы:** Этап 1 включил WAL — рядом со старой базой может лежать `warehouse.db-wal` с закоммиченными, но ещё не влитыми в основной файл данными. Обычное копирование их потеряет. Это ровно тот класс ошибки, который финальное ревью Этапа 2 нашло как Critical 1.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_paths.py`:

```python
import shutil
import sqlite3

import pytest

import server


@pytest.fixture
def legacy_layout(tmp_path, monkeypatch):
    """Старое расположение (рядом с EXE) и новое (DATA_DIR), оба в tmp."""
    old_root = tmp_path / "old"
    old_root.mkdir()
    new_data = tmp_path / "new"
    monkeypatch.setattr(paths, "legacy_root", lambda: old_root)
    monkeypatch.setattr(paths, "DATA_DIR", new_data)
    monkeypatch.setattr(paths, "DB_PATH", new_data / "warehouse.db")
    monkeypatch.setattr(paths, "BACKUP_DIR", new_data / "backups")
    monkeypatch.setattr(paths, "CONFIG_PATH", new_data / "config.json")
    return old_root, new_data


def _make_db(path, name):
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE marker (name TEXT)")
    connection.execute("INSERT INTO marker VALUES (?)", (name,))
    connection.commit()
    connection.close()


def test_migration_is_a_noop_when_there_is_nothing_to_migrate(legacy_layout):
    old_root, new_data = legacy_layout
    assert paths.migrate_legacy_data(server._copy_database) is False
    assert not new_data.exists()


def test_migration_is_a_noop_when_data_dir_already_has_a_database(legacy_layout):
    old_root, new_data = legacy_layout
    _make_db(old_root / "warehouse.db", "old")
    new_data.mkdir()
    _make_db(new_data / "warehouse.db", "already-here")

    assert paths.migrate_legacy_data(server._copy_database) is False

    connection = sqlite3.connect(new_data / "warehouse.db")
    assert connection.execute("SELECT name FROM marker").fetchone()[0] == "already-here"
    connection.close()
    assert (old_root / "warehouse.db").exists()  # источник не тронут


def test_migration_copies_database_config_and_backups(legacy_layout):
    old_root, new_data = legacy_layout
    _make_db(old_root / "warehouse.db", "real-data")
    (old_root / "config.json").write_text('{"host": "0.0.0.0", "port": 8765}', encoding="utf-8")
    (old_root / "backups").mkdir()
    _make_db(old_root / "backups" / "warehouse_20260101_000000.db", "backup")

    assert paths.migrate_legacy_data(server._copy_database) is True

    connection = sqlite3.connect(new_data / "warehouse.db")
    assert connection.execute("SELECT name FROM marker").fetchone()[0] == "real-data"
    connection.close()
    assert '"port": 8765' in (new_data / "config.json").read_text(encoding="utf-8")
    assert (new_data / "backups" / "warehouse_20260101_000000.db").exists()


def test_migration_preserves_data_still_sitting_in_the_wal_sidecar(legacy_layout):
    # Этап 1 включил WAL: закоммиченные строки могут жить в -wal, а не в .db.
    # Обычный shutil.copy2 их потеряет — миграция обязана их сохранить.
    old_root, new_data = legacy_layout
    db_path = old_root / "warehouse.db"
    _make_db(db_path, "checkpointed")
    writer = sqlite3.connect(db_path)
    writer.execute("PRAGMA journal_mode = WAL")
    writer.execute("INSERT INTO marker VALUES ('only-in-wal')")
    writer.commit()
    assert (old_root / "warehouse.db-wal").exists(), "тест бессмыслен без -wal файла"

    assert paths.migrate_legacy_data(server._copy_database) is True
    writer.close()

    connection = sqlite3.connect(new_data / "warehouse.db")
    names = {row[0] for row in connection.execute("SELECT name FROM marker")}
    connection.close()
    assert names == {"checkpointed", "only-in-wal"}


def test_migration_renames_the_source_instead_of_deleting_it(legacy_layout):
    old_root, new_data = legacy_layout
    _make_db(old_root / "warehouse.db", "real-data")

    paths.migrate_legacy_data(server._copy_database)

    assert not (old_root / "warehouse.db").exists()
    assert (old_root / "warehouse.db.migrated").exists()


def test_migration_runs_only_once(legacy_layout):
    old_root, new_data = legacy_layout
    _make_db(old_root / "warehouse.db", "real-data")

    assert paths.migrate_legacy_data(server._copy_database) is True
    assert paths.migrate_legacy_data(server._copy_database) is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_paths.py -v -k migration`
Expected: FAIL — `AttributeError: module 'paths' has no attribute 'migrate_legacy_data'`.

- [ ] **Step 3: Implement**

Add to `paths.py` (after the constants):

```python
def legacy_root() -> Path:
    """Папка, где данные лежали до Этапа 3 — рядом с исполняемым файлом."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _retire_legacy_file(path: Path) -> None:
    """Переименовать перенесённый файл, не удаляя его.

    Осиротевшие warehouse.db-wal/-shm тоже переименовываем: оставленный
    рядом -wal был бы «проигран» поверх базы, если пользователь когда-нибудь
    вернёт старый .db на место — ровно та ошибка, которую финальное ревью
    Этапа 2 нашло в восстановлении из бэкапа.
    """
    if path.exists():
        path.replace(path.with_name(path.name + ".migrated"))


def migrate_legacy_data(copy_database) -> bool:
    """Перенести данные из папки рядом с программой в DATA_DIR.

    Возвращает True, если миграция реально выполнялась.

    Копируем, а не перемещаем, и переименовываем источник только после
    успешного копирования: падение на середине ничего не теряет — при
    следующем запуске исходный файл всё ещё на месте и попытка повторится.

    `copy_database` — (source, dest) -> None; вызывающий передаёт
    server._copy_database (копия через SQLite online backup API, которая
    видит данные в -wal). Обычного копирования файла здесь недостаточно.
    """
    if DB_PATH.exists():
        return False
    old_db = legacy_root() / "warehouse.db"
    if not old_db.exists():
        return False

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    copy_database(old_db, DB_PATH)

    old_config = legacy_root() / "config.json"
    if old_config.exists() and not CONFIG_PATH.exists():
        shutil.copy2(old_config, CONFIG_PATH)

    old_backups = legacy_root() / "backups"
    if old_backups.is_dir():
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        for item in sorted(old_backups.glob("*.db")):
            target = BACKUP_DIR / item.name
            if not target.exists():
                shutil.copy2(item, target)

    _retire_legacy_file(old_db)
    _retire_legacy_file(old_db.with_name(old_db.name + "-wal"))
    _retire_legacy_file(old_db.with_name(old_db.name + "-shm"))
    return True
```

Add `import shutil` to `paths.py`'s imports (alphabetically: `os`, `shutil`, `sys`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_paths.py -v`
Expected: PASS (все тесты файла)

Run: `python -m pytest -q`
Expected: PASS (полный набор, без регрессий)

- [ ] **Step 5: Commit**

```bash
git add paths.py tests/test_paths.py
git commit -m "Task A2: add WAL-safe, idempotent migration of legacy data into ProgramData"
```

---

### Task A3: подключить `paths` к `server.py` и `warehouse_tray.py`

**Files:**
- Modify: `server.py` (блок путей `server.py:27-34`, `init_db`, статика `server.py:1042`, `main`), `warehouse_tray.py` (`warehouse_tray.py:27-36`, `main`), `WarehouseApp_New.spec`
- Test: `tests/test_server_auth.py` (новый тест на статику из RESOURCE_DIR)

**Interfaces:**
- Consumes: `paths.*` (Tasks A1, A2).
- Produces: `server.DB_PATH`/`server.BACKUP_DIR`/`server.CONFIG_PATH`/`server.SCHEMA_PATH`/`server.RESOURCE_DIR` — те же имена на уровне модуля `server` (существующие тесты монкейпатчат `server.DB_PATH`/`server.BACKUP_DIR`, поэтому имена обязаны остаться); `server.APP_VERSION: str`.

**Критично про порядок вызова миграции:** `migrate_legacy_data()` вызывается **только из точек входа** (`server.main()` и `warehouse_tray.WarehouseApp.start_server()`), а НЕ из `init_db()`. Причина: тесты монкейпатчат `server.DB_PATH` на `tmp_path`, но `migrate_legacy_data` смотрит на `paths.DB_PATH` и `paths.legacy_root()` — а `legacy_root()` в режиме разработки указывает на корень репозитория, где лежит **настоящая** `warehouse.db` разработчика. Вызов из `init_db()` заставил бы любой тест переименовать реальную базу в `.migrated`. Миграция — забота запуска приложения, не инициализации БД.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_server_auth.py`:

```python
def test_static_files_are_read_from_the_resource_dir(live_server, tmp_path, monkeypatch):
    # В собранном onefile-EXE статика лежит в sys._MEIPASS, а не рядом с .exe.
    # Обслуживание должно идти из RESOURCE_DIR, иначе установленная в
    # Program Files программа отдаёт 404 на собственный index.html.
    fake_resources = tmp_path / "resources"
    fake_resources.mkdir()
    (fake_resources / "index.html").write_text("<html>из RESOURCE_DIR</html>", encoding="utf-8")
    monkeypatch.setattr(server, "RESOURCE_DIR", fake_resources)

    request = urllib.request.Request(f"{live_server}/index.html", method="GET")
    with urllib.request.urlopen(request) as response:
        body = response.read().decode("utf-8")
    assert "из RESOURCE_DIR" in body
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_server_auth.py -v -k resource_dir`
Expected: FAIL — `AttributeError: <module 'server'> has no attribute 'RESOURCE_DIR'` (статика сейчас берётся из `ROOT`).

- [ ] **Step 3: Implement — `server.py`**

Replace the path block (`server.py:27-34`, начинается с `if getattr(sys, 'frozen', False):`):

```python
from paths import (
    BACKUP_DIR,
    CONFIG_PATH,
    DATA_DIR,
    DB_PATH,
    LOG_DIR,
    RESOURCE_DIR,
    SCHEMA_PATH,
    UPDATE_CACHE_PATH,
    VERSION_PATH,
)

MAX_BACKUPS = 30


def _read_app_version() -> str:
    """Версия продукта из файла VERSION (общая с мобильным приложением)."""
    try:
        return VERSION_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        return "0.0.0"


APP_VERSION = _read_app_version()
```

(Имя `ROOT` в `server.py` больше не нужно — удалить. `import paths` добавлять не нужно, `from paths import ...` достаточно.)

Replace static file resolution (`server.py:1042`, строка `file_path = ROOT / relative`):

```python
        file_path = RESOURCE_DIR / relative
```

In `main()` — вызвать миграцию до `init_db()`:

```python
def main() -> None:
    setup_logging()
    paths.migrate_legacy_data(_copy_database)
    try:
        init_db()
```

(`setup_logging()` появится в Task A4 — на этом шаге строку `setup_logging()` **не добавлять**, только вызов миграции. Также добавить `import paths` рядом с `import migrations`, поскольку `paths.migrate_legacy_data` вызывается по имени модуля.)

- [ ] **Step 4: Implement — `warehouse_tray.py`**

Replace the path block (`warehouse_tray.py:27-36`):

```python
import paths

# ROOT нужен только для диагностики в логе запуска — данные живут в
# paths.DATA_DIR, ресурсы в paths.RESOURCE_DIR.
if getattr(sys, 'frozen', False):
    ROOT = Path(sys.executable).resolve().parent
else:
    ROOT = Path(__file__).resolve().parent

CONFIG_FILE = paths.CONFIG_PATH
LOCK_FILE = paths.DATA_DIR / ".warehouse_app.lock"
```

(Удалить строку `SERVER_SCRIPT = ROOT / "server.py"` — она нигде не используется: сервер запускается через `import server`, а не как подпроцесс. Строку `LOCK_FILE = ROOT / ".warehouse_app.lock"` заменить показанной выше.)

`_load_port()` уже читает `CONFIG_FILE` — менять не нужно, он теперь автоматически смотрит в новое место.

В `WarehouseApp.start_server()`, перед `server.init_db()`:

```python
            import server
            paths.migrate_legacy_data(server._copy_database)
            server.init_db()
```

Lock-файл теперь пишется в `DATA_DIR`, которой при самом первом запуске может не быть — в `__init__`, перед `LOCK_FILE.write_text(...)`:

```python
        try:
            paths.DATA_DIR.mkdir(parents=True, exist_ok=True)
            LOCK_FILE.write_text(str(os.getpid()))
```

- [ ] **Step 5: Implement — добавить новые файлы в сборку**

In `WarehouseApp_New.spec`, `datas` — добавить `paths.py`, `VERSION` и `updates.py` (последний появится в Task D1; добавляем сразу, чтобы не забыть — отсутствующий на этот момент файл PyInstaller не соберёт, поэтому `updates.py` добавляем **в Task D1**, а здесь только два):

```python
    datas=[('server.py', '.'), ('app.js', '.'), ('index.html', '.'), ('styles.css', '.'), ('schema.sql', '.'), ('act_generator.py', '.'), ('mobile_actions.py', '.'), ('migrations.py', '.'), ('auth.py', '.'), ('paths.py', '.'), ('VERSION', '.'), ('qrcode-lib.js', '.'), ('chart.umd.min.js', '.')],
```

Note: `VERSION` создаётся в Task B1. Чтобы этот шаг не сломал сборку раньше времени, создать файл прямо сейчас одной строкой — Task B1 его переиспользует:

```bash
printf '1.0.0\n' > VERSION
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `python -m pytest tests/test_server_auth.py -v -k resource_dir`
Expected: PASS

Run: `python -m pytest -q`
Expected: PASS (полный набор). Если какой-то тест опирался на `server.ROOT` — заменить на `server.RESOURCE_DIR`.

- [ ] **Step 7: Commit**

```bash
git add server.py warehouse_tray.py WarehouseApp_New.spec VERSION tests/test_server_auth.py
git commit -m "Task A3: read data from ProgramData and resources from _MEIPASS, migrate on startup"
```

---

### Task A4: логи в файл с ротацией

**Files:**
- Modify: `server.py` (импорты, новая `setup_logging()`, `main()`), `warehouse_tray.py` (`main()`)
- Test: `tests/test_paths.py`

**Interfaces:**
- Consumes: `paths.LOG_DIR` (Task A1).
- Produces: `server.setup_logging() -> None` — идемпотентна (повторный вызов не добавляет второй обработчик).

- [ ] **Step 1: Write the failing test**

Add to `tests/test_paths.py`:

```python
import logging


def test_setup_logging_writes_to_a_rotating_file(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "LOG_DIR", tmp_path / "logs")
    root_logger = logging.getLogger()
    original_handlers = list(root_logger.handlers)
    try:
        server.setup_logging()
        logging.getLogger().info("проверка записи в лог")
        for handler in logging.getLogger().handlers:
            handler.flush()
        log_file = tmp_path / "logs" / "warehouse.log"
        assert log_file.exists()
        assert "проверка записи в лог" in log_file.read_text(encoding="utf-8")
    finally:
        for handler in list(root_logger.handlers):
            if handler not in original_handlers:
                handler.close()
                root_logger.removeHandler(handler)


def test_setup_logging_is_idempotent(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "LOG_DIR", tmp_path / "logs")
    root_logger = logging.getLogger()
    original_handlers = list(root_logger.handlers)
    try:
        server.setup_logging()
        after_first = len(root_logger.handlers)
        server.setup_logging()
        assert len(root_logger.handlers) == after_first
    finally:
        for handler in list(root_logger.handlers):
            if handler not in original_handlers:
                handler.close()
                root_logger.removeHandler(handler)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_paths.py -v -k logging`
Expected: FAIL — `AttributeError: module 'server' has no attribute 'setup_logging'`.

- [ ] **Step 3: Implement**

Add to `server.py` imports:

```python
import logging
from logging.handlers import RotatingFileHandler
```

Add near `load_config()`:

```python
LOG_HANDLER_NAME = "warehouse-file"


def setup_logging() -> None:
    """Логи запуска и ошибок — в файл с ротацией, чтобы было что приложить к жалобе.

    Идемпотентна: трей вызывает её при запуске, а main() — при консольном
    старте; второй обработчик писал бы каждую строку дважды.
    """
    root_logger = logging.getLogger()
    if any(handler.get_name() == LOG_HANDLER_NAME for handler in root_logger.handlers):
        return
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:  # noqa: BLE001
        print(f"Не удалось создать папку для логов ({exc}) — работаю без файла логов.")
        return
    handler = RotatingFileHandler(
        LOG_DIR / "warehouse.log", maxBytes=5_000_000, backupCount=3, encoding="utf-8"
    )
    handler.set_name(LOG_HANDLER_NAME)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    root_logger.setLevel(logging.INFO)
    root_logger.addHandler(handler)
```

In `main()`, добавить первой строкой (та самая строка, которую Task A3 просил не добавлять):

```python
def main() -> None:
    setup_logging()
    paths.migrate_legacy_data(_copy_database)
```

Заменить существующие `print()` **на границе запуска/остановки** в `main()` на `logging.info(...)`, сохранив `print()` там же (консольный запуск должен остаться разговорчивым):

```python
    logging.info("Сервер запускается на http://%s:%s", HOST, PORT)
    print(f"Warehouse app running at http://{HOST}:{PORT}")
```

In `warehouse_tray.py`, в `main()` первой строкой:

```python
def main() -> None:
    import server
    server.setup_logging()
```

И в `WarehouseApp.start_server()`'s `except Exception as e:` — добавить запись в лог перед существующей обработкой:

```python
        except Exception as e:
            logging.exception("Не удалось запустить сервер")
            print(f"Ошибка запуска сервера: {e}")
```

(добавить `import logging` в импорты `warehouse_tray.py`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_paths.py -v -k logging`
Expected: PASS

Run: `python -m pytest -q`
Expected: PASS (полный набор)

- [ ] **Step 5: Commit**

```bash
git add server.py warehouse_tray.py tests/test_paths.py
git commit -m "Task A4: log startup and errors to a rotating file in ProgramData"
```

---

## Задача B — единая версия и установщик Windows

### Task B1: `VERSION` + `bump_version.py` + сгенерированные файлы версии

**Files:**
- Modify: `VERSION` (создан в Task A3)
- Create: `bump_version.py`, `mobile/www/js/version.js`, `mobile/android/version.properties`
- Test: `tests/test_bump_version.py` (создать)

**Interfaces:**
- Produces: `bump_version.next_version(current: str, part: str) -> str`; `bump_version.version_code(version: str) -> int`; `bump_version.render_files(version: str) -> dict[Path, str]` (путь → содержимое, чистая функция); `bump_version.write_version_files(version: str) -> None`; `bump_version.check_in_sync() -> list[str]` (список рассинхронизованных файлов, пустой = всё в порядке). Потребляется Task C1 (Gradle читает `version.properties`) и Task D3 (`server.APP_VERSION`).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_bump_version.py`:

```python
import pytest

import bump_version


@pytest.mark.parametrize("current,part,expected", [
    ("1.0.0", "patch", "1.0.1"),
    ("1.0.9", "patch", "1.0.10"),
    ("1.2.3", "minor", "1.3.0"),
    ("1.2.3", "major", "2.0.0"),
    ("0.9.9", "major", "1.0.0"),
])
def test_next_version(current, part, expected):
    assert bump_version.next_version(current, part) == expected


def test_next_version_rejects_an_unknown_part():
    with pytest.raises(ValueError):
        bump_version.next_version("1.0.0", "build")


def test_next_version_rejects_a_malformed_current_version():
    with pytest.raises(ValueError):
        bump_version.next_version("1.0", "patch")


@pytest.mark.parametrize("version,expected", [
    ("1.0.0", 10000),
    ("1.0.1", 10001),
    ("1.2.3", 10203),
    ("2.0.0", 20000),
])
def test_version_code_is_monotonic_and_matches_the_documented_formula(version, expected):
    assert bump_version.version_code(version) == expected


def test_version_code_beats_the_legacy_android_version_code():
    # build.gradle до этого этапа стоял на versionCode 1; любая новая версия
    # обязана быть больше, иначе Android откажется ставить обновление.
    assert bump_version.version_code("1.0.0") > 1


def test_generated_files_are_committed_in_sync_with_the_version_file():
    # VERSION — единственный редактируемый источник; version.js и
    # version.properties генерируются из него и коммитятся. Этот тест ловит
    # ситуацию «подняли VERSION вручную, забыли прогнать bump_version.py».
    assert bump_version.check_in_sync() == []


def test_render_files_produces_the_expected_contents():
    rendered = {path.name: text for path, text in bump_version.render_files("1.2.3").items()}
    assert rendered["VERSION"] == "1.2.3\n"
    assert rendered["version.js"] == "window.APP_VERSION = '1.2.3';\n"
    assert "versionName=1.2.3" in rendered["version.properties"]
    assert "versionCode=10203" in rendered["version.properties"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_bump_version.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'bump_version'`.

- [ ] **Step 3: Implement**

Create `bump_version.py`:

```python
"""Поднять версию продукта одной командой.

VERSION — единственный редактируемый источник версии. Остальные файлы
версии генерируются из него и коммитятся, чтобы и десктоп, и мобильное
приложение всегда видели одно и то же число без отдельного шага генерации
перед запуском.

    python bump_version.py patch     # 1.0.0 -> 1.0.1
    python bump_version.py --check   # проверить, что файлы в синхроне
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION_FILE = ROOT / "VERSION"
MOBILE_VERSION_JS = ROOT / "mobile" / "www" / "js" / "version.js"
ANDROID_VERSION_PROPERTIES = ROOT / "mobile" / "android" / "version.properties"

PARTS = ("major", "minor", "patch")


def parse(version: str) -> tuple[int, int, int]:
    pieces = version.strip().split(".")
    if len(pieces) != 3:
        raise ValueError(f"Версия должна быть вида X.Y.Z, получено: {version!r}")
    try:
        major, minor, patch = (int(piece) for piece in pieces)
    except ValueError:
        raise ValueError(f"Версия должна состоять из чисел, получено: {version!r}") from None
    return major, minor, patch


def next_version(current: str, part: str) -> str:
    major, minor, patch = parse(current)
    if part == "major":
        major, minor, patch = major + 1, 0, 0
    elif part == "minor":
        minor, patch = minor + 1, 0
    elif part == "patch":
        patch += 1
    else:
        raise ValueError(f"Часть версии должна быть одной из {PARTS}, получено: {part!r}")
    return f"{major}.{minor}.{patch}"


def version_code(version: str) -> int:
    """Целочисленный versionCode для Android.

    Ограничение схемы: minor и patch должны быть меньше 100. При текущем
    темпе релизов запас достаточный; задокументировано в docs/RELEASING.md.
    """
    major, minor, patch = parse(version)
    if minor >= 100 or patch >= 100:
        raise ValueError(
            f"minor и patch должны быть меньше 100 для формулы versionCode, получено: {version!r}"
        )
    return major * 10000 + minor * 100 + patch


def render_files(version: str) -> dict[Path, str]:
    """Путь -> ожидаемое содержимое. Чистая функция, ничего не пишет на диск."""
    return {
        VERSION_FILE: f"{version}\n",
        MOBILE_VERSION_JS: f"window.APP_VERSION = '{version}';\n",
        ANDROID_VERSION_PROPERTIES: (
            "# Сгенерировано bump_version.py — не редактировать вручную.\n"
            f"versionName={version}\n"
            f"versionCode={version_code(version)}\n"
        ),
    }


def write_version_files(version: str) -> None:
    for path, text in render_files(version).items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def current_version() -> str:
    return VERSION_FILE.read_text(encoding="utf-8").strip()


def check_in_sync() -> list[str]:
    """Имена файлов, чьё содержимое разошлось с VERSION (пустой список = всё в порядке)."""
    version = current_version()
    stale = []
    for path, expected in render_files(version).items():
        try:
            actual = path.read_text(encoding="utf-8")
        except OSError:
            stale.append(path.name)
            continue
        if actual.replace("\r\n", "\n") != expected:
            stale.append(path.name)
    return stale


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print(__doc__)
        return 2
    if argv[0] == "--check":
        stale = check_in_sync()
        if stale:
            print("Файлы версии рассинхронизованы: " + ", ".join(stale))
            print("Выполните: python bump_version.py --sync")
            return 1
        print(f"Версия {current_version()}, все файлы в синхроне.")
        return 0
    if argv[0] == "--sync":
        write_version_files(current_version())
        print(f"Файлы версии перезаписаны из VERSION ({current_version()}).")
        return 0
    if argv[0] not in PARTS:
        print(__doc__)
        return 2
    new_version = next_version(current_version(), argv[0])
    write_version_files(new_version)
    print(new_version)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

- [ ] **Step 4: Generate the version files**

Run: `python bump_version.py --sync`
Expected: печатает `Файлы версии перезаписаны из VERSION (1.0.0).`; появляются `mobile/www/js/version.js` и `mobile/android/version.properties`.

- [ ] **Step 5: Wire `version.js` into the mobile app**

In `mobile/www/index.html`, добавить перед `<script src="js/screens.js"></script>`:

```html
  <script src="js/version.js"></script>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `python -m pytest tests/test_bump_version.py -v`
Expected: PASS (все тесты)

Run: `python -m pytest -q`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add VERSION bump_version.py mobile/www/js/version.js mobile/android/version.properties mobile/www/index.html tests/test_bump_version.py
git commit -m "Task B1: add VERSION as the single source of product version, with bump_version.py"
```

---

### Task B2: установщик Inno Setup

**Files:**
- Create: `installer/warehouse.iss`, `installer/build_installer.bat`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `VERSION` (Task B1), `dist/WarehouseApp_New.exe` (PyInstaller).
- Produces: `installer/output/WarehouseSetup-X.Y.Z.exe`.

Автоматических тестов нет — установщик проверяется реальной установкой (Step 5 ниже и Task E2). Это тот же прецедент, что UI-код в Этапах 1-2.

- [ ] **Step 1: Install Inno Setup**

На этой машине Inno Setup отсутствует (проверено). Установить:

Run: `winget install -e --id JRSoftware.InnoSetup`
Expected: успешная установка; появляется `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`.

- [ ] **Step 2: Create `installer/warehouse.iss`**

```
; Установщик «Склад IT-техники».
; AppId зафиксирован навсегда: по нему Inno Setup находит и заменяет
; предыдущую установку при обновлении. Никогда не менять.
#define MyAppName "Склад IT-техники"
#define MyAppExeName "WarehouseApp.exe"
#define MyAppVersion GetEnv("WAREHOUSE_VERSION")

[Setup]
AppId={{FD91C08C-6D2F-45E6-A98B-F77C8CDDE02F}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Склад IT-техники
DefaultDirName={autopf}\Warehouse
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=output
OutputBaseFilename=WarehouseSetup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Files]
Source: "..\dist\WarehouseApp_New.exe"; DestDir: "{app}"; DestName: "{#MyAppExeName}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Удалить {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: autostart

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"
Name: "autostart"; Description: "Запускать при входе в Windows"; Flags: unchecked
Name: "firewall"; Description: "Открыть порт 8765 в брандмауэре (нужно для подключения телефона по сети)"; Flags: unchecked

[Run]
Filename: "netsh"; Parameters: "advfirewall firewall add rule name=""Склад IT-техники"" dir=in action=allow protocol=TCP localport=8765"; Tasks: firewall; Flags: runhidden
Filename: "{app}\{#MyAppExeName}"; Description: "Запустить {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""Склад IT-техники"""; Flags: runhidden; RunOnceId: "RemoveFirewallRule"

; Данные пользователя (%ProgramData%\Warehouse) лежат ВНЕ {app}, поэтому
; деинсталлятор их не трогает — это следствие DefaultDirName, а не
; отдельная защита, которую можно случайно потерять.
```

- [ ] **Step 3: Create `installer/build_installer.bat`**

```bat
@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" (
    echo ОШИБКА: Inno Setup не найден: "%ISCC%"
    echo Установите его командой: winget install -e --id JRSoftware.InnoSetup
    exit /b 1
)

if not exist "VERSION" (
    echo ОШИБКА: файл VERSION не найден.
    exit /b 1
)
set /p WAREHOUSE_VERSION=<VERSION

python bump_version.py --check
if errorlevel 1 exit /b 1

echo Сборка EXE (PyInstaller)...
pyinstaller WarehouseApp_New.spec --noconfirm
if errorlevel 1 (
    echo ОШИБКА: не удалось собрать EXE.
    exit /b 1
)

echo Сборка установщика версии %WAREHOUSE_VERSION%...
"%ISCC%" installer\warehouse.iss
if errorlevel 1 (
    echo ОШИБКА: не удалось собрать установщик.
    exit /b 1
)

echo.
echo Готово: installer\output\WarehouseSetup-%WAREHOUSE_VERSION%.exe
```

- [ ] **Step 4: Ignore installer output**

Add to `.gitignore` (в секцию Build artifacts):

```
installer/output/
```

- [ ] **Step 5: Build and verify the installer for real**

Run: `installer\build_installer.bat`
Expected: `Готово: installer\output\WarehouseSetup-1.0.0.exe`.

Проверить установку вручную (это и есть критерий приёмки №1):
1. Запустить `installer\output\WarehouseSetup-1.0.0.exe`, установить с галочкой «ярлык на рабочем столе», без автозапуска и без файрвола.
2. Убедиться: приложение установлено в `C:\Program Files\Warehouse\WarehouseApp.exe`, ярлык на рабочем столе есть.
3. Запустить приложение. Убедиться: оно поднимается, открывается браузер, интерфейс загружается (это проверяет исправление `RESOURCE_DIR` из Task A1/A3 — до него статика бы не нашлась), появляется `C:\ProgramData\Warehouse\warehouse.db`.
4. Удалить через «Установка и удаление программ». Убедиться: `C:\Program Files\Warehouse` исчезла, а `C:\ProgramData\Warehouse` со всеми данными **осталась**.

Записать результат каждого пункта в отчёт задачи. Если хоть один не сошёлся — это дефект реализации, а не «особенность»: чинить до коммита.

- [ ] **Step 6: Commit**

```bash
git add installer/warehouse.iss installer/build_installer.bat .gitignore
git commit -m "Task B2: add Inno Setup installer with optional autostart and firewall tasks"
```

---

### Task B3: обновить пользовательские инструкции

**Files:**
- Modify: `ИНСТРУКЦИЯ.txt`, `БЫСТРЫЙ_СТАРТ.txt`, `README.txt`

**Interfaces:**
- Consumes: установщик (Task B2).

Автоматических тестов нет — текстовая документация.

- [ ] **Step 1: Read the current instructions**

Прочитать все три файла целиком, отметив, какие шаги описывают ручную установку через bat-файлы.

**Важно про кодировку:** эти файлы существуют в кодировке, отличной от UTF-8 (проект собирался под русскую Windows; `setup_lan.bat`/`add_autostart.bat` — CP866, и правка их кодировки уже однажды была отдельной ошибкой в Этапе 1, коммит `dd187f4`). Определить фактическую кодировку каждого файла перед правкой и **сохранить её же**. Не «исправлять» кодировку на UTF-8 — это отдельное решение, не входящее в этот этап.

- [ ] **Step 2: Rewrite the user-facing path**

В `БЫСТРЫЙ_СТАРТ.txt` и `ИНСТРУКЦИЯ.txt` основным путём установки сделать установщик:

1. Скачать `WarehouseSetup-X.Y.Z.exe` со страницы релизов: https://github.com/ssk1tlz/warehouse/releases
2. Запустить, при желании отметить «Запускать при входе в Windows» и «Открыть порт 8765 в брандмауэре» (второе — если нужно подключать телефон).
3. Windows покажет предупреждение SmartScreen «Windows защитила ваш компьютер» — это нормально для программ без платного сертификата: нажать «Подробнее» → «Выполнить в любом случае».
4. Данные (база, резервные копии) хранятся в `C:\ProgramData\Warehouse` и при удалении программы не стираются.

Bat-файлы описать отдельным разделом «Для разработчиков» — запуск из исходников без установки.

- [ ] **Step 3: Verify encodings survived**

Run: `python -c "import pathlib; [print(p, pathlib.Path(p).read_bytes()[:40]) for p in ['ИНСТРУКЦИЯ.txt','БЫСТРЫЙ_СТАРТ.txt','README.txt']]"`
Expected: каждый файл читается, байты в начале соответствуют исходной кодировке (не появилось UTF-8 BOM там, где его не было).

Открыть каждый файл и убедиться, что русский текст читается, а не превратился в «крякозябры».

- [ ] **Step 4: Commit**

```bash
git add ИНСТРУКЦИЯ.txt БЫСТРЫЙ_СТАРТ.txt README.txt
git commit -m "Task B3: document installer-based setup and SmartScreen warning for users"
```

---

## Задача C — release-подпись Android

### Task C1: версия Android из `version.properties`

**Files:**
- Modify: `mobile/android/app/build.gradle`

**Interfaces:**
- Consumes: `mobile/android/version.properties` (Task B1).
- Produces: APK с `versionName`/`versionCode` из общего файла версии.

- [ ] **Step 1: Read the current build.gradle**

Прочитать `mobile/android/app/build.gradle` целиком, отметив `defaultConfig` блок (`versionCode 1`, `versionName "1.0"` — строки 10-11).

- [ ] **Step 2: Replace the hardcoded version**

В начало файла (до блока `android {`):

```groovy
def versionProps = new Properties()
def versionPropsFile = rootProject.file('version.properties')
if (!versionPropsFile.exists()) {
    throw new GradleException(
        "mobile/android/version.properties не найден. Выполните в корне проекта: python bump_version.py --sync"
    )
}
versionPropsFile.withInputStream { versionProps.load(it) }
```

В `defaultConfig` заменить две строки:

```groovy
        versionCode versionProps['versionCode'].toInteger()
        versionName versionProps['versionName']
```

Формула `versionCode` намеренно НЕ дублируется здесь — она живёт только в
`bump_version.py` и покрыта тестами; Gradle читает готовое число.

- [ ] **Step 3: Verify the version is picked up**

Run: `cd mobile/android && ./gradlew.bat :app:assembleDebug`
Expected: BUILD SUCCESSFUL.

Run: `python -c "import re,pathlib; print(pathlib.Path('mobile/android/app/build/outputs/apk/debug/output-metadata.json').read_text())"`
Expected: JSON содержит `"versionCode": 10000` и `"versionName": "1.0.0"` (не 1 / "1.0").

- [ ] **Step 4: Commit**

```bash
git add mobile/android/app/build.gradle
git commit -m "Task C1: read Android versionCode/versionName from the shared version file"
```

---

### Task C2: release-подпись APK

**Files:**
- Modify: `mobile/android/app/build.gradle`, `.gitignore`
- Create: `mobile/android/keystore.properties.example`

**Interfaces:**
- Consumes: `mobile/android/keystore.properties` (не коммитится).
- Produces: `./gradlew.bat assembleRelease` даёт подписанный APK; без `keystore.properties` падает с понятной ошибкой на русском, а не выдаёт молча debug-подписанный артефакт.

- [ ] **Step 1: Generate the release keystore**

`keytool` на этой машине есть (`C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot\bin\keytool.exe`).

Создать папку вне репозитория и ключ:

```bash
mkdir -p "$USERPROFILE/.warehouse-release"
keytool -genkeypair -v \
  -keystore "$USERPROFILE/.warehouse-release/warehouse.jks" \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias warehouse \
  -dname "CN=Warehouse, OU=IT, O=Warehouse, L=-, S=-, C=RU" \
  -storepass <ПАРОЛЬ> -keypass <ПАРОЛЬ>
```

**Пароль:** сгенерировать случайный (например,
`python -c "import secrets; print(secrets.token_urlsafe(24))"`) и сохранить
его в `keystore.properties` (следующий шаг). Пароль и сам `.jks` **никогда
не коммитить** и не печатать в отчёте задачи — в отчёте написать только
«keystore создан, пароль записан в keystore.properties».

- [ ] **Step 2: Create `mobile/android/keystore.properties`**

Файл (не коммитится):

```properties
storeFile=C:\\Users\\<пользователь>\\.warehouse-release\\warehouse.jks
storePassword=<пароль>
keyAlias=warehouse
keyPassword=<пароль>
```

И коммитируемый образец `mobile/android/keystore.properties.example`:

```properties
# Скопируйте в keystore.properties и подставьте свои значения.
# Сам keystore храните ВНЕ репозитория. См. docs/RELEASING.md.
storeFile=C:\\Users\\ВАШ_ПОЛЬЗОВАТЕЛЬ\\.warehouse-release\\warehouse.jks
storePassword=ПАРОЛЬ_ХРАНИЛИЩА
keyAlias=warehouse
keyPassword=ПАРОЛЬ_КЛЮЧА
```

- [ ] **Step 3: Ignore the secrets**

Add to `.gitignore`:

```
mobile/android/keystore.properties
*.jks
*.keystore
```

- [ ] **Step 4: Wire the signing config**

В `mobile/android/app/build.gradle`, внутри `android { }`:

```groovy
    signingConfigs {
        release {
            def keystorePropsFile = rootProject.file('keystore.properties')
            if (keystorePropsFile.exists()) {
                def keystoreProps = new Properties()
                keystorePropsFile.withInputStream { keystoreProps.load(it) }
                storeFile file(keystoreProps['storeFile'])
                storePassword keystoreProps['storePassword']
                keyAlias keystoreProps['keyAlias']
                keyPassword keystoreProps['keyPassword']
            }
        }
    }
```

В `buildTypes { release { ... } }` добавить:

```groovy
            signingConfig signingConfigs.release
```

И явную проверку, чтобы сборка не выдала молча неподписанный/debug-артефакт:

```groovy
tasks.matching { it.name == 'assembleRelease' }.configureEach {
    doFirst {
        if (!rootProject.file('keystore.properties').exists()) {
            throw new GradleException(
                "mobile/android/keystore.properties не найден — release-сборка требует ключа подписи. " +
                "См. docs/RELEASING.md, раздел «Ключ подписи Android»."
            )
        }
    }
}
```

- [ ] **Step 5: Verify both paths**

Проверить, что без ключа сборка падает понятно:

```bash
cd mobile/android
mv keystore.properties keystore.properties.tmp
./gradlew.bat assembleRelease
```
Expected: FAIL с текстом «keystore.properties не найден — release-сборка требует ключа подписи».

```bash
mv keystore.properties.tmp keystore.properties
./gradlew.bat assembleRelease
```
Expected: BUILD SUCCESSFUL; появляется `mobile/android/app/build/outputs/apk/release/app-release.apk`.

Проверить, что APK действительно подписан нашим ключом (а не debug):

Run: `"C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot\bin\keytool.exe" -printcert -jarfile mobile/android/app/build/outputs/apk/release/app-release.apk`
Expected: владелец сертификата — `CN=Warehouse, ...`, НЕ `CN=Android Debug`.

- [ ] **Step 6: Confirm nothing secret got staged**

Run: `git status --porcelain -uall`
Expected: `keystore.properties` и `*.jks` в списке **отсутствуют** (проигнорированы). Если они видны — `.gitignore` не сработал, чинить до коммита.

- [ ] **Step 7: Commit**

```bash
git add mobile/android/app/build.gradle mobile/android/keystore.properties.example .gitignore
git commit -m "Task C2: add Android release signing config that fails loudly without a keystore"
```

---

## Задача D — проверка обновлений

### Task D1: `updates.py` — сравнение версий, запрос к GitHub, кэш

**Files:**
- Create: `updates.py`
- Modify: `WarehouseApp_New.spec`
- Test: `tests/test_updates.py` (создать)

**Interfaces:**
- Consumes: `paths.UPDATE_CACHE_PATH` (Task A1).
- Produces: `updates.parse_version(text) -> tuple[int,int,int] | None`; `updates.is_newer(candidate: str, current: str) -> bool`; `updates.fetch_latest_release(url=..., timeout=...) -> dict | None` (`{"version": str, "url": str}`); `updates.read_cache(path) -> dict`; `updates.write_cache(path, version, release_url) -> None`; `updates.should_check(cache, now) -> bool`; `updates.check_now(cache_path, url=...) -> dict | None`. Потребляется Task D3.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_updates.py`:

```python
import io
import json
import urllib.error
from datetime import datetime, timedelta, timezone

import pytest

import updates


@pytest.mark.parametrize("text,expected", [
    ("1.2.3", (1, 2, 3)),
    ("v1.2.3", (1, 2, 3)),
    ("V1.2.3", (1, 2, 3)),
    ("  v1.2.3  ", (1, 2, 3)),
])
def test_parse_version_accepts_tags_with_and_without_prefix(text, expected):
    assert updates.parse_version(text) == expected


@pytest.mark.parametrize("text", ["", None, "1.2", "latest", "v1.2.x", "1.2.3.4"])
def test_parse_version_rejects_anything_it_cannot_understand(text):
    assert updates.parse_version(text) is None


@pytest.mark.parametrize("candidate,current,expected", [
    ("1.0.1", "1.0.0", True),
    ("1.1.0", "1.0.9", True),
    ("2.0.0", "1.99.99", True),
    ("1.0.0", "1.0.0", False),
    ("1.0.0", "1.0.1", False),
    ("1.0.10", "1.0.9", True),
    ("мусор", "1.0.0", False),
    ("1.0.1", "мусор", False),
])
def test_is_newer(candidate, current, expected):
    assert updates.is_newer(candidate, current) is expected


def _fake_response(payload):
    class _Response(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.close()
            return False

    return _Response(json.dumps(payload).encode("utf-8"))


def test_fetch_latest_release_returns_version_and_url(monkeypatch):
    payload = {"tag_name": "v1.2.0", "html_url": "https://github.com/ssk1tlz/warehouse/releases/tag/v1.2.0"}
    monkeypatch.setattr(updates.urllib.request, "urlopen", lambda *a, **kw: _fake_response(payload))
    assert updates.fetch_latest_release() == {
        "version": "1.2.0",
        "url": "https://github.com/ssk1tlz/warehouse/releases/tag/v1.2.0",
    }


@pytest.mark.parametrize("failure", [
    urllib.error.URLError("нет сети"),
    urllib.error.HTTPError("url", 404, "Not Found", {}, None),
    TimeoutError("таймаут"),
    ValueError("невалидный json"),
])
def test_fetch_latest_release_is_silent_on_every_failure(monkeypatch, failure):
    # Никакая сетевая проблема не должна всплывать наружу: проверка
    # обновлений строго опциональна и не имеет права ничего ломать.
    def _raise(*args, **kwargs):
        raise failure

    monkeypatch.setattr(updates.urllib.request, "urlopen", _raise)
    assert updates.fetch_latest_release() is None


def test_fetch_latest_release_ignores_a_release_without_a_usable_tag(monkeypatch):
    monkeypatch.setattr(updates.urllib.request, "urlopen",
                        lambda *a, **kw: _fake_response({"tag_name": "nightly", "html_url": "x"}))
    assert updates.fetch_latest_release() is None


def test_should_check_is_true_when_never_checked():
    assert updates.should_check({}, datetime.now(timezone.utc)) is True


def test_should_check_is_false_within_the_interval():
    now = datetime.now(timezone.utc)
    cache = {"lastCheckedAt": (now - timedelta(hours=1)).isoformat()}
    assert updates.should_check(cache, now) is False


def test_should_check_is_true_after_the_interval():
    now = datetime.now(timezone.utc)
    cache = {"lastCheckedAt": (now - timedelta(hours=25)).isoformat()}
    assert updates.should_check(cache, now) is True


def test_should_check_is_true_when_the_stamp_is_unreadable():
    assert updates.should_check({"lastCheckedAt": "не дата"}, datetime.now(timezone.utc)) is True


def test_cache_round_trips(tmp_path):
    cache_path = tmp_path / "update_check.json"
    updates.write_cache(cache_path, "1.2.0", "https://example/release")
    cache = updates.read_cache(cache_path)
    assert cache["latestVersion"] == "1.2.0"
    assert cache["releaseUrl"] == "https://example/release"
    assert updates.parse_version(cache["latestVersion"]) is not None


def test_read_cache_returns_empty_dict_for_a_missing_or_broken_file(tmp_path):
    assert updates.read_cache(tmp_path / "нет.json") == {}
    broken = tmp_path / "broken.json"
    broken.write_text("{не json", encoding="utf-8")
    assert updates.read_cache(broken) == {}


def test_failed_check_does_not_touch_the_cache(tmp_path, monkeypatch):
    # Иначе одна неудачная попытка при отсутствии сети подавила бы проверку
    # ещё на сутки — интервал считается от последнего УСПЕШНОГО запроса.
    cache_path = tmp_path / "update_check.json"
    monkeypatch.setattr(updates, "fetch_latest_release", lambda *a, **kw: None)
    assert updates.check_now(cache_path) is None
    assert not cache_path.exists()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_updates.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'updates'`.

- [ ] **Step 3: Implement**

Create `updates.py`:

```python
"""Проверка новой версии через публичные GitHub Releases.

Полностью опциональна и полностью тиха: любая сетевая ошибка, таймаут,
недоступность GitHub или мусор в ответе означают «ничего не показываем».
Никакой телеметрии — уходит только анонимный GET к публичному API, никакие
данные пользователя никуда не отправляются.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

GITHUB_REPOSITORY = "ssk1tlz/warehouse"
LATEST_RELEASE_URL = f"https://api.github.com/repos/{GITHUB_REPOSITORY}/releases/latest"
CHECK_INTERVAL_SECONDS = 24 * 60 * 60
REQUEST_TIMEOUT_SECONDS = 3

_VERSION_RE = re.compile(r"^[vV]?(\d+)\.(\d+)\.(\d+)$")


def parse_version(text) -> tuple[int, int, int] | None:
    """'v1.2.3' / '1.2.3' -> (1, 2, 3). Всё остальное -> None."""
    if not isinstance(text, str):
        return None
    match = _VERSION_RE.match(text.strip())
    if not match:
        return None
    return tuple(int(piece) for piece in match.groups())


def is_newer(candidate, current) -> bool:
    """True, только если обе версии разобраны и candidate строго новее."""
    parsed_candidate = parse_version(candidate)
    parsed_current = parse_version(current)
    if parsed_candidate is None or parsed_current is None:
        return False
    return parsed_candidate > parsed_current


def fetch_latest_release(url: str = LATEST_RELEASE_URL,
                         timeout: int = REQUEST_TIMEOUT_SECONDS) -> dict | None:
    """{'version': '1.2.0', 'url': '...'} либо None при любой проблеме."""
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "WarehouseApp"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 — намеренно широко: проверка не имеет права ломать приложение
        return None
    if not isinstance(payload, dict):
        return None
    tag = payload.get("tag_name")
    parsed = parse_version(tag)
    if parsed is None:
        return None
    return {
        "version": ".".join(str(piece) for piece in parsed),
        "url": str(payload.get("html_url") or f"https://github.com/{GITHUB_REPOSITORY}/releases"),
    }


def read_cache(path: Path) -> dict:
    try:
        cache = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    return cache if isinstance(cache, dict) else {}


def write_cache(path: Path, version: str, release_url: str) -> None:
    payload = {
        "lastCheckedAt": datetime.now(timezone.utc).isoformat(),
        "latestVersion": version,
        "releaseUrl": release_url,
    }
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def should_check(cache: dict, now: datetime) -> bool:
    """Пора ли спрашивать GitHub.

    Интервал отсчитывается от последнего УСПЕШНОГО запроса: неудачная
    попытка кэш не трогает, иначе временное отсутствие сети подавило бы
    проверку на целые сутки.
    """
    stamp = cache.get("lastCheckedAt")
    if not isinstance(stamp, str):
        return True
    try:
        last = datetime.fromisoformat(stamp)
    except ValueError:
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return (now - last).total_seconds() >= CHECK_INTERVAL_SECONDS


def check_now(cache_path: Path, url: str = LATEST_RELEASE_URL) -> dict | None:
    """Спросить GitHub и записать кэш при успехе. None — если не вышло."""
    release = fetch_latest_release(url)
    if release is None:
        return None
    write_cache(cache_path, release["version"], release["url"])
    return release
```

- [ ] **Step 4: Add `updates.py` to the frozen build**

In `WarehouseApp_New.spec`, `datas` — добавить `('updates.py', '.')` рядом с `('paths.py', '.')`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_updates.py -v`
Expected: PASS (все тесты)

Run: `python -m pytest -q`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add updates.py WarehouseApp_New.spec tests/test_updates.py
git commit -m "Task D1: add silent, optional GitHub Releases update check with daily cache"
```

---

### Task D2: `GET`/`POST /api/settings`

**Files:**
- Modify: `server.py` (`do_GET`, `do_POST`, новые `handle_get_settings`/`handle_save_settings`, `save_config`)
- Test: `tests/test_server_auth.py`

**Interfaces:**
- Consumes: `server.CONFIG_PATH` (Task A3), `require_role` (Этап 1).
- Produces: `GET /api/settings` → `{"checkUpdates": bool}` (admin); `POST /api/settings {"checkUpdates": bool}` → `{"ok": true}` (admin); `server.check_updates_enabled() -> bool` — читает `config.json` заново при каждом вызове.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_server_auth.py`:

```python
def test_settings_endpoint_is_admin_only(live_server):
    admin_token = _create_admin(live_server)
    status, body = _request(live_server, "POST", "/api/users", token=admin_token,
                            json_body={"username": "kladovshchik", "password": "parol123", "role": "storekeeper"})
    assert status == 200, body
    status, body = _request(live_server, "POST", "/api/login",
                            json_body={"username": "kladovshchik", "password": "parol123"})
    storekeeper_token = body["token"]

    status, _ = _request(live_server, "GET", "/api/settings", token=storekeeper_token)
    assert status == 403
    status, _ = _request(live_server, "POST", "/api/settings", token=storekeeper_token,
                         json_body={"checkUpdates": False})
    assert status == 403


def test_settings_default_to_update_checks_enabled(live_server):
    token = _create_admin(live_server)
    status, body = _request(live_server, "GET", "/api/settings", token=token)
    assert status == 200
    assert body["checkUpdates"] is True


def test_settings_round_trip_and_survive_in_config(live_server, monkeypatch):
    token = _create_admin(live_server)
    status, _ = _request(live_server, "POST", "/api/settings", token=token,
                         json_body={"checkUpdates": False})
    assert status == 200
    status, body = _request(live_server, "GET", "/api/settings", token=token)
    assert body["checkUpdates"] is False
    assert server.check_updates_enabled() is False


def test_saving_settings_preserves_other_config_keys(live_server):
    # config.json несёт host/port — переключение галочки не должно их потерять,
    # иначе сервер после перезапуска перестанет слушать сеть.
    server.CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    server.CONFIG_PATH.write_text(json.dumps({"host": "0.0.0.0", "port": 8765}), encoding="utf-8")
    token = _create_admin(live_server)
    _request(live_server, "POST", "/api/settings", token=token, json_body={"checkUpdates": False})
    saved = json.loads(server.CONFIG_PATH.read_text(encoding="utf-8"))
    assert saved["host"] == "0.0.0.0"
    assert saved["port"] == 8765
    assert saved["checkUpdates"] is False


def test_settings_rejects_a_non_boolean_value(live_server):
    token = _create_admin(live_server)
    status, _ = _request(live_server, "POST", "/api/settings", token=token,
                         json_body={"checkUpdates": "да"})
    assert status == 400
```

**Внимание:** `live_server` сейчас монкейпатчит только `DB_PATH` и `BACKUP_DIR`. Эти тесты пишут в `server.CONFIG_PATH` — реальный `%ProgramData%\Warehouse\config.json`. Расширить фикстуру `live_server`, добавив в неё:

```python
    monkeypatch.setattr(server, "CONFIG_PATH", tmp_path / "config.json")
    monkeypatch.setattr(server, "UPDATE_CACHE_PATH", tmp_path / "update_check.json")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_server_auth.py -v -k settings`
Expected: FAIL — 404 (маршрута нет).

- [ ] **Step 3: Implement**

Add to `server.py` near `load_config()`:

```python
def save_config(updates_to_apply: dict) -> None:
    """Слить изменения в config.json, сохранив остальные ключи (host/port/...)."""
    config = load_config()
    config.update(updates_to_apply)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


def check_updates_enabled() -> bool:
    """Читаем config.json заново при каждом вызове, чтобы выключение
    проверки в настройках действовало сразу, без перезапуска сервера."""
    return bool(load_config().get("checkUpdates", True))
```

Add handlers to `WarehouseHandler`:

```python
    def handle_get_settings(self) -> None:
        self.send_json({"checkUpdates": check_updates_enabled()})

    def handle_save_settings(self, body: bytes) -> None:
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError as exc:
            self.send_json_error(HTTPStatus.BAD_REQUEST, f"invalid json: {exc}")
            return
        if not isinstance(payload, dict):
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Payload must be a JSON object.")
            return
        value = payload.get("checkUpdates")
        if not isinstance(value, bool):
            self.send_json_error(HTTPStatus.BAD_REQUEST, "Поле checkUpdates должно быть true или false.")
            return
        save_config({"checkUpdates": value})
        self.send_json({"ok": True})
```

In `do_GET`, рядом с маршрутом `/api/backups`:

```python
        if parsed.path == "/api/settings":
            if not self.require_role(user, ("admin",)):
                return
            self.handle_get_settings()
            return
```

In `do_POST`, рядом с `/api/backups/restore`:

```python
        if parsed.path == "/api/settings":
            if not self.require_role(user, ("admin",)):
                return
            self.handle_save_settings(body)
            return
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_server_auth.py -v -k settings`
Expected: PASS

Run: `python -m pytest -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server.py tests/test_server_auth.py
git commit -m "Task D2: add GET/POST /api/settings for the update-check toggle (admin)"
```

---

### Task D3: версии в `GET /api/state` + фоновая проверка

**Files:**
- Modify: `server.py` (`do_GET` `/api/state`, новая `current_update()`, `start_background_update_check()`, `main()`), `warehouse_tray.py`
- Test: `tests/test_server_auth.py`

**Interfaces:**
- Consumes: `updates.*` (Task D1), `server.APP_VERSION` (Task A3), `check_updates_enabled()` (Task D2).
- Produces: `GET /api/state` дополнительно несёт `currentVersion: str` и `latestVersion: str | null`; `server.current_update() -> dict | None`; `server.start_background_update_check() -> None`.

`latestVersion` — `null`, если: проверка выключена, кэша нет, или в кэше версия не новее текущей. Отдельного состояния «обновлений нет» нет — клиенту достаточно `latestVersion == null` для «плашку не показывать».

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_server_auth.py`:

```python
def test_state_reports_the_current_product_version(live_server):
    token = _create_admin(live_server)
    status, body = _request(live_server, "GET", "/api/state", token=token)
    assert status == 200
    assert body["currentVersion"] == server.APP_VERSION


def test_state_reports_a_newer_cached_version(live_server, monkeypatch):
    token = _create_admin(live_server)
    monkeypatch.setattr(server, "APP_VERSION", "1.0.0")
    import updates
    updates.write_cache(server.UPDATE_CACHE_PATH, "1.5.0", "https://example/release")
    status, body = _request(live_server, "GET", "/api/state", token=token)
    assert body["latestVersion"] == "1.5.0"
    assert body["releaseUrl"] == "https://example/release"


def test_state_hides_a_cached_version_that_is_not_newer(live_server, monkeypatch):
    token = _create_admin(live_server)
    monkeypatch.setattr(server, "APP_VERSION", "2.0.0")
    import updates
    updates.write_cache(server.UPDATE_CACHE_PATH, "1.5.0", "https://example/release")
    status, body = _request(live_server, "GET", "/api/state", token=token)
    assert body["latestVersion"] is None


def test_state_hides_updates_when_the_check_is_switched_off(live_server, monkeypatch):
    token = _create_admin(live_server)
    monkeypatch.setattr(server, "APP_VERSION", "1.0.0")
    import updates
    updates.write_cache(server.UPDATE_CACHE_PATH, "1.5.0", "https://example/release")
    _request(live_server, "POST", "/api/settings", token=token, json_body={"checkUpdates": False})
    status, body = _request(live_server, "GET", "/api/state", token=token)
    assert body["latestVersion"] is None


def test_state_still_works_with_no_cache_at_all(live_server):
    # Офлайн-склад: GitHub недоступен, кэша нет — /api/state обязан отвечать как обычно.
    token = _create_admin(live_server)
    status, body = _request(live_server, "GET", "/api/state", token=token)
    assert status == 200
    assert body["latestVersion"] is None
    assert "assets" in body
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_server_auth.py -v -k "product_version or cached_version or switched_off or no_cache_at_all"`
Expected: FAIL — `KeyError: 'currentVersion'`.

- [ ] **Step 3: Implement**

Add `import updates` to `server.py`'s imports (рядом с `import migrations`).

Add near `check_updates_enabled()`:

```python
def current_update() -> dict | None:
    """Кэшированная новая версия, если она есть, новее текущей и проверка включена."""
    if not check_updates_enabled():
        return None
    cache = updates.read_cache(UPDATE_CACHE_PATH)
    latest = cache.get("latestVersion")
    if not updates.is_newer(latest, APP_VERSION):
        return None
    return {"version": latest, "url": cache.get("releaseUrl")}


def refresh_update_cache_if_due() -> None:
    """Спросить GitHub, если прошли сутки с последнего успешного запроса."""
    if not check_updates_enabled():
        return
    cache = updates.read_cache(UPDATE_CACHE_PATH)
    if not updates.should_check(cache, datetime.now(timezone.utc)):
        return
    updates.check_now(UPDATE_CACHE_PATH)


def start_background_update_check() -> None:
    """Проверка в фоне: старт сервера не должен ждать сети."""
    thread = threading.Thread(target=refresh_update_cache_if_due, daemon=True)
    thread.start()
```

Добавить `timezone` в существующий импорт: `from datetime import datetime, timezone`.

In `do_GET`, заменить обработку `/api/state`:

```python
        if parsed.path == "/api/state":
            state = export_state()
            state["currentVersion"] = APP_VERSION
            update = current_update()
            state["latestVersion"] = update["version"] if update else None
            state["releaseUrl"] = update["url"] if update else None
            start_background_update_check()
            self.send_json(state)
            return
```

In `main()`, после `init_db()`:

```python
    start_background_update_check()
```

In `warehouse_tray.py`, в `start_server()` после `server.init_db()`:

```python
            server.start_background_update_check()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_server_auth.py -v -k "product_version or cached_version or switched_off or no_cache_at_all"`
Expected: PASS

Run: `python -m pytest -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server.py warehouse_tray.py tests/test_server_auth.py
git commit -m "Task D3: expose current/latest version in /api/state, check GitHub in the background"
```

---

### Task D4: десктоп — плашка обновления и модалка «Настройки»

**Files:**
- Modify: `index.html`, `app.js`, `styles.css`

**Interfaces:**
- Consumes: `GET /api/state` (`currentVersion`/`latestVersion`/`releaseUrl`, Task D3), `GET`/`POST /api/settings` (Task D2), `apiFetch`, `showToast`, `escapeHtml`, `data-requires-role` (Этапы 1-2).

Автоматических тестов нет — `app.js`/`index.html` без тестовой обвязки (тот же прецедент, что Task C4 Этапа 2). Ручная проверка в Step 4 и в Task E2.

- [ ] **Step 1: Add markup to `index.html`**

Кнопка в сайдбаре, рядом с `showBackupsBtn` (блок «Сеанс»):

```html
        <button id="showSettingsBtn" class="secondary" data-requires-role="admin">Настройки</button>
```

Модалка рядом с `backupsOverlay`:

```html
  <div id="settingsOverlay" class="modal-overlay hidden">
    <div class="operation-modal">
      <div class="modal-header">
        <h3>Настройки</h3>
        <button type="button" class="modal-close" id="closeSettingsBtn">Закрыть</button>
      </div>
      <label class="checkbox-row">
        <input type="checkbox" id="checkUpdatesInput">
        Проверять обновления (раз в сутки, через интернет)
      </label>
      <p class="muted" id="currentVersionLabel"></p>
    </div>
  </div>
```

Плашка обновления — первым элементом внутри `<main class="content">`
(`index.html:102`), сразу после открывающего тега, чтобы она была видна на
любой вкладке:

```html
  <div id="updateBanner" class="update-banner hidden">
    <span id="updateBannerText"></span>
    <a id="updateBannerLink" href="#" target="_blank" rel="noopener">Открыть страницу загрузки</a>
    <button type="button" id="dismissUpdateBtn" class="ghost" title="Скрыть до перезапуска">✕</button>
  </div>
```

- [ ] **Step 2: Add styles to `styles.css`**

```css
/* ─── плашка обновления ──────────────────────────────────────── */
.update-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--accent-soft, #eef4ff);
  border-bottom: 1px solid var(--line, #d8e0ee);
  font-size: 13px;
}
.update-banner a { text-decoration: underline; }
.update-banner button { margin-left: auto; }
```

Перед вставкой проверить, определены ли `--accent-soft`/`--line` в `:root` этого файла; если каких-то нет — подставить конкретные цвета в стиле соседних правил, не вводя новых переменных.

- [ ] **Step 3: Wire up `app.js`**

Add near `openBackupsModal`:

```javascript
async function openSettingsModal() {
  const response = await apiFetch("/api/settings");
  const data = await response.json();
  document.getElementById("checkUpdatesInput").checked = Boolean(data.checkUpdates);
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
  document.getElementById("updateBannerLink").href =
    state.releaseUrl || "https://github.com/ssk1tlz/warehouse/releases";
  banner.classList.remove("hidden");
}
```

**Критично — иначе плашка не появится никогда.** `loadState()`
(`app.js:362`) пропускает ответ сервера через `hydrateState(parsed)`
(`app.js:321`), а та собирает **новый** объект по явному списку полей —
любое поле, не перечисленное в ней, молча теряется. Добавить три поля в
конец объекта, который возвращает `hydrateState`:

```javascript
    currentVersion: parsed.currentVersion || "",
    latestVersion: parsed.latestVersion || null,
    releaseUrl: parsed.releaseUrl || null,
```

И те же три поля со значениями `""`/`null`/`null` — в константу
`EMPTY_STATE` (её копирует `createEmptyState()`, `app.js:317`), чтобы
`state.latestVersion` не был `undefined` до первой загрузки.

Вызвать `renderUpdateBanner()` в `boot()` (`app.js:4587`) сразу после
существующего `applyRoleVisibility();` — перед `render();`.

Add to `bindEvents()`:

```javascript
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
  document.getElementById("dismissUpdateBtn")?.addEventListener("click", () => {
    updateBannerDismissed = true;
    renderUpdateBanner();
  });
```

- [ ] **Step 4: Manual verification**

Запустить сервер локально (`python server.py`), войти как admin:

1. Открыть «Настройки» — галочка «Проверять обновления» включена, показана текущая версия.
2. Снять галочку — тост подтверждения; перезагрузить страницу, открыть снова — галочка осталась снятой.
3. Подделать кэш, чтобы проверить плашку: включить галочку обратно, затем выполнить
   `python -c "import updates, paths; updates.write_cache(paths.UPDATE_CACHE_PATH, '99.0.0', 'https://github.com/ssk1tlz/warehouse/releases')"`,
   перезагрузить страницу — плашка «Доступна версия 99.0.0» видна, ссылка ведёт на страницу релизов, крестик её скрывает.
4. Убрать подделанный кэш: `python -c "import paths; paths.UPDATE_CACHE_PATH.unlink(missing_ok=True)"`.
5. Зайти под storekeeper — кнопки «Настройки» в сайдбаре нет.

- [ ] **Step 5: Commit**

```bash
git add index.html app.js styles.css
git commit -m "Task D4: add desktop settings modal and dismissible update banner"
```

---

### Task D5: мобильное — версия и плашка обновления

**Files:**
- Modify: `mobile/www/index.html`, `mobile/www/js/screens.js`, `mobile/www/js/db.js`, `mobile/www/style.css`
- Test: `mobile/tests/screens.test.js`

**Interfaces:**
- Consumes: `window.APP_VERSION` (Task B1), `latestVersion`/`releaseUrl` из `GET /api/state` (Task D3).
- Produces: `describeUpdate(state, currentVersion) -> {text, url} | null` — чистая функция, экспортируется из `screens.js` через уже существующий Node-guard (добавлен в Задаче D2 Этапа 2).

Телефон сам к GitHub не ходит: склад может быть без интернета, источник истины — сервер, данные приезжают обычной синхронизацией.

- [ ] **Step 1: Write the failing tests**

Add to `mobile/tests/screens.test.js`:

```javascript
test('describeUpdate returns banner text when the server reports a newer version', () => {
  const { describeUpdate } = require('../www/js/screens.js');
  const result = describeUpdate({ latestVersion: '1.5.0', releaseUrl: 'https://example/r' }, '1.0.0');
  assert.equal(result.url, 'https://example/r');
  assert.ok(result.text.includes('1.5.0'));
});

test('describeUpdate returns null when there is nothing newer', () => {
  const { describeUpdate } = require('../www/js/screens.js');
  assert.equal(describeUpdate({ latestVersion: '1.0.0' }, '1.0.0'), null);
  assert.equal(describeUpdate({ latestVersion: '0.9.0' }, '1.0.0'), null);
  assert.equal(describeUpdate({ latestVersion: null }, '1.0.0'), null);
  assert.equal(describeUpdate({}, '1.0.0'), null);
});

test('describeUpdate compares numerically, not alphabetically', () => {
  const { describeUpdate } = require('../www/js/screens.js');
  // '1.0.10' < '1.0.9' по строковому сравнению — но 10 новее 9.
  assert.ok(describeUpdate({ latestVersion: '1.0.10' }, '1.0.9') !== null);
  assert.equal(describeUpdate({ latestVersion: '1.0.9' }, '1.0.10'), null);
});

test('describeUpdate survives a malformed version without throwing', () => {
  const { describeUpdate } = require('../www/js/screens.js');
  assert.equal(describeUpdate({ latestVersion: 'мусор' }, '1.0.0'), null);
  assert.equal(describeUpdate({ latestVersion: '1.0.1' }, undefined), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test mobile/tests/screens.test.js`
Expected: FAIL — `describeUpdate is not a function`.

- [ ] **Step 3: Implement `describeUpdate` in `screens.js`**

Рядом с `describeScanError` (в самом верху файла):

```javascript
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
```

Add both to the existing Node export guard at the bottom of `screens.js`:

```javascript
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { describeScanError, describeUpdate };
}
```

- [ ] **Step 4: Store the version fields in the local cache**

В `mobile/www/js/db.js` таблицы для мета-полей нет (в `SCHEMA` только
`assets`, `employees`, `departments`, `sites`, `allocations`,
`pending_actions`, `movements`, `movements_history` — проверено). Добавить
новую таблицу в конец константы `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
```

Guarded-`ALTER` здесь **не нужен** (в отличие от `assets.rev` в Этапе 2):
там добавлялась колонка в уже существующую таблицу, а `CREATE TABLE IF NOT
EXISTS` для совершенно новой таблицы отрабатывает и на устройствах с уже
установленным кэшем — `open()` выполняет `db.execute(SCHEMA)` при каждом
запуске.

В `replaceState(state)`, внутри того же `executeTransaction`, где пишутся
остальные таблицы, добавить сохранение двух полей:

```javascript
    txn.push({
      statement: `INSERT OR REPLACE INTO meta (key, value) VALUES ('latestVersion', ?)`,
      values: [state.latestVersion || null],
    });
    txn.push({
      statement: `INSERT OR REPLACE INTO meta (key, value) VALUES ('releaseUrl', ?)`,
      values: [state.releaseUrl || null],
    });
```

И новую функцию рядом с `getAssetById`:

```javascript
async function getStateMeta() {
  const result = await db.query('SELECT key, value FROM meta');
  const meta = {};
  for (const row of result.values || []) meta[row.key] = row.value;
  return meta;
}
```

Добавить `getStateMeta` в список экспорта `window.Db = { ... }`
(`db.js:312`).

- [ ] **Step 5: Show version and banner on the settings screen**

In `mobile/www/index.html`, внутри `<section id="screen-settings">`, после кнопки сканирования QR:

```html
    <div id="updateBanner" class="update-banner hidden">
      <p id="updateBannerText"></p>
      <p class="muted" id="updateBannerUrl"></p>
    </div>
    <p class="muted" id="appVersionLabel"></p>
```

Ссылка показывается **текстом, а не `<a>`**: Capacitor WebView не гарантирует
открытие системного браузера без дополнительного плагина, а тянуть
`@capacitor/browser` ради одной ссылки — лишняя зависимость.

In `screens.js`, в обработчике `navSettingsBtn` (там, где уже заполняется
`settingsUrl`), добавить:

```javascript
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
```

In `mobile/www/style.css`:

```css
.update-banner {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface-3);
  border: 1px solid var(--line-2);
  margin-top: 12px;
}
```

(`--surface-3`/`--line-2` определены в `:root` этого файла — проверено при
исправлении контраста тостов в Этапе 2.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test mobile/tests/screens.test.js`
Expected: PASS

Run: `node --test mobile/tests/*.test.js`
Expected: PASS (весь мобильный набор)

- [ ] **Step 7: Commit**

```bash
git add mobile/www/index.html mobile/www/js/screens.js mobile/www/js/db.js mobile/www/style.css mobile/tests/screens.test.js
git commit -m "Task D5: show app version and update banner on the mobile settings screen"
```

---

## Задача E — документация выпуска и финальная верификация

### Task E1: `docs/RELEASING.md`

**Files:**
- Create: `docs/RELEASING.md`

**Interfaces:**
- Consumes: всё, что сделано в задачах A-D.

- [ ] **Step 1: Write the release guide**

Create `docs/RELEASING.md` со следующими разделами (каждый — с реальными командами, не описаниями):

1. **Что такое релиз** — один тег `vX.Y.Z` = установщик Windows + подписанный APK, оба из одного коммита; версия во всех артефактах одна и берётся из `VERSION`.
2. **Разовая подготовка: ключ подписи Android** — команда `keytool -genkeypair` (как в Task C2), где хранить `.jks` (вне репозитория), как заполнить `keystore.properties` из `keystore.properties.example`. Явно: **потеря ключа означает, что обновления приложения не установятся поверх старых** — Android требует ту же подпись; хранить копию ключа в надёжном месте.
3. **Разовая подготовка: Inno Setup** — `winget install -e --id JRSoftware.InnoSetup`.
4. **Выпуск новой версии** — по шагам:
   ```bash
   python bump_version.py patch     # или minor / major
   python -m pytest -q
   node --test mobile/tests/*.test.js
   git add VERSION mobile/www/js/version.js mobile/android/version.properties
   git commit -m "release: vX.Y.Z"
   installer\build_installer.bat
   cd mobile && npx cap sync android && cd android && gradlew.bat assembleRelease
   git tag vX.Y.Z && git push origin master --tags
   gh release create vX.Y.Z installer/output/WarehouseSetup-X.Y.Z.exe mobile/android/app/build/outputs/apk/release/app-release.apk --title "vX.Y.Z" --notes "..."
   ```
   С пояснением, что `npx cap sync android` **обязателен** перед сборкой APK: без него Gradle упакует устаревший JS (эта ошибка уже случалась в конце Этапа 1).
5. **Что видит пользователь** — плашка «Доступна версия X» появляется у тех, у кого проверка обновлений включена, в течение суток после публикации релиза; ссылка ведёт на страницу релиза, скачивание и установка — вручную.
6. **Предупреждение SmartScreen** — почему появляется (нет платного сертификата подписи кода), как пройти («Подробнее» → «Выполнить в любом случае»), и что покупка сертификата снимет его позже.
7. **Ограничения** — `versionCode` требует `minor` и `patch` меньше 100; тег релиза обязан быть строго `vX.Y.Z`, иначе проверка обновлений его проигнорирует (это защита от «nightly»-тегов, а не ошибка).

- [ ] **Step 2: Verify every command in the guide is real**

Пройти по документу и сверить каждую команду с тем, что реально существует
в репозитории после задач A-D (имена файлов, флаги, пути к артефактам).
Любая команда, которую нельзя выполнить как написано, — дефект документа.

- [ ] **Step 3: Commit**

```bash
git add docs/RELEASING.md
git commit -m "Task E1: document the end-to-end release process"
```

---

### Task E2: финальная верификация этапа

**Files:** none (проверка)

- [ ] **Step 1: Full backend suite**

Run: `python -m pytest -q`
Expected: все тесты зелёные (записать фактическое число).

- [ ] **Step 2: Full mobile suite**

Run: `node --test mobile/tests/*.test.js`
Expected: все тесты зелёные.

- [ ] **Step 3: Version files in sync**

Run: `python bump_version.py --check`
Expected: `Версия 1.0.0, все файлы в синхроне.`

- [ ] **Step 4: Build the installer**

Run: `installer\build_installer.bat`
Expected: `installer\output\WarehouseSetup-1.0.0.exe` создан.

- [ ] **Step 5: Build the signed release APK**

Run:
```bash
cd mobile
npx cap sync android
cd android
./gradlew.bat assembleRelease
```
Expected: BUILD SUCCESSFUL; `mobile/android/app/build/outputs/apk/release/app-release.apk` существует.

Проверить, что новый код реально попал в артефакт (не полагаться на успех сборки):

Run: `grep -c "describeUpdate\|APP_VERSION" mobile/android/app/src/main/assets/public/js/screens.js mobile/android/app/src/main/assets/public/js/version.js`
Expected: ненулевые значения.

Проверить подпись:

Run: `keytool -printcert -jarfile mobile/android/app/build/outputs/apk/release/app-release.apk`
Expected: `CN=Warehouse`, не `CN=Android Debug`.

- [ ] **Step 6: Acceptance criterion 2 — миграция реальной базы**

Самый важный ручной тест этапа. На **копии** реальной базы:

```bash
mkdir -p /c/Temp/warehouse_migration_test
cp warehouse.db /c/Temp/warehouse_migration_test/
python -c "
import sqlite3
c = sqlite3.connect(r'C:\Temp\warehouse_migration_test\warehouse.db')
print('активов до миграции:', c.execute('SELECT COUNT(*) FROM assets').fetchone()[0])
print('сотрудников до миграции:', c.execute('SELECT COUNT(*) FROM employees').fetchone()[0])
"
```

Затем прогнать миграцию с подменой путей на временные и сверить, что числа
совпали, а исходный файл переименован в `.migrated`. Записать оба числа в
отчёт.

- [ ] **Step 7: Acceptance criteria walk-through**

Свериться с пятью критериями из спеки:

1. Чистая установка → база в `ProgramData`, деинсталляция данные не трогает — проверено вручную в Task B2 Step 5; повторить кратко на свежесобранном установщике.
2. Миграция старой базы без потерь — Step 6 выше.
3. `assembleRelease` даёт подписанный APK — Step 5 выше. Установку на реальный телефон выполнить, если устройство доступно; если нет — зафиксировать в отчёте как непроверенное вживую (подпись и сборка проверены).
4. Плашка обновления появляется и не мешает офлайн-работе — проверено вручную в Task D4 Step 4; дополнительно убедиться, что при выдернутом интернете приложение стартует без задержек (фоновая проверка не блокирует).
5. `docs/RELEASING.md` описывает выпуск от и до — Task E1.

Любое расхождение — дефект, а не «особенность»: зафиксировать и починить, не закрывать задачу с необработанным пробелом.

- [ ] **Step 8: Commit** (только если Steps 1-7 потребовали правки кода; иначе у задачи своего коммита нет — это проверочный шлюз над коммитами задач A1-E1)
