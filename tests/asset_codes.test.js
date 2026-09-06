const test = require('node:test');
const assert = require('node:assert/strict');
const { guessAssetPrefix, nextAssetNumber, buildInventoryNumber, FALLBACK_PREFIX } = require('../asset_codes.js');

// Справочник приезжает с сервера полем assetCodeTypes; здесь взят срез
// реальных правил, сохраняющий важный порядок (AIO перед PC, MFP перед
// PRN, UPS перед AVR).
const RULES = [
  { prefix: 'AIO', label: 'ПК-моноблок', keywords: ['моноблок', 'all-in-one'] },
  { prefix: 'PC', label: 'Системный блок', keywords: ['системный блок', 'пк'] },
  { prefix: 'NB', label: 'Ноутбук', keywords: ['ноутбук', 'laptop'] },
  { prefix: 'MON', label: 'Монитор', keywords: ['монитор', 'monitor'] },
  { prefix: 'KEY', label: 'Клавиатура', keywords: ['клавиатура', 'keyboard'] },
  { prefix: 'MFP', label: 'МФУ', keywords: ['принтер / сканер', 'принтер сканер', 'мфу'] },
  { prefix: 'PRN', label: 'Принтер', keywords: ['принтер', 'printer'] },
  { prefix: 'SW', label: 'Коммутатор', keywords: ['коммутатор', 'kоммутатор', 'свитч'] },
  { prefix: 'WC', label: 'Кулер для воды', keywords: ['куллер', 'кулер'] },
  { prefix: 'UPS', label: 'ИБП', keywords: ['бесперебойн', 'ибп', 'ups'] },
  { prefix: 'AVR', label: 'Стабилизатор напряжения', keywords: ['регулятор напряжения', 'avr'] },
  { prefix: 'TV', label: 'Телевизор', keywords: ['телевизор', 'tv'] },
];

// ─── guessAssetPrefix ────────────────────────────────────────────

test('распознаёт тип по категории', () => {
  assert.equal(guessAssetPrefix(RULES, 'Ноутбук', 'HP / HP Laptop 15-fd0xxx'), 'NB');
});

test('категория важнее слов в названии', () => {
  // Без приоритета категории побеждало бы правило, стоящее раньше в
  // списке: PC раньше KEY, и клавиатура стала бы системным блоком.
  assert.equal(guessAssetPrefix(RULES, 'Проводная клавиатура', 'A4Tech KR-85 для ПК'), 'KEY');
});

test('распознаёт тип по названию, когда категория бесполезна', () => {
  // UPS-0004 в базе: категория "Периферийные устройства".
  assert.equal(
    guessAssetPrefix(RULES, 'Периферийные устройства', 'Источник Бесперебойного Питания'),
    'UPS'
  );
});

test('МФУ выигрывает у принтера', () => {
  assert.equal(guessAssetPrefix(RULES, 'Принтер / Сканер', 'CANON / MF3010'), 'MFP');
});

test('моноблок выигрывает у системного блока', () => {
  assert.equal(guessAssetPrefix(RULES, 'ПК - моноблок', 'AVTECH A I O PC'), 'AIO');
});

test('двойной пробел в категории не мешает', () => {
  assert.equal(guessAssetPrefix(RULES, 'Принтер  Сканер', 'EPSON / M2110'), 'MFP');
});

test('латинская K в "Kоммутатор" не мешает', () => {
  assert.equal(guessAssetPrefix(RULES, 'Kоммутатор', 'NETIS / ST3108GS'), 'SW');
});

test('ё приводится к е', () => {
  assert.equal(guessAssetPrefix(RULES, 'Кулер для воды', 'Ugur'), 'WC');
});

test('ИБП с "AVR" в названии не становится стабилизатором', () => {
  // В базе ИБП называется "UPS (ИБП) AVT-650 AVR, 650ВА, [EA265]".
  assert.equal(
    guessAssetPrefix(RULES, 'Источники бесперебойного питания', 'UPS (ИБП) AVT-650 AVR, 650ВА, [EA265]'),
    'UPS'
  );
});

test('короткие латинские ключи ищутся по границе слова', () => {
  // "ups" внутри "groups" не должно давать ИБП. Проверять надо именно на
  // строке, где больше нечему сработать: у "Монитор / AVTECH" правило MON
  // стоит раньше TV и выигрывает даже без всякой границы, так что такой
  // случай проходит и со сломанным сопоставлением.
  assert.equal(guessAssetPrefix(RULES, '', 'Groups of things'), FALLBACK_PREFIX);
});

test('граница слова нужна и кириллическим ключам', () => {
  // \b в JS не работает для кириллицы, поэтому граница задана вручную —
  // без неё "пк" нашлось бы внутри произвольного слова.
  assert.equal(guessAssetPrefix(RULES, '', 'Стойка упковочная'), FALLBACK_PREFIX);
});

test('ключ в самом начале строки всё же находится', () => {
  // Обратная сторона границы слева: в начале строки её нет физически,
  // и наивная реализация перестала бы узнавать первое же слово.
  assert.equal(guessAssetPrefix(RULES, '', 'Ноутбук HP'), 'NB');
});

test('неизвестный тип даёт запасное обозначение', () => {
  assert.equal(guessAssetPrefix(RULES, 'Ковёр', 'Персидский, 2х3'), FALLBACK_PREFIX);
});

test('пустой ввод даёт запасное обозначение', () => {
  assert.equal(guessAssetPrefix(RULES, '', ''), FALLBACK_PREFIX);
});

test('пустой справочник не роняет подстановку', () => {
  // До первой синхронизации assetCodeTypes может ещё не приехать.
  assert.equal(guessAssetPrefix([], 'Ноутбук', 'HP'), FALLBACK_PREFIX);
});

// ─── nextAssetNumber ─────────────────────────────────────────────

test('на пустом списке следующий номер — первый', () => {
  assert.equal(nextAssetNumber([]), 1);
});

test('продолжает от максимума среди префиксных номеров', () => {
  assert.equal(nextAssetNumber(['NB-0021', 'SCN-0029', 'MON-0008']), 30);
});

test('учитывает и голые номера', () => {
  // До миграции 028 форматы соседствуют, и максимум — как раз голый.
  assert.equal(nextAssetNumber(['181', 'SCN-0029']), 182);
});

test('пропускает пустые и неразбираемые номера', () => {
  assert.equal(nextAssetNumber(['NB-0007', '', null, undefined, 'без номера']), 8);
});

// ─── buildInventoryNumber ────────────────────────────────────────

test('собирает номер с дополнением до четырёх цифр', () => {
  assert.equal(buildInventoryNumber(RULES, ['MON-0050'], 'Ноутбук', 'Lenovo / 82XQ'), 'NB-0051');
});

test('номер тянется из общего списка, а не из своего типа', () => {
  // Ровно то, ради чего всё делается: ноутбуков в базе нет, но номер
  // продолжает общую нумерацию, а не начинается заново с NB-0001.
  assert.equal(buildInventoryNumber(RULES, ['MON-0050'], 'Ноутбук', 'HP'), 'NB-0051');
});

test('на пустой базе начинает с первого номера', () => {
  assert.equal(buildInventoryNumber(RULES, [], 'Монитор', 'Samsung'), 'MON-0001');
});

test('номер больше 9999 не обрезается', () => {
  assert.equal(buildInventoryNumber(RULES, ['MON-9999'], 'Монитор', 'Samsung'), 'MON-10000');
});
