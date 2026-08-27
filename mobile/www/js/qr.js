const WAREHOUSE_QR_PREFIX = 'WH1:';
const WAREHOUSE_CONNECT_QR_PREFIX = 'WHC1:';

function parseWarehouseQr(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith(WAREHOUSE_QR_PREFIX)) return null;
  const id = trimmed.slice(WAREHOUSE_QR_PREFIX.length);
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
  return { serverUrl: payload.url, password: typeof payload.password === 'string' ? payload.password : '' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseWarehouseQr, parseConnectQr };
}
if (typeof window !== 'undefined') {
  Object.assign(window, { parseWarehouseQr, parseConnectQr });
}
