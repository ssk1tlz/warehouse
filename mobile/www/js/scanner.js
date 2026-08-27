const { BarcodeScanner } = Capacitor.Plugins;
const { BarcodeFormat } = window.capacitorBarcodeScanner;

// Заводские этикетки кодируют серийник чем угодно — от Code 128 до DataMatrix,
// поэтому для них список форматов максимально широкий. Свои QR (WH1:/WHC1:)
// сканируем только как QR.
const LABEL_FORMATS = [
  BarcodeFormat.Code128, BarcodeFormat.Code39, BarcodeFormat.Code93,
  BarcodeFormat.Codabar, BarcodeFormat.Ean13, BarcodeFormat.Ean8,
  BarcodeFormat.UpcA, BarcodeFormat.UpcE, BarcodeFormat.Itf,
  BarcodeFormat.DataMatrix, BarcodeFormat.QrCode,
];

async function ensureScannerReady() {
  const { camera } = await BarcodeScanner.requestPermissions();
  if (camera !== 'granted' && camera !== 'limited') {
    throw new Error('Нет доступа к камере — разрешите доступ в настройках телефона.');
  }

  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
  if (!available) {
    await BarcodeScanner.installGoogleBarcodeScannerModule();
    throw new Error('Модуль сканера ещё устанавливается — попробуйте снова через несколько секунд.');
  }
}

function isCancel(error) {
  return error && typeof error.message === 'string' && /cancel/i.test(error.message);
}

async function scan(parse, notRecognizedMessage) {
  await ensureScannerReady();
  try {
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    if (!barcodes.length) return null;
    const result = parse(barcodes[0].rawValue);
    if (!result) {
      throw new Error(notRecognizedMessage);
    }
    return result;
  } catch (error) {
    if (isCancel(error)) return null;
    throw error;
  }
}

function scanOnce() {
  return scan(parseWarehouseQr, 'Это не похоже на этикетку склада — QR не распознан.');
}

function scanConnectQr() {
  return scan(parseConnectQr, 'Это не похоже на QR для подключения сервера — отсканируйте QR с экрана десктопного приложения.');
}

// Скан заводского штрихкода на этикетке -> серийный номер (или null при отмене).
async function scanLabelBarcode() {
  await ensureScannerReady();
  try {
    const { barcodes } = await BarcodeScanner.scan({ formats: LABEL_FORMATS });
    if (!barcodes.length) return null;
    const serial = pickSerialFromBarcodes(barcodes.map((b) => b.rawValue));
    if (!serial) {
      throw new Error('Штрихкод считан, но не похож на серийный номер.');
    }
    return serial;
  } catch (error) {
    if (isCancel(error)) return null;
    throw error;
  }
}

// Фото этикетки -> распознанный текст (ML Kit, на устройстве, офлайн) ->
// разобранные поля {brand, model, serialNumber, category, name} или null при отмене.
async function scanLabelPhoto() {
  const { Camera, TextRecognition } = Capacitor.Plugins;
  let photo;
  try {
    photo = await Camera.getPhoto({
      source: 'CAMERA',
      resultType: 'uri',
      quality: 90,
      correctOrientation: true,
      saveToGallery: false,
    });
  } catch (error) {
    if (isCancel(error)) return null;
    throw error;
  }
  const path = photo.path || photo.webPath;
  if (!path) {
    throw new Error('Не удалось получить фото с камеры.');
  }
  const result = await TextRecognition.processImage({ path });
  return parseLabelText(result && result.text);
}

window.Scanner = { scanOnce, scanConnectQr, scanLabelBarcode, scanLabelPhoto };
