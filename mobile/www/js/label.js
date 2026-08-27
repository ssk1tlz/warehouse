// Разбор заводской этикетки техники: текст с этикетки (OCR) -> поля карточки.
// Чистые функции без зависимостей — тестируются в Node так же, как qr.js.

const LABEL_BRANDS = [
  ['Hewlett-Packard', 'HP'], ['HP', 'HP'], ['Dell', 'Dell'], ['Lenovo', 'Lenovo'],
  ['ASUS', 'ASUS'], ['Acer', 'Acer'], ['Apple', 'Apple'], ['Samsung', 'Samsung'],
  ['LG', 'LG'], ['MSI', 'MSI'], ['Xiaomi', 'Xiaomi'], ['Huawei', 'Huawei'],
  ['Toshiba', 'Toshiba'], ['Fujitsu', 'Fujitsu'], ['Canon', 'Canon'], ['Epson', 'Epson'],
  ['Brother', 'Brother'], ['Kyocera', 'Kyocera'], ['Philips', 'Philips'], ['BenQ', 'BenQ'],
  ['AOC', 'AOC'], ['ViewSonic', 'ViewSonic'], ['TP-Link', 'TP-Link'], ['D-Link', 'D-Link'],
  ['MikroTik', 'MikroTik'], ['Zyxel', 'Zyxel'], ['Cisco', 'Cisco'],
];

// Строка с одним из этих слов почти наверняка и есть название модели.
const MODEL_SERIES = [
  'ThinkPad', 'IdeaPad', 'ThinkBook', 'ThinkCentre', 'Latitude', 'Inspiron', 'Vostro',
  'XPS', 'OptiPlex', 'Precision', 'EliteBook', 'ProBook', 'ProDesk', 'EliteDesk',
  'Pavilion', 'LaserJet', 'DeskJet', 'OfficeJet', 'MacBook', 'iMac', 'VivoBook',
  'ZenBook', 'Aspire', 'Nitro', 'TravelMate', 'EcoTank', 'ECOSYS', 'PIXMA',
  'PowerEdge', 'ProLiant',
];

const LAPTOP_SERIES = new Set([
  'ThinkPad', 'IdeaPad', 'ThinkBook', 'Latitude', 'Inspiron', 'Vostro', 'XPS',
  'EliteBook', 'ProBook', 'Pavilion', 'MacBook', 'VivoBook', 'ZenBook', 'Aspire',
  'Nitro', 'TravelMate',
]);

const SERIAL_INLINE = /\b(?:S\/N|SN|SERIAL(?:\s*(?:NO|NUMBER|#))?|SERVICE\s*TAG)\b\s*[:#.]?\s*((?=[A-Za-z0-9\-]*\d)[A-Za-z0-9][A-Za-z0-9\-]{4,23})/i;
const SERIAL_HEADER = /^(?:S\/N|SN|SERIAL(?:\s*(?:NO|NUMBER))?|SERVICE\s*TAG)\s*[:#.]?\s*$/i;
const SERIAL_VALUE = /^(?=[A-Za-z0-9\-]*\d)[A-Za-z0-9][A-Za-z0-9\-]{4,23}$/;

const MODEL_INLINE = /\b(?:MODEL(?:\s*(?:NO|NAME|NUMBER|#))?|M\/N)\b\s*[:#.]?\s*(\S.*)$/i;
const MODEL_HEADER = /^MODEL(?:\s*(?:NO|NAME|NUMBER|#))?\s*[:#.]?\s*$/i;

function cleanValue(value) {
  return String(value || '').replace(/[\s;,.]+$/, '').replace(/\s+/g, ' ').trim() || null;
}

function findBrand(text) {
  for (const [needle, canonical] of LABEL_BRANDS) {
    const pattern = new RegExp(`\\b${needle.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(text)) return canonical;
  }
  return null;
}

function findSerial(lines) {
  for (const line of lines) {
    const inline = line.match(SERIAL_INLINE);
    if (inline) return inline[1];
  }
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (SERIAL_HEADER.test(lines[i]) && SERIAL_VALUE.test(lines[i + 1])) return lines[i + 1];
  }
  return null;
}

function findModel(lines, brand) {
  for (const line of lines) {
    const inline = line.match(MODEL_INLINE);
    if (inline) {
      const value = cleanValue(inline[1]);
      if (value) return value;
    }
  }
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (MODEL_HEADER.test(lines[i])) {
      const value = cleanValue(lines[i + 1]);
      if (value) return value;
    }
  }
  // Строка с известной линейкой ("ThinkPad X1 Carbon") — берём её целиком,
  // отрезав название бренда в начале, чтобы имя не стало "HP HP EliteBook…".
  for (const line of lines) {
    for (const series of MODEL_SERIES) {
      if (new RegExp(`\\b${series}\\b`, 'i').test(line)) {
        let value = line;
        if (brand) value = value.replace(new RegExp(`^\\s*${brand}\\b[\\s:,-]*`, 'i'), '');
        return cleanValue(value);
      }
    }
  }
  return null;
}

function guessCategory(text, model) {
  const haystack = `${text}\n${model || ''}`;
  if (/\b(?:MFP|all[- ]in[- ]one)\b/i.test(haystack)) return 'МФУ';
  if (/\b(?:LaserJet|DeskJet|OfficeJet|ECOSYS|PIXMA|EcoTank|printer)\b/i.test(haystack)) return 'Принтер';
  if (/\b(?:monitor|display)\b/i.test(haystack)) return 'Монитор';
  if (/\b(?:laptop|notebook)\b/i.test(haystack)) return 'Ноутбук';
  for (const series of LAPTOP_SERIES) {
    if (new RegExp(`\\b${series}\\b`, 'i').test(haystack)) return 'Ноутбук';
  }
  if (/\b(?:server|PowerEdge|ProLiant)\b/i.test(haystack)) return 'Сервер';
  if (/\b(?:switch|router|access point)\b/i.test(haystack)) return 'Сетевое оборудование';
  return null;
}

function parseLabelText(text) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    return { brand: null, model: null, serialNumber: null, category: null, name: null };
  }
  const brand = findBrand(raw);
  const model = findModel(lines, brand);
  const serialNumber = findSerial(lines);
  const category = guessCategory(raw, model);
  const name = brand && model ? `${brand} ${model}` : model || brand;
  return { brand, model, serialNumber, category, name: name || null };
}

// Выбор серийника из штрихкодов заводской этикетки. Свои QR (WH1:/WHC1:),
// ссылки и мусор отбрасываем; серийник с буквами и цифрами предпочитаем
// чисто цифровому — тот обычно оказывается товарным EAN, а не серийником.
function pickSerialFromBarcodes(rawValues) {
  if (!Array.isArray(rawValues)) return null;
  const candidates = rawValues
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) =>
      value &&
      !value.startsWith('WH1:') &&
      !value.startsWith('WHC1:') &&
      !/^https?:\/\//i.test(value) &&
      /^[A-Za-z0-9\-\/.]{5,24}$/.test(value)
    );
  if (!candidates.length) return null;
  const mixed = candidates.find((value) => /[A-Za-z]/.test(value) && /[0-9]/.test(value));
  return mixed || candidates[0];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseLabelText, pickSerialFromBarcodes };
}
if (typeof window !== 'undefined') {
  Object.assign(window, { parseLabelText, pickSerialFromBarcodes });
}
