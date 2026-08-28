import shutil
import sqlite3
import sys
from pathlib import Path

import pytest

import paths
import server


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
    #
    # Соединение-писатель нарочно остаётся открытым во время вызова
    # migrate_legacy_data(): это одновременно и создаёт -wal (без чекпоинта),
    # и воспроизводит реальный сценарий — старая копия программы всё ещё
    # держит warehouse.db открытым. На Windows это не даёт переименовать
    # исходный файл (_retire_legacy_file ловит PermissionError и не падает);
    # проверяется здесь только то, что копирование данных всё равно
    # прошло успешно и вернулось True — попытка переименования исходника
    # покрыта отдельным тестом ниже, где соединений нет.
    old_root, new_data = legacy_layout
    db_path = old_root / "warehouse.db"
    _make_db(db_path, "checkpointed")
    writer = sqlite3.connect(db_path)
    writer.execute("PRAGMA journal_mode = WAL")
    writer.execute("INSERT INTO marker VALUES ('only-in-wal')")
    writer.commit()
    assert (old_root / "warehouse.db-wal").exists(), "тест бессмыслен без -wal файла"

    try:
        assert paths.migrate_legacy_data(server._copy_database) is True
    finally:
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
