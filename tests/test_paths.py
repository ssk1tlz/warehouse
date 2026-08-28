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
