const WAREHOUSE_QR_PREFIX = 'WH1:';

function parseWarehouseQr(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith(WAREHOUSE_QR_PREFIX)) return null;
  const id = trimmed.slice(WAREHOUSE_QR_PREFIX.length);
  return id ? id : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseWarehouseQr };
}
if (typeof window !== 'undefined') {
  window.parseWarehouseQr = parseWarehouseQr;
}
