const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWarehouseQr, parseConnectQr, parseWorkplaceQr, parseWarehouseTarget } = require('../www/js/qr.js');

test('extracts the asset id from a valid warehouse QR', () => {
  assert.equal(parseWarehouseQr('WH1:ast_1755600000000_ab12cd'), 'ast_1755600000000_ab12cd');
});

test('returns null for text without the WH1: prefix', () => {
  assert.equal(parseWarehouseQr('INV-004821'), null);
});

test('returns null for an empty or missing scan result', () => {
  assert.equal(parseWarehouseQr(''), null);
  assert.equal(parseWarehouseQr(null), null);
  assert.equal(parseWarehouseQr(undefined), null);
});

test('returns null when the prefix is present but the id is empty', () => {
  assert.equal(parseWarehouseQr('WH1:'), null);
});

test('trims incidental whitespace some scanners add', () => {
  assert.equal(parseWarehouseQr('  WH1:ast_1  '), 'ast_1');
});

test('extracts url, code and secret from a valid connect QR', () => {
  assert.deepEqual(
    parseConnectQr('WHC1:{"url":"http://192.168.0.115:8765","code":"abc","secret":"deadbeef"}'),
    { serverUrl: 'http://192.168.0.115:8765', code: 'abc', secret: 'deadbeef' }
  );
});

test('returns null for a connect QR missing the code', () => {
  assert.equal(parseConnectQr('WHC1:{"url":"http://192.168.0.115:8765","secret":"deadbeef"}'), null);
});

test('returns null for a connect QR missing the secret', () => {
  assert.equal(parseConnectQr('WHC1:{"url":"http://192.168.0.115:8765","code":"abc"}'), null);
});

test('returns null for text without the WHC1: prefix', () => {
  assert.equal(parseConnectQr('WH1:ast_1'), null);
});

test('returns null for a connect QR with malformed JSON', () => {
  assert.equal(parseConnectQr('WHC1:not-json'), null);
});

test('returns null for a connect QR JSON payload missing url', () => {
  assert.equal(parseConnectQr('WHC1:{"code":"abc","secret":"deadbeef"}'), null);
});

test('returns null for an empty or missing connect QR scan result', () => {
  assert.equal(parseConnectQr(''), null);
  assert.equal(parseConnectQr(null), null);
  assert.equal(parseConnectQr(undefined), null);
});

// ─── QR рабочего места (WHW1:) ────────────────────────────────

test('extracts the workplace id from a valid workplace QR', () => {
  assert.equal(parseWorkplaceQr('WHW1:wp_1755600000000_ab12cd'), 'wp_1755600000000_ab12cd');
});

test('parseWorkplaceQr returns null for text without the WHW1: prefix', () => {
  assert.equal(parseWorkplaceQr('WH1:ast_1'), null);
});

test('parseWorkplaceQr returns null when the prefix is present but the id is empty', () => {
  assert.equal(parseWorkplaceQr('WHW1:'), null);
});

test('parseWorkplaceQr returns null for an empty or missing scan result', () => {
  assert.equal(parseWorkplaceQr(''), null);
  assert.equal(parseWorkplaceQr(null), null);
  assert.equal(parseWorkplaceQr(undefined), null);
});

test('parseWorkplaceQr trims incidental whitespace', () => {
  assert.equal(parseWorkplaceQr('  WHW1:wp_1  '), 'wp_1');
});

// ─── Комбинированный разбор для кнопки «Скан» ──────────────────

test('parseWarehouseTarget recognizes an asset QR', () => {
  assert.deepEqual(parseWarehouseTarget('WH1:ast_1'), { kind: 'asset', id: 'ast_1' });
});

test('parseWarehouseTarget recognizes a workplace QR', () => {
  assert.deepEqual(parseWarehouseTarget('WHW1:wp_1'), { kind: 'workplace', id: 'wp_1' });
});

test('parseWarehouseTarget returns null for an unrecognized QR', () => {
  assert.equal(parseWarehouseTarget('INV-004821'), null);
});

test('parseWarehouseTarget does not mistake a connect QR for an asset or workplace QR', () => {
  assert.equal(parseWarehouseTarget('WHC1:{"url":"http://x","code":"a","secret":"b"}'), null);
});
