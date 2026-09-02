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
