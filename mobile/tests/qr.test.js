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

test('extracts url and password from a valid connect QR', () => {
  assert.deepEqual(
    parseConnectQr('WHC1:{"url":"http://192.168.0.115:8765","password":"secret"}'),
    { serverUrl: 'http://192.168.0.115:8765', password: 'secret' }
  );
});

test('connect QR defaults password to empty string when omitted', () => {
  assert.deepEqual(
    parseConnectQr('WHC1:{"url":"http://192.168.0.115:8765"}'),
    { serverUrl: 'http://192.168.0.115:8765', password: '' }
  );
});

test('returns null for text without the WHC1: prefix', () => {
  assert.equal(parseConnectQr('WH1:ast_1'), null);
});

test('returns null for a connect QR with malformed JSON', () => {
  assert.equal(parseConnectQr('WHC1:not-json'), null);
});

test('returns null for a connect QR JSON payload missing url', () => {
  assert.equal(parseConnectQr('WHC1:{"password":"secret"}'), null);
});

test('returns null for an empty or missing connect QR scan result', () => {
  assert.equal(parseConnectQr(''), null);
  assert.equal(parseConnectQr(null), null);
  assert.equal(parseConnectQr(undefined), null);
});
