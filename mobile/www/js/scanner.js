const { BarcodeScanner } = Capacitor.Plugins;

async function scanOnce() {
  const { camera } = await BarcodeScanner.requestPermissions();
  if (camera !== 'granted' && camera !== 'limited') {
    throw new Error('Нет доступа к камере — разрешите доступ в настройках телефона.');
  }

  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
  if (!available) {
    await BarcodeScanner.installGoogleBarcodeScannerModule();
    throw new Error('Модуль сканера ещё устанавливается — попробуйте снова через несколько секунд.');
  }

  try {
    const { barcodes } = await BarcodeScanner.scan({ formats: ['QrCode'] });
    if (!barcodes.length) return null;
    return parseWarehouseQr(barcodes[0].rawValue);
  } catch (error) {
    if (error && error.message === 'scan canceled.') {
      return null;
    }
    throw error;
  }
}

window.Scanner = { scanOnce };
