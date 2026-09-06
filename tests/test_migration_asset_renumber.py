"""Тесты разовой перенумерации инвентарных номеров (миграция 028)."""

import sqlite3

import pytest

import migrations


SCHEMA = """
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  inventory_number TEXT,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
"""


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA)
    yield connection
    connection.close()


def add(connection, asset_id, inventory_number, category="", name="", rev=0):
    connection.execute(
        "INSERT INTO assets (id, name, category, inventory_number, rev) VALUES (?, ?, ?, ?, ?)",
        (asset_id, name, category, inventory_number, rev),
    )


def numbers(connection):
    return {
        row["id"]: row["inventory_number"]
        for row in connection.execute("SELECT id, inventory_number FROM assets")
    }


def state_version(connection):
    row = connection.execute("SELECT value FROM app_meta WHERE key = 'state_version'").fetchone()
    return int(row["value"]) if row else 0


def test_bare_number_gets_a_prefix_from_its_type(conn):
    add(conn, "a1", "001", "Системный блок", "Gigabyte / H610M")
    migrations._migrate_028_asset_code_renumber(conn)
    assert numbers(conn)["a1"] == "PC-0001"


def test_bare_numbers_keep_their_relative_order(conn):
    add(conn, "a1", "005", "Ноутбук", "HP Laptop")
    add(conn, "a2", "001", "Монитор", "Samsung")
    add(conn, "a3", "181", "Ноутбук", "Acer lite 15")
    migrations._migrate_028_asset_code_renumber(conn)
    assert numbers(conn) == {"a2": "MON-0001", "a1": "NB-0002", "a3": "NB-0003"}


def test_manual_prefixes_are_preserved_and_moved_to_the_end(conn):
    add(conn, "bare", "001", "Монитор", "Samsung")
    add(conn, "srv", "SVR-0001", "Сервер", "Сервер (DC, Web, RDS)")
    migrations._migrate_028_asset_code_renumber(conn)
    assert numbers(conn) == {"bare": "MON-0001", "srv": "SVR-0002"}


def test_manual_prefix_survives_even_when_it_contradicts_the_rules(conn):
    # RTR-0007 в базе — "Без категории" / "Opical Network Terminal", а
    # UPS-0004 лежит в категории "Периферийные устройства". Буквы
    # проставлены вручную осознанно, миграция их не пересматривает.
    add(conn, "rtr", "RTR-0007", "Без категории", "Opical Network Terminal")
    add(conn, "ups", "UPS-0004", "Периферийные устройства", "Источник Бесперебойного Питания")
    migrations._migrate_028_asset_code_renumber(conn)
    assert numbers(conn) == {"ups": "UPS-0001", "rtr": "RTR-0002"}


def test_mfp_marked_by_hand_on_a_plain_printer_stays_mfp(conn):
    # По правилам категория "Принтер" даёт PRN, но пользователь знает, что
    # EPSON L3560 — это МФУ, и поставил MFP руками.
    add(conn, "p", "MFP-0023", "Принтер", "Принтер EPSON L3560")
    migrations._migrate_028_asset_code_renumber(conn)
    assert numbers(conn)["p"] == "MFP-0001"


def test_numbering_is_continuous_with_no_gaps(conn):
    # Дыры в исходных номерах (нет 002 и 004) не переносятся в результат.
    add(conn, "a1", "001", "Монитор", "")
    add(conn, "a2", "003", "Монитор", "")
    add(conn, "a3", "005", "Монитор", "")
    migrations._migrate_028_asset_code_renumber(conn)
    assert sorted(numbers(conn).values()) == ["MON-0001", "MON-0002", "MON-0003"]


def test_every_number_is_unique_after_renumbering(conn):
    # Голый "001" и SVR-0001 — одно и то же число у разных единиц; ровно
    # эту коллизию миграция и разводит.
    add(conn, "a1", "001", "Монитор", "")
    add(conn, "a2", "SVR-0001", "Сервер", "")
    add(conn, "a3", "002", "Ноутбук", "")
    add(conn, "a4", "SVR-0002", "Сервер", "")
    migrations._migrate_028_asset_code_renumber(conn)
    assigned = list(numbers(conn).values())
    assert len(assigned) == len(set(assigned))


def test_unnumbered_assets_are_numbered_last(conn):
    add(conn, "a1", "", "Монитор", "Samsung")
    add(conn, "a2", "001", "Ноутбук", "HP")
    migrations._migrate_028_asset_code_renumber(conn)
    assert numbers(conn) == {"a2": "NB-0001", "a1": "MON-0002"}


def test_rev_grows_on_changed_rows(conn):
    add(conn, "a1", "001", "Монитор", "", rev=3)
    migrations._migrate_028_asset_code_renumber(conn)
    row = conn.execute("SELECT rev FROM assets WHERE id = 'a1'").fetchone()
    assert row["rev"] == 4


def test_state_version_grows_so_an_open_desktop_reloads(conn):
    conn.execute("INSERT INTO app_meta (key, value) VALUES ('state_version', '7')")
    add(conn, "a1", "001", "Монитор", "")
    migrations._migrate_028_asset_code_renumber(conn)
    assert state_version(conn) == 8


def test_running_twice_changes_nothing_the_second_time(conn):
    add(conn, "a1", "001", "Монитор", "")
    add(conn, "a2", "SVR-0001", "Сервер", "")
    migrations._migrate_028_asset_code_renumber(conn)
    after_first = numbers(conn)
    revs_first = dict(conn.execute("SELECT id, rev FROM assets"))
    version_first = state_version(conn)

    migrations._migrate_028_asset_code_renumber(conn)

    assert numbers(conn) == after_first
    assert dict(conn.execute("SELECT id, rev FROM assets")) == revs_first
    assert state_version(conn) == version_first


def test_already_correct_database_is_left_untouched(conn):
    add(conn, "a1", "MON-0001", "Монитор", "", rev=2)
    migrations._migrate_028_asset_code_renumber(conn)
    row = conn.execute("SELECT inventory_number, rev FROM assets WHERE id = 'a1'").fetchone()
    assert (row["inventory_number"], row["rev"]) == ("MON-0001", 2)


def test_runs_on_a_legacy_database_without_app_meta():
    # app_meta заводит schema.sql, но run_migrations вызывают и на
    # соединениях, которые его не видели — так мигрируют старую базу.
    # Соседние миграции 015-016 по той же причине проверяют наличие таблиц.
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(
        "CREATE TABLE assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT,"
        " inventory_number TEXT, rev INTEGER NOT NULL DEFAULT 0);"
    )
    add(connection, "a1", "001", "Монитор", "Samsung")

    migrations._migrate_028_asset_code_renumber(connection)

    assert numbers(connection)["a1"] == "MON-0001"
    connection.close()


def test_legacy_assets_table_without_inventory_number_is_skipped():
    # Самая старая форма таблицы: только id, name, quantity. schema.sql её
    # не чинит — CREATE TABLE IF NOT EXISTS пропускает существующую
    # таблицу, а колонки inventory_number/category не добавляет ни одна
    # миграция. Нумеровать тут нечего, но и падать нельзя.
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(
        "CREATE TABLE assets (id TEXT PRIMARY KEY, name TEXT NOT NULL,"
        " quantity INTEGER NOT NULL DEFAULT 1, rev INTEGER NOT NULL DEFAULT 0);"
        "INSERT INTO assets (id, name, quantity) VALUES ('ast_1', 'Ноутбук', 3);"
    )

    migrations._migrate_028_asset_code_renumber(connection)

    assert connection.execute("SELECT name FROM assets WHERE id='ast_1'").fetchone()["name"] == "Ноутбук"
    connection.close()


def test_assets_table_without_category_still_renumbers_by_name():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(
        "CREATE TABLE assets (id TEXT PRIMARY KEY, name TEXT NOT NULL,"
        " inventory_number TEXT, rev INTEGER NOT NULL DEFAULT 0);"
        "INSERT INTO assets (id, name, inventory_number) VALUES ('a1', 'Ноутбук HP', '001');"
    )

    migrations._migrate_028_asset_code_renumber(connection)

    assert numbers(connection)["a1"] == "NB-0001"
    connection.close()


def test_empty_database_does_not_crash(conn):
    migrations._migrate_028_asset_code_renumber(conn)
    assert numbers(conn) == {}


def test_migration_is_registered_in_the_list():
    versions = [version for version, _name, _func in migrations.MIGRATIONS]
    assert 28 in versions
    assert versions == sorted(versions), "миграции должны идти по возрастанию версии"
