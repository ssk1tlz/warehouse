const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLabelText, pickSerialFromBarcodes } = require('../www/js/label.js');

// ─── parseLabelText: серийный номер ──────────────────────────────

test('extracts serial from an "S/N:" line', () => {
  const r = parseLabelText('LG\nMODEL: 24MK600M\nS/N: 002NTPC7H839');
  assert.equal(r.serialNumber, '002NTPC7H839');
});

test('extracts serial from "Serial No." with dot and spaces', () => {
  const r = parseLabelText('HP EliteBook 840 G8\nSerial No. 5CD1234XYZ');
  assert.equal(r.serialNumber, '5CD1234XYZ');
});

test('extracts serial from a Dell Service Tag', () => {
  const r = parseLabelText('Dell Inc.\nService Tag: 7ZX9Q42\nExpress Service Code');
  assert.equal(r.serialNumber, '7ZX9Q42');
});

test('extracts serial when the value is on the next line', () => {
  const r = parseLabelText('SERIAL NUMBER\nXYZ12345\nMade in China');
  assert.equal(r.serialNumber, 'XYZ12345');
});

test('serial is null when the label has none', () => {
  const r = parseLabelText('Some random text\nMade in Taiwan');
  assert.equal(r.serialNumber, null);
});

// ─── parseLabelText: модель ──────────────────────────────────────

test('extracts model from a "Model:" line', () => {
  const r = parseLabelText('LG\nMODEL: 24MK600M\nSERIAL NO: 002NTPC7H839');
  assert.equal(r.model, '24MK600M');
});

test('extracts model from "M/N" shorthand', () => {
  const r = parseLabelText('Samsung\nM/N: LS24A400\nS/N: ABC123DEF');
  assert.equal(r.model, 'LS24A400');
});

test('recognizes a well-known laptop series line as the model', () => {
  const r = parseLabelText('Lenovo\nThinkPad X1 Carbon Gen 9\nS/N: PF2ABCD1');
  assert.equal(r.model, 'ThinkPad X1 Carbon Gen 9');
});

test('extracts model when the value is on the next line', () => {
  const r = parseLabelText('MODEL\nLatitude 5520\nDell Inc.');
  assert.equal(r.model, 'Latitude 5520');
});

// ─── parseLabelText: производитель и имя ─────────────────────────

test('detects the brand anywhere in the text, normalized', () => {
  const r = parseLabelText('hewlett-packard\nLaserJet Pro M404dn\nSerial: PHB1234');
  assert.equal(r.brand, 'HP');
});

test('detects Dell as brand from "Dell Inc."', () => {
  const r = parseLabelText('Dell Inc.\nLatitude 5520\nService Tag: ABC1234');
  assert.equal(r.brand, 'Dell');
});

test('composes a suggested name from brand and model', () => {
  const r = parseLabelText('Dell Inc.\nModel: Latitude 5520\nService Tag: ABC1234');
  assert.equal(r.name, 'Dell Latitude 5520');
});

test('name falls back to just the model when brand is unknown', () => {
  const r = parseLabelText('MODEL: SUPERBOX-9000\nS/N: Q1W2E3R4');
  assert.equal(r.name, 'SUPERBOX-9000');
});

test('name is null when neither brand nor model was found', () => {
  const r = parseLabelText('Made in China\n100-240V 50/60Hz');
  assert.equal(r.name, null);
});

// ─── parseLabelText: категория ───────────────────────────────────

test('guesses printer category from LaserJet', () => {
  const r = parseLabelText('HP\nLaserJet Pro M404dn\nSerial: PHB1234');
  assert.equal(r.category, 'Принтер');
});

test('guesses laptop category from a laptop series', () => {
  const r = parseLabelText('Lenovo\nThinkPad X1 Carbon\nS/N: PF2ABCD1');
  assert.equal(r.category, 'Ноутбук');
});

test('guesses monitor category from the word Monitor', () => {
  const r = parseLabelText('LG LED MONITOR\nMODEL: 24MK600M\nS/N: 002NTPC7H839');
  assert.equal(r.category, 'Монитор');
});

test('category is null when nothing matches', () => {
  const r = parseLabelText('MODEL: SUPERBOX-9000\nS/N: Q1W2E3R4');
  assert.equal(r.category, null);
});

// ─── parseLabelText: устойчивость ────────────────────────────────

test('returns all-null result for empty or missing text', () => {
  for (const input of ['', null, undefined]) {
    const r = parseLabelText(input);
    assert.deepEqual(r, { brand: null, model: null, serialNumber: null, category: null, name: null });
  }
});

// ─── pickSerialFromBarcodes ──────────────────────────────────────

test('picks a mixed letter-digit value as the serial', () => {
  assert.equal(pickSerialFromBarcodes(['SN12345ABC']), 'SN12345ABC');
});

test('prefers mixed alphanumeric over digits-only product codes', () => {
  assert.equal(pickSerialFromBarcodes(['4006381333931', '5CD1234XYZ']), '5CD1234XYZ');
});

test('falls back to a digits-only value when it is the only candidate', () => {
  assert.equal(pickSerialFromBarcodes(['002337841943']), '002337841943');
});

test('ignores our own warehouse QR payloads', () => {
  assert.equal(pickSerialFromBarcodes(['WH1:ast_1755600000000_ab12cd']), null);
  assert.equal(pickSerialFromBarcodes(['WHC1:{"url":"http://x"}']), null);
});

test('ignores URLs and too-short values', () => {
  assert.equal(pickSerialFromBarcodes(['http://example.com/a', 'AB1']), null);
});

test('returns null for an empty list or missing input', () => {
  assert.equal(pickSerialFromBarcodes([]), null);
  assert.equal(pickSerialFromBarcodes(null), null);
});
