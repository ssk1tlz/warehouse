// Клиентская половина справочника обозначений техники.
//
// Сами правила сюда не записаны — они живут в asset_codes.py и приезжают
// с сервера в GET /api/state полем assetCodeTypes. Здесь только алгоритм
// сопоставления, и он обязан совпадать с питоновским: десктоп сохраняет
// придуманный им номер как есть, так что расхождение молча пометило бы
// технику не той буквой. Соответствие стережёт tests/test_asset_codes_js_parity.py,
// прогоняющий оба алгоритма по всем категориям из базы.
//
// Файл подключается в index.html до app.js и не трогает DOM, поэтому
// требуется из node в tests/asset_codes.test.js.

const FALLBACK_PREFIX = 'INV';

const NUMBER_RE = /^(?:[A-Za-z]+-)?(\d+)$/;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Зеркало _haystack() из asset_codes.py. Схлопывание пробелов лечит
// реальный разнобой в базе ("Принтер / Сканер" против "Принтер  Сканер"),
// ведущий пробел даёт границу слова ключу в самом начале строки.
function haystack(text) {
  return ' ' + String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

// Граница слова слева и её отсутствие справа — ровно как в Python.
// Без левой границы "ups" находилось бы в "groups", а "tv" внутри
// "AVTECH"; правой границы нет намеренно, половина ключей это основы
// ("бесперебойн", "акустическ"), которые должны ловить любое окончание.
//
// \b в JS определена по [A-Za-z0-9_] и для кириллицы не работает, поэтому
// левая граница задаётся явно: начало строки или не-буквенно-цифровой
// символ. Латинские ключи от этого не страдают, а кириллические начинают
// вести себя так же, как в Python.
function keywordPattern(keyword) {
  return new RegExp('(?:^|[^0-9\\p{L}])' + escapeRegExp(keyword), 'u');
}

function matchPrefix(codeTypes, text) {
  const padded = haystack(text);
  for (const type of codeTypes || []) {
    for (const keyword of type.keywords || []) {
      if (keywordPattern(keyword).test(padded)) return type.prefix;
    }
  }
  return null;
}

// Категория проверяется первой и целиком, и только если она не дала
// ответа, разбирается наименование. Склеивать поля нельзя: победило бы
// правило, стоящее раньше в списке, а не то, что в категории, и
// клавиатура с названием "A4Tech KR-85 для ПК" стала бы системным блоком
// (PC стоит раньше KEY). Наименование остаётся запасным вариантом: у ИБП
// UPS-0004 категория "Периферийные устройства", и тип виден только в нём.
function guessAssetPrefix(codeTypes, category, name) {
  return matchPrefix(codeTypes, category) || matchPrefix(codeTypes, name) || FALLBACK_PREFIX;
}

// Максимум по всем номерам плюс один — номер общий для всех типов, а не
// свой у каждого. Разбираются оба формата, которые встречаются в базе:
// и "NB-0021", и голый "181".
function nextAssetNumber(inventoryNumbers) {
  let highest = 0;
  for (const raw of inventoryNumbers || []) {
    if (!raw) continue;
    const match = NUMBER_RE.exec(String(raw).trim());
    if (match) highest = Math.max(highest, parseInt(match[1], 10));
  }
  return highest + 1;
}

function buildInventoryNumber(codeTypes, inventoryNumbers, category, name) {
  const prefix = guessAssetPrefix(codeTypes, category, name);
  return `${prefix}-${String(nextAssetNumber(inventoryNumbers)).padStart(4, '0')}`;
}

const AssetCodes = { guessAssetPrefix, nextAssetNumber, buildInventoryNumber, FALLBACK_PREFIX };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AssetCodes;
}
if (typeof window !== 'undefined') {
  window.AssetCodes = AssetCodes;
}
