const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('describeScanError returns the error message when present', () => {
  const { describeScanError } = require('../www/js/screens.js');
  assert.equal(describeScanError(new Error('Камера недоступна.')), 'Камера недоступна.');
});

test('describeScanError falls back to the given default when there is no message', () => {
  const { describeScanError } = require('../www/js/screens.js');
  assert.equal(describeScanError(null, 'Не удалось выполнить сканирование.'), 'Не удалось выполнить сканирование.');
  assert.equal(describeScanError(new Error(''), 'Не удалось распознать этикетку.'), 'Не удалось распознать этикетку.');
});

test('screens.js contains no alert( calls', () => {
  const source = fs.readFileSync(path.join(__dirname, '../www/js/screens.js'), 'utf8');
  assert.ok(!source.includes('alert('), 'alert( found in screens.js — replace with Toast.show');
});

test('describeUpdate returns banner text when the server reports a newer version', () => {
  const { describeUpdate } = require('../www/js/screens.js');
  const result = describeUpdate({ latestVersion: '1.5.0', releaseUrl: 'https://example/r' }, '1.0.0');
  assert.equal(result.url, 'https://example/r');
  assert.ok(result.text.includes('1.5.0'));
});

test('describeUpdate returns null when there is nothing newer', () => {
  const { describeUpdate } = require('../www/js/screens.js');
  assert.equal(describeUpdate({ latestVersion: '1.0.0' }, '1.0.0'), null);
  assert.equal(describeUpdate({ latestVersion: '0.9.0' }, '1.0.0'), null);
  assert.equal(describeUpdate({ latestVersion: null }, '1.0.0'), null);
  assert.equal(describeUpdate({}, '1.0.0'), null);
});

test('describeUpdate compares numerically, not alphabetically', () => {
  const { describeUpdate } = require('../www/js/screens.js');
  // '1.0.10' < '1.0.9' по строковому сравнению — но 10 новее 9.
  assert.ok(describeUpdate({ latestVersion: '1.0.10' }, '1.0.9') !== null);
  assert.equal(describeUpdate({ latestVersion: '1.0.9' }, '1.0.10'), null);
});

test('describeUpdate survives a malformed version without throwing', () => {
  const { describeUpdate } = require('../www/js/screens.js');
  assert.equal(describeUpdate({ latestVersion: 'мусор' }, '1.0.0'), null);
  assert.equal(describeUpdate({ latestVersion: '1.0.1' }, undefined), null);
});

test('reconcileInventory lists assets that were never scanned as missing', () => {
  const { reconcileInventory } = require('../www/js/screens.js');
  const result = reconcileInventory(
    [{ assetId: 'a1', status: 'found', foundLocation: '' }],
    [{ id: 'a1', name: 'Монитор', inventoryNumber: 'INV-1', location: 'Каб. 101' },
     { id: 'a2', name: 'Клавиатура', inventoryNumber: 'INV-2', location: 'Каб. 101' }],
    [],
  );
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].id, 'a2');
  assert.equal(result.foundCount, 1);
});

test('reconcileInventory separates wrong-location scans from plain found ones', () => {
  const { reconcileInventory } = require('../www/js/screens.js');
  const result = reconcileInventory(
    [{ assetId: 'a1', status: 'wrong_location', foundLocation: 'Каб. 202' }],
    [{ id: 'a1', name: 'Монитор', inventoryNumber: 'INV-1', location: 'Каб. 101' }],
    [],
  );
  assert.equal(result.missing.length, 0);
  assert.equal(result.wrongLocation.length, 1);
  assert.equal(result.wrongLocation[0].foundLocation, 'Каб. 202');
  assert.equal(result.wrongLocation[0].expectedLocation, 'Каб. 101');
});

test('reconcileInventory treats a repeat scan of the same asset as one entry, not a duplicate', () => {
  const { reconcileInventory } = require('../www/js/screens.js');
  const result = reconcileInventory(
    [{ assetId: 'a1', status: 'found', foundLocation: '' },
     { assetId: 'a1', status: 'found', foundLocation: '' }],
    [{ id: 'a1', name: 'Монитор', inventoryNumber: 'INV-1', location: 'Каб. 101' }],
    [],
  );
  assert.equal(result.foundCount, 1);
});

test('reconcileInventory passes extraCodes through unchanged', () => {
  const { reconcileInventory } = require('../www/js/screens.js');
  const result = reconcileInventory([], [], ['WH1:unknown-1', 'WH1:unknown-1']);
  assert.deepEqual(result.extra, ['WH1:unknown-1', 'WH1:unknown-1']);
});

test('renderAttentionBadgeText returns empty string for no items', () => {
  const { renderAttentionBadgeText } = require('../www/js/screens.js');
  assert.equal(renderAttentionBadgeText([]), '');
});

test('renderAttentionBadgeText returns the count as a string', () => {
  const { renderAttentionBadgeText } = require('../www/js/screens.js');
  assert.equal(renderAttentionBadgeText([{}, {}, {}]), '3');
});
