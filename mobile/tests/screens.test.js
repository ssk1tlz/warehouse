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

test('summarizeOffboarding reports allDone true when nothing remains', () => {
  const { summarizeOffboarding } = require('../www/js/screens.js');
  const result = summarizeOffboarding([]);
  assert.equal(result.allDone, true);
  assert.equal(result.remaining, 0);
});

test('summarizeOffboarding reports remaining items when allocations exist', () => {
  const { summarizeOffboarding } = require('../www/js/screens.js');
  const result = summarizeOffboarding([{ quantity: 2 }, { quantity: 1 }]);
  assert.equal(result.allDone, false);
  assert.equal(result.total, 3);
  assert.equal(result.remaining, 3);
});

// Minimal fake DOM sufficient for quickReturnFromEmployee's re-render path
// (openEmployeeDetailScreen -> showScreen), without pulling in a real DOM
// library the project doesn't otherwise depend on.
function makeFakeDocument() {
  function makeElement() {
    const classes = new Set();
    return {
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, force) => {
          const want = force === undefined ? !classes.has(c) : Boolean(force);
          if (want) classes.add(c); else classes.delete(c);
        },
        contains: (c) => classes.has(c),
      },
      children: [],
      textContent: '',
      innerHTML: '',
      appendChild(child) { this.children.push(child); return child; },
      append(...items) { this.children.push(...items); },
      addEventListener() {},
      removeAttribute() {},
      setAttribute() {},
      querySelectorAll: () => [],
    };
  }
  const byId = new Map();
  return {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement());
      return byId.get(id);
    },
    createElement: () => makeElement(),
    querySelectorAll: () => [],
  };
}

test('quickReturnFromEmployee ignores a second rapid call on an already-disabled button (double-submission guard)', async () => {
  const { quickReturnFromEmployee } = require('../www/js/screens.js');
  const enqueued = [];
  global.document = makeFakeDocument();
  global.Db = {
    enqueueAction: async (payload) => { enqueued.push(payload); },
    listPendingActions: async () => [],
    getStateMeta: async () => ({}),
    searchEmployees: async () => [{ id: 'emp1', fullName: 'Иванов И.И.', status: 'inactive' }],
    getAllocationsForEmployee: async () => [],
  };
  global.Toast = { show: () => {} };
  global.Sync = { run: async () => ({ pulled: true, needsReauth: false }) };
  global.ConnStatus = { report: () => {} };
  try {
    const returnBtn = { disabled: false };
    // Two "rapid" calls sharing the same button, as a fast double-tap would
    // produce: the second call must observe the button already disabled
    // (set synchronously before the first `await` in quickReturnFromEmployee)
    // and bail out without enqueueing a second return.
    const p1 = quickReturnFromEmployee('emp1', 'ast_1', 2, returnBtn);
    const p2 = quickReturnFromEmployee('emp1', 'ast_1', 2, returnBtn);
    await Promise.all([p1, p2]);
    assert.equal(enqueued.length, 1, 'only the first call should enqueue a return');
    assert.equal(returnBtn.disabled, true);
  } finally {
    delete global.document;
    delete global.Db;
    delete global.Toast;
    delete global.Sync;
    delete global.ConnStatus;
  }
});

test('quickReturnFromEmployee still enqueues when called without a button (defensive: no 4th arg)', async () => {
  const { quickReturnFromEmployee } = require('../www/js/screens.js');
  const enqueued = [];
  global.document = makeFakeDocument();
  global.Db = {
    enqueueAction: async (payload) => { enqueued.push(payload); },
    listPendingActions: async () => [],
    getStateMeta: async () => ({}),
    searchEmployees: async () => [{ id: 'emp1', fullName: 'Иванов И.И.', status: 'inactive' }],
    getAllocationsForEmployee: async () => [],
  };
  global.Toast = { show: () => {} };
  global.Sync = { run: async () => ({ pulled: true, needsReauth: false }) };
  global.ConnStatus = { report: () => {} };
  try {
    await quickReturnFromEmployee('emp1', 'ast_1', 2);
    assert.equal(enqueued.length, 1);
  } finally {
    delete global.document;
    delete global.Db;
    delete global.Toast;
    delete global.Sync;
    delete global.ConnStatus;
  }
});

test('renderAssetPhoto shows the photo and hides the placeholder when Sync.getPhoto resolves ok', async () => {
  const { renderAssetPhoto } = require('../www/js/screens.js');
  const doc = makeFakeDocument();
  global.document = doc;
  global.Sync = { getPhoto: async () => ({ ok: true, blob: async () => 'fake-blob-bytes' }) };
  const createdFrom = [];
  global.URL = {
    createObjectURL: (blob) => { createdFrom.push(blob); return 'blob:fake-1'; },
    revokeObjectURL: () => {},
  };
  try {
    await renderAssetPhoto('ast_1');
    const img = doc.getElementById('assetPhotoImg');
    const placeholder = doc.getElementById('assetPhotoPlaceholder');
    assert.equal(img.src, 'blob:fake-1');
    assert.equal(img.classList.contains('hidden'), false);
    assert.equal(placeholder.classList.contains('hidden'), true);
    assert.deepEqual(createdFrom, ['fake-blob-bytes']);
  } finally {
    delete global.document;
    delete global.Sync;
    delete global.URL;
  }
});

test('renderAssetPhoto leaves the placeholder shown when Sync.getPhoto resolves non-ok (e.g. 404 — no photo yet)', async () => {
  const { renderAssetPhoto } = require('../www/js/screens.js');
  const doc = makeFakeDocument();
  global.document = doc;
  global.Sync = { getPhoto: async () => ({ ok: false, status: 404 }) };
  global.URL = { createObjectURL: () => 'blob:should-not-be-used', revokeObjectURL: () => {} };
  try {
    await renderAssetPhoto('ast_missing');
    const img = doc.getElementById('assetPhotoImg');
    const placeholder = doc.getElementById('assetPhotoPlaceholder');
    assert.equal(img.classList.contains('hidden'), true);
    assert.equal(placeholder.classList.contains('hidden'), false);
  } finally {
    delete global.document;
    delete global.Sync;
    delete global.URL;
  }
});

// Judgment call from the brief: openAssetScreen is reachable twice in a row
// before the first photo fetch resolves — renderSearchResults' list-item
// click handler calls it unawaited/undisabled, so two rapid taps on
// different search results both trigger it. This is the same race desktop's
// assetPhotoRenderToken guards against, so mobile's renderAssetPhoto carries
// the same guard; this test proves it actually prevents the stale clobber.
test('renderAssetPhoto discards a stale response when a newer call has already superseded it', async () => {
  const { renderAssetPhoto } = require('../www/js/screens.js');
  const doc = makeFakeDocument();
  global.document = doc;
  let resolveFirst;
  const firstPending = new Promise((resolve) => { resolveFirst = resolve; });
  let calls = 0;
  global.Sync = {
    getPhoto: async () => {
      calls += 1;
      if (calls === 1) { await firstPending; return { ok: true, blob: async () => 'stale-photo' }; }
      return { ok: true, blob: async () => 'fresh-photo' };
    },
  };
  global.URL = { createObjectURL: (blob) => `blob:${blob}`, revokeObjectURL: () => {} };
  try {
    const p1 = renderAssetPhoto('ast_A'); // hangs on firstPending — simulates the slower, stale request
    const p2 = renderAssetPhoto('ast_B'); // started right after, resolves immediately
    await p2;
    const img = doc.getElementById('assetPhotoImg');
    assert.equal(img.src, 'blob:fresh-photo', "the newer call's photo must be shown");
    resolveFirst();
    await p1; // let the stale call finish — it must not clobber the newer photo
    assert.equal(img.src, 'blob:fresh-photo', "the stale call's late-arriving response must not overwrite the newer photo");
  } finally {
    delete global.document;
    delete global.Sync;
    delete global.URL;
  }
});
