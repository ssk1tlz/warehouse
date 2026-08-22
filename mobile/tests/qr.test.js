const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWarehouseQr } = require('../www/js/qr.js');

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
