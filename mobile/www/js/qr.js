const WAREHOUSE_QR_PREFIX = 'WH1:';
const WAREHOUSE_CONNECT_QR_PREFIX = 'WHC1:';
const WAREHOUSE_WORKPLACE_QR_PREFIX = 'WHW1:';

function parseWarehouseQr(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith(WAREHOUSE_QR_PREFIX)) return null;
  const id = trimmed.slice(WAREHOUSE_QR_PREFIX.length);
  return id ? id : null;
}

// Стикер рабочего места (стол печатает один общий QR вместо этикетки на
// каждую единицу техники — см. дизайн-спеку) — тот же приём, что и у
// parseWarehouseQr, свой префикс.
function parseWorkplaceQr(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith(WAREHOUSE_WORKPLACE_QR_PREFIX)) return null;
  const id = trimmed.slice(WAREHOUSE_WORKPLACE_QR_PREFIX.length);
  return id ? id : null;
}

function parseConnectQr(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith(WAREHOUSE_CONNECT_QR_PREFIX)) return null;
  let payload;
  try {
    payload = JSON.parse(trimmed.slice(WAREHOUSE_CONNECT_QR_PREFIX.length));
  } catch {
    return null;
  }
  if (!payload || typeof payload.url !== 'string' || !payload.url) return null;
  if (typeof payload.code !== 'string' || !payload.code) return null;
  if (typeof payload.secret !== 'string' || !payload.secret) return null;
  return { serverUrl: payload.url, code: payload.code, secret: payload.secret };
}

// Кнопка «Скан» в приложении одна на оба вида стикеров склада — актив
// (WH1:) и стол (WHW1:). Какой из них перед нами, решает вызывающий код
// (screens.js) по полю kind, а не по формату id.
function parseWarehouseTarget(text) {
  const assetId = parseWarehouseQr(text);
  if (assetId) return { kind: 'asset', id: assetId };
  const workplaceId = parseWorkplaceQr(text);
  if (workplaceId) return { kind: 'workplace', id: workplaceId };
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseWarehouseQr, parseConnectQr, parseWorkplaceQr, parseWarehouseTarget };
}
if (typeof window !== 'undefined') {
  Object.assign(window, { parseWarehouseQr, parseConnectQr, parseWorkplaceQr, parseWarehouseTarget });
}
