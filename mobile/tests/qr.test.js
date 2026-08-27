const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWarehouseQr, parseConnectQr } = require('../www/js/qr.js');

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
