const { test } = require('node:test');
const assert = require('node:assert/strict');

// scanner.js обращается к глобальным Capacitor.Plugins и window.capacitorBarcodeScanner
// на верхнем уровне модуля — подготовить их ДО require().
global.Capacitor = {
  Plugins: {
    BarcodeScanner: {
      requestPermissions: async () => ({ camera: 'granted' }),
      isGoogleBarcodeScannerModuleAvailable: async () => ({ available: true }),
      startScan: async () => {},
      stopScan: async () => {},
      addListener: async (eventName, callback) => {
        global.__lastBarcodeListener = callback;
        return { remove: async () => {} };
      },
      removeAllListeners: async () => {},
      scan: async () => ({ barcodes: [] }),
    },
  },
};
global.capacitorBarcodeScanner = { BarcodeFormat: { QrCode: 'QR_CODE', Code128: 'CODE_128', Code39: 'CODE_39', Code93: 'CODE_93', Codabar: 'CODABAR', Ean13: 'EAN_13', Ean8: 'EAN_8', UpcA: 'UPC_A', UpcE: 'UPC_E', Itf: 'ITF', DataMatrix: 'DATA_MATRIX' } };
global.window = global.window || {};
window.capacitorBarcodeScanner = global.capacitorBarcodeScanner;

const { parseWarehouseQr, parseWarehouseTarget } = require('../www/js/qr.js');
global.parseWarehouseQr = parseWarehouseQr;
global.parseWarehouseTarget = parseWarehouseTarget;

const scanner = require('../www/js/scanner.js');

// scanOnce() -> { kind: 'asset'|'workplace', id } через комбинированный parseWarehouseTarget
test('scanOnce recognizes an asset QR and reports its kind', async () => {
  global.Capacitor.Plugins.BarcodeScanner.scan = async () => ({ barcodes: [{ rawValue: 'WH1:ast_1' }] });
  assert.deepEqual(await scanner.scanOnce(), { kind: 'asset', id: 'ast_1' });
});

test('scanOnce recognizes a workplace QR and reports its kind', async () => {
  global.Capacitor.Plugins.BarcodeScanner.scan = async () => ({ barcodes: [{ rawValue: 'WHW1:wp_1' }] });
  assert.deepEqual(await scanner.scanOnce(), { kind: 'workplace', id: 'wp_1' });
});

test('startInventoryScan starts the native continuous scan and forwards barcodes', async () => {
  const seen = [];
  await scanner.startInventoryScan((rawValue) => seen.push(rawValue));
  assert.equal(typeof global.__lastBarcodeListener, 'function');
  global.__lastBarcodeListener({ barcode: { rawValue: 'WH1:asset-1' } });
  assert.deepEqual(seen, ['WH1:asset-1']);
});

test('stopInventoryScan removes listeners and stops the native scan without throwing', async () => {
  await scanner.startInventoryScan(() => {});
  await assert.doesNotReject(() => scanner.stopInventoryScan());
});
