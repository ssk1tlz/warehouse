import sqlite3

import pytest

import asset_codes


ASSETS_SCHEMA = """
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  inventory_number TEXT
);
"""


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.executescript(ASSETS_SCHEMA)
    yield connection
    connection.close()


def add_asset(connection, asset_id, inventory_number, category="", name=""):
    connection.execute(
        "INSERT INTO assets (id, name, category, inventory_number) VALUES (?, ?, ?, ?)",
        (asset_id, name, category, inventory_number),
    )


# Пары "категория / наименование" взяты из живой базы (203 единицы), по одной
# на каждое из обозначений справочника — чтобы правила проверялись на том, что
# реально введено, а не на придуманных строках.
@pytest.mark.parametrize(
    "category,name,expected",
    [
        ("Системный блок", "Gigabyte Technology CO., Ltd. / H610M K DDR4", "PC"),
        ("ПК - моноблок", "HP / HP All-in-One 27-dp1xxx", "AIO"),
        ("Ноутбук", "HP / HP Laptop 15-fd0xxx", "NB"),
        ("Планшет", "Samsung Galaxy Tab A11 8/128 Gray", "TAB"),
        ("Сервер", "Сервер (DC, Web, RDS)", "SVR"),
        ("Монитор", "Samsung / S27E332H", "MON"),
        ("Проводная клавиатура", "A4Tech / KR-85", "KEY"),
        ("Беспроводная Клавиатура", "rapoo / model K1800Pro", "KEY"),
        ("Беспроводная компьютерная клавиатура", "rapoo", "KEY"),
        ("Проводная компьютерная мышь", "A4Tech / OP-6200", "MUS"),
        ("Беспроводная компьютерная мышь", "rapoo / model 1190", "MUS"),
        ("Веб-камера", "Kisonli / HD 480p", "CAM"),
        ("Проводные наушники", "rapoo VPRO VH530", "HPH"),
        ("Акустическая система", "Kisonli / A-707", "SPK"),
        ("Колонки", "Microlab Multimedia Speaker / M-290", "SPK"),
        ("Принтер / Сканер", "EPSON / M2140", "MFP"),
        ("Принтер", "EPSON / L3200", "PRN"),
        ("Цветной принтер", "EPSON / L3560", "PRN"),
        ("Сканер", "CANON imageFORMULA DR-C240", "SCN"),
        ("Плоттер", "EPSON SureColor SC-T3200 (Без подставки)", "PLT"),
        ("Cетевой видеорегистратор", "HIKVIISON / DS-9664NI-M8", "NVR"),
        ("4-х канальный IP-видеорегистратор", "HIKVISION / DS-7604NI-K1", "NVR"),
        ("Потолочная точка доступа", "Ruijie RG-RAP62 AX1800", "AP"),
        ("Коммутатор", "Slim PoE Switch", "SW"),
        ("PoE-коммутатор (свитч)", "Ruijie RG-ES206GS-P", "SW"),
        ("Коммутатор-свитч", "Bazis / 4 RJ45 порта", "SW"),
        ("Роутер", "Tp-Link / Archer A8", "RTR"),
        ("Двухдиапазонный Wi-Fi роутер", "Tp-Link / Archer C20", "RTR"),
        ("Роутер Gpon", "Tp-Link XX530v AX3000", "RTR"),
        ("Стационарный телефон", "Panasonic / KX-TSC507CID", "TEL"),
        ("Источники бесперебойного питания", "UPS ED2000", "UPS"),
        ("Система бесперебойного питания", "HIKVIISON / DS-UPS1000", "UPS"),
        ("Автоматический регулятор напряжения", "Stabik / Slim UKM-3000", "AVR"),
        ("Кондиционер", "Gree / GWH24AGD-K6DNA1C/I", "AC"),
        ("Холодильник", "Artel HS 117 RN Eco-Frost Mini", "REF"),
        ("Куллер", "Rulls", "WC"),
        ("Кофемашина", "Geepas", "CFM"),
        ("Электрический чайник", "Model: A19(A)", "KTL"),
        ("Телевизор", "Brando LED43D19A", "TV"),
    ],
)
def test_guess_prefix_recognises_real_categories(category, name, expected):
    assert asset_codes.guess_prefix(category, name) == expected


def test_printer_scanner_beats_plain_printer():
    # "Принтер / Сканер" содержит слово "принтер", поэтому правило PRN
    # перехватило бы его, стой оно раньше MFP в списке.
    assert asset_codes.guess_prefix("Принтер / Сканер", "CANON / MF3010") == "MFP"


def test_all_in_one_beats_desktop():
    # "ПК - моноблок" содержит "пк" — правило PC перехватило бы его.
    assert asset_codes.guess_prefix("ПК - моноблок", "AVTECH A I O PC") == "AIO"


def test_double_space_in_category_still_matches():
    # В базе есть и "Принтер / Сканер", и "Принтер  Сканер" (два пробела).
    assert asset_codes.guess_prefix("Принтер  Сканер", "EPSON / M2110") == "MFP"


def test_latin_k_in_commutator_still_matches():
    # "Kоммутатор" в базе набран с латинской K.
    assert asset_codes.guess_prefix("Kоммутатор", "NETIS / ST3108GS") == "SW"


def test_yo_is_normalised():
    assert asset_codes.guess_prefix("Кулер для воды", "Ugur") == "WC"


def test_type_recognised_from_name_when_category_is_useless():
    # UPS-0004 в базе: категория "Периферийные устройства", тип виден только
    # по названию.
    assert asset_codes.guess_prefix("Периферийные устройства", "Источник Бесперебойного Питания") == "UPS"


def test_ups_named_avr_is_not_mistaken_for_a_voltage_regulator():
    # В базе ИБП называется "UPS (ИБП) AVT-650 AVR, 650ВА, [EA265]" — слово
    # AVR в названии не должно перевесить категорию.
    assert asset_codes.guess_prefix(
        "Источники бесперебойного питания", "UPS (ИБП) AVT-650 AVR, 650ВА, [EA265]"
    ) == "UPS"


def test_short_latin_keywords_match_whole_words_only():
    # "tv" внутри "AVTECH" не делает монитор телевизором.
    assert asset_codes.guess_prefix("Монитор", "AVTECH / IPS LED PRO3000 27CD Curved") == "MON"


def test_unknown_type_falls_back_to_inv():
    assert asset_codes.guess_prefix("Ковёр", "Персидский, 2х3") == "INV"


def test_empty_input_falls_back_to_inv():
    assert asset_codes.guess_prefix("", "") == "INV"


def test_next_number_on_empty_database_is_one(conn):
    assert asset_codes.next_number(conn) == 1


def test_next_number_continues_after_prefixed_numbers(conn):
    add_asset(conn, "a1", "NB-0021")
    add_asset(conn, "a2", "SCN-0029")
    assert asset_codes.next_number(conn) == 30


def test_next_number_counts_bare_numbers_too(conn):
    # До миграции 028 в базе соседствуют оба формата, и голый "181" —
    # настоящий максимум, хотя префиксные номера доходят только до 0029.
    add_asset(conn, "a1", "181")
    add_asset(conn, "a2", "SCN-0029")
    assert asset_codes.next_number(conn) == 182


def test_next_number_ignores_empty_and_unparsable_numbers(conn):
    add_asset(conn, "a1", "NB-0007")
    add_asset(conn, "a2", "")
    add_asset(conn, "a3", "без номера")
    assert asset_codes.next_number(conn) == 8


def test_assign_inventory_number_pads_to_four_digits(conn):
    add_asset(conn, "a1", "MON-0050")
    assert asset_codes.assign_inventory_number(conn, "Ноутбук", "Lenovo / 82XQ") == "NB-0051"


def test_assign_inventory_number_on_empty_database(conn):
    assert asset_codes.assign_inventory_number(conn, "Сервер", "Сервер (DC)") == "SVR-0001"


def test_consecutive_assignments_do_not_repeat(conn):
    first = asset_codes.assign_inventory_number(conn, "Ноутбук", "HP")
    add_asset(conn, "a1", first)
    second = asset_codes.assign_inventory_number(conn, "Монитор", "Samsung")
    assert (first, second) == ("NB-0001", "MON-0002")


def test_reference_exposes_every_prefix_with_a_label():
    reference = asset_codes.reference()
    prefixes = [entry["prefix"] for entry in reference]
    assert len(prefixes) == len(set(prefixes)), "префиксы в справочнике не должны повторяться"
    assert "NB" in prefixes
    for entry in reference:
        assert entry["label"], f"у обозначения {entry['prefix']} нет названия"
        assert entry["keywords"], f"у обозначения {entry['prefix']} нет ключевых слов"


def test_reference_order_matches_rules_order():
    # Справочник отдаётся клиентам и там используется для той же догадки,
    # поэтому порядок обязан совпадать с порядком правил.
    assert [entry["prefix"] for entry in asset_codes.reference()] == [
        prefix for prefix, _label, _keywords in asset_codes.ASSET_CODE_RULES
    ]
