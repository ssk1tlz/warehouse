"""Сверка двух реализаций сопоставления: asset_codes.py и asset_codes.js.

Десктоп сохраняет придуманный им номер как есть, а миграция и мобильные
действия считают префикс на сервере. Разойдись алгоритмы — техника молча
получила бы не ту букву в форме и другую при перенумерации. Тест гоняет
обе реализации по одному корпусу и требует совпадения до единого ответа.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

import asset_codes

ROOT = Path(__file__).resolve().parent.parent

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None,
    reason="node не установлен — сверка с asset_codes.js пропущена",
)


# Реальные категории из базы (203 единицы, 44 различных значения) со всем
# их разнобоем: латинская K, двойные пробелы, "Без категории".
REAL_CATEGORIES = [
    "Монитор", "Системный блок", "Проводная компьютерная мышь", "Принтер / Сканер",
    "Проводная клавиатура", "Беспроводная компьютерная мышь", "Акустическая система",
    "Роутер", "Ноутбук", "Кондиционер", "Принтер", "Источники бесперебойного питания",
    "Беспроводная Клавиатура", "ПК - моноблок", "Куллер", "Планшет", "Сервер",
    "Холодильник", "Телевизор", "Сканер", "Cетевой видеорегистратор", "Веб-камера",
    "Колонки", "Проводные наушники", "PoE-коммутатор (свитч)", "Потолочная точка доступа",
    "Коммутатор-свитч", "Цветной принтер", "Принтер  Сканер", "Плоттер", "Кофемашина",
    "Система бесперебойного питания", "4-х канальный IP-видеорегистратор",
    "Электрический чайник", "Kоммутатор", "Без категории", "Стационарный телефон",
    "Коммутатор", "Автоматический регулятор напряжения", "Двухдиапазонный Wi-Fi роутер",
    "Роутер Gpon", "Беспроводная компьютерная клавиатура", "Периферийные устройства",
    "Ноутбук Acer lite 15", "Ковёр", "",
]

# Названия, на которых алгоритмы легче всего разойтись: тип виден только в
# названии, короткие латинские ключи внутри чужих слов, ложные срабатывания.
TRICKY_NAMES = [
    "Источник Бесперебойного Питания",
    "UPS (ИБП) AVT-650 AVR, 650ВА, [EA265]",
    "AVTECH / IPS LED PRO3000 27CD Curved",
    "Opical Network Terminal",
    "HP / HP All-in-One 27-dp1xxx",
    "Ruijie RG-ES206GS-P 4-Port PoE+ Cloude Managed Switch",
    "Samsung Galaxy Tab A11 8/128 Gray",
    "Принтер EPSON L3560",
    "Groups of things",
    "",
]

JS_DRIVER = """
const { guessAssetPrefix } = require(process.argv[1]);
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const { codeTypes, cases } = JSON.parse(input);
  process.stdout.write(JSON.stringify(
    cases.map(([category, name]) => guessAssetPrefix(codeTypes, category, name))
  ));
});
"""


def _corpus():
    cases = [(category, "") for category in REAL_CATEGORIES]
    cases += [("", name) for name in TRICKY_NAMES]
    cases += [(category, name) for category in REAL_CATEGORIES[:12] for name in TRICKY_NAMES[:6]]
    # Каждое ключевое слово справочника — и само по себе, и внутри фразы,
    # чтобы новое правило автоматически попадало в сверку.
    for _prefix, _label, keywords in asset_codes.ASSET_CODE_RULES:
        for keyword in keywords:
            cases.append((keyword, ""))
            cases.append((keyword.upper(), ""))
            cases.append(("", f"Модель {keyword} 2024"))
            cases.append(("", f"x{keyword}"))
    return cases


def _js_prefixes(cases):
    payload = json.dumps({"codeTypes": asset_codes.reference(), "cases": cases})
    result = subprocess.run(
        ["node", "-e", JS_DRIVER, str(ROOT / "asset_codes.js")],
        input=payload, capture_output=True, text=True, encoding="utf-8", check=True,
    )
    return json.loads(result.stdout)


def test_javascript_and_python_agree_on_every_case():
    cases = _corpus()
    expected = [asset_codes.guess_prefix(category, name) for category, name in cases]
    actual = _js_prefixes(cases)

    disagreements = [
        (category, name, py, js)
        for (category, name), py, js in zip(cases, expected, actual)
        if py != js
    ]
    assert not disagreements, "алгоритмы разошлись:\n" + "\n".join(
        f"  {category!r} / {name!r}: python={py} js={js}"
        for category, name, py, js in disagreements
    )


def test_corpus_actually_exercises_most_of_the_reference():
    # Страховка от бессмысленно зелёной сверки: если корпус перестал
    # покрывать справочник, тест выше ничего не доказывает.
    covered = {asset_codes.guess_prefix(category, name) for category, name in _corpus()}
    covered.discard(asset_codes.FALLBACK_PREFIX)
    assert len(covered) == len(asset_codes.ASSET_CODE_RULES)
