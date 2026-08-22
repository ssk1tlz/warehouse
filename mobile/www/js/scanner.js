const { BarcodeScanner } = Capacitor.Plugins;

async function scanOnce() {
  const { camera } = await BarcodeScanner.requestPermissions();
  if (camera !== 'granted' && camera !== 'limited') {
    throw new Error('Нет доступа к камере — разрешите доступ в настройках телефона.');
  }
  const { barcodes } = await BarcodeScanner.scan({ formats: ['QrCode'] });
  if (!barcodes.length) return null;
  return parseWarehouseQr(barcodes[0].rawValue);
}

window.Scanner = { scanOnce };
