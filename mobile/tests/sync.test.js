const test = require('node:test');
const assert = require('node:assert/strict');
const Sync = require('../www/js/sync.js');

test('pair() posts the code and returns token+deviceSecret from the response', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ token: 'tok123', role: 'storekeeper', username: 'bob' }),
    };
  };
  const result = await Sync.pair('http://192.168.0.1:8765', 'code123');
  assert.equal(result.token, 'tok123');
  assert.equal(calls[0].url, 'http://192.168.0.1:8765/api/pair');
  assert.deepEqual(JSON.parse(calls[0].options.body), { code: 'code123' });
});

test('pair() throws with the server error message on failure', async () => {
  global.fetch = async () => ({
    ok: false, status: 400, json: async () => ({ error: 'Код сопряжения истёк.' }),
  });
  await assert.rejects(() => Sync.pair('http://192.168.0.1:8765', 'expired'), /истёк/);
});

test('pullState sends a Bearer token, not Basic auth', async () => {
  let seenHeaders;
  global.fetch = async (url, options) => {
    seenHeaders = options.headers;
    return { ok: true, json: async () => ({}) };
  };
  global.Db = { replaceState: async () => {} };
  await Sync.pullState({ serverUrl: 'http://x', token: 'tok123', deviceSecret: 'sec' });
  assert.equal(seenHeaders.Authorization, 'Bearer tok123');
});

test('signRequest produces a "timestamp.hexdigest" string matching Node\'s crypto HMAC', async () => {
  const nodeCrypto = require('node:crypto');
  const secretHex = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const header = await Sync.signRequest('GET', '/api/state', '', secretHex);
  const [timestamp, digest] = header.split('.');
  const bodyHash = nodeCrypto.createHash('sha256').update('').digest('hex');
  const message = `GET\n/api/state\n${timestamp}\n${bodyHash}`;
  const expected = nodeCrypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(message).digest('hex');
  assert.equal(digest, expected);
});

test('flushQueue sends an X-Signature header derived from the request body', async () => {
  let seenHeaders;
  global.fetch = async (url, options) => {
    seenHeaders = options.headers;
    return { ok: true, json: async () => ({}) };
  };
  global.Db = {
    listPendingActions: async () => [{ client_action_id: 'a1', status: 'pending', payload: { x: 1 } }],
    markActionSynced: async () => {},
  };
  await Sync.flushQueue({ serverUrl: 'http://x', token: 'tok', deviceSecret: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
  assert.ok(seenHeaders['X-Signature']);
  assert.match(seenHeaders['X-Signature'], /^\d+\.[0-9a-f]{64}$/);
});

test('flushQueue leaves actions pending (not failed) when the server answers 401', async () => {
  // A revoked/expired session says nothing about the action's validity. Marking
  // it 'failed' would burn it, because failed actions are never auto-retried.
  let markedFailed = 0;
  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    return { ok: false, status: 401, json: async () => ({ error: 'Требуется авторизация' }) };
  };
  global.Db = {
    listPendingActions: async () => [
      { client_action_id: 'a1', status: 'pending', payload: { x: 1 } },
      { client_action_id: 'a2', status: 'pending', payload: { x: 2 } },
    ],
    markActionSynced: async () => { throw new Error('must not sync on 401'); },
    markActionFailed: async () => { markedFailed += 1; },
  };
  const result = await Sync.flushQueue({ serverUrl: 'http://x', token: 'stale' });
  assert.equal(markedFailed, 0, 'a 401 must not mark the action failed');
  assert.equal(result.failed, 0);
  assert.equal(result.flushed, 0);
  assert.equal(result.needsReauth, true);
  assert.equal(attempts, 1, 'should break out of the loop, not hammer every queued action');
});

test('pullState marks a 401 as sessionExpired', async () => {
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  global.Db = { replaceState: async () => {} };
  await assert.rejects(
    () => Sync.pullState({ serverUrl: 'http://x', token: 'stale' }),
    (err) => err.sessionExpired === true,
  );
});

test('pullState does NOT mark an ordinary server error as sessionExpired', async () => {
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  global.Db = { replaceState: async () => {} };
  await assert.rejects(
    () => Sync.pullState({ serverUrl: 'http://x', token: 'tok' }),
    (err) => err.sessionExpired === undefined,
  );
});

test('run() surfaces needsReauth:true when pullState gets a 401', async () => {
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  global.Settings = { get: async () => ({ serverUrl: 'http://x', token: 'stale' }) };
  global.Db = {
    listPendingActions: async () => [],
    replaceState: async () => {},
    listPendingPhotoUploads: async () => [],
  };
  const result = await Sync.run();
  assert.equal(result.needsReauth, true);
  assert.equal(result.pulled, false);
});

test('run() reports needsReauth:false when the server is merely unreachable', async () => {
  // Offline must stay distinguishable from "session revoked".
  global.fetch = async () => { throw new TypeError('Failed to fetch'); };
  global.Settings = { get: async () => ({ serverUrl: 'http://x', token: 'tok' }) };
  global.Db = { listPendingActions: async () => [], replaceState: async () => {}, listPendingPhotoUploads: async () => [] };
  const result = await Sync.run();
  assert.equal(result.needsReauth, false);
  assert.equal(result.pulled, false);
});

test('flushQueue marks a 409 edit conflict with status "conflict", not "failed"', async () => {
  const marked = [];
  global.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: 'Карточка была изменена на сервере.', currentAsset: { rev: 3, name: 'X' } }),
  });
  global.Db = {
    listPendingActions: async () => ([
      { client_action_id: 'a1', status: 'pending', payload: { type: 'edit', assetId: 'ast_1', baseRev: 0 } },
    ]),
    markActionConflict: async (id, currentAsset) => marked.push({ id, currentAsset }),
  };
  const result = await Sync.flushQueue({ serverUrl: 'http://x', token: 't' });
  assert.equal(result.conflicted, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(marked, [{ id: 'a1', currentAsset: { rev: 3, name: 'X' } }]);
});

test('signRequestBytes produces a "timestamp.hexdigest" string matching Node\'s crypto HMAC over raw bytes', async () => {
  const nodeCrypto = require('node:crypto');
  const secretHex = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  // A realistic multi-KB body: raw (non-UTF8-safe) bytes, as a real JPEG would be.
  const bodyBytes = new Uint8Array(50000);
  for (let i = 0; i < bodyBytes.length; i++) bodyBytes[i] = i % 256;
  const header = await Sync.signRequestBytes('POST', '/api/assets/ast_1/photo', bodyBytes, secretHex);
  const [timestamp, digest] = header.split('.');
  assert.match(timestamp, /^\d+$/);
  const bodyHash = nodeCrypto.createHash('sha256').update(Buffer.from(bodyBytes)).digest('hex');
  const message = `POST\n/api/assets/ast_1/photo\n${timestamp}\n${bodyHash}`;
  const expected = nodeCrypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(message).digest('hex');
  assert.equal(digest, expected);
});

test('signedHeadersBytes includes Authorization and X-Signature derived from the raw body bytes', async () => {
  const nodeCrypto = require('node:crypto');
  const secretHex = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const bodyBytes = new Uint8Array([1, 2, 3, 250, 251, 252, 0, 255]);
  const settings = { token: 'tok123', deviceSecret: secretHex };
  const headers = await Sync.signedHeadersBytes(settings, 'POST', '/api/assets/ast_1/photo', bodyBytes);
  assert.equal(headers.Authorization, 'Bearer tok123');
  assert.match(headers['X-Signature'], /^\d+\.[0-9a-f]{64}$/);
  const [timestamp, digest] = headers['X-Signature'].split('.');
  const bodyHash = nodeCrypto.createHash('sha256').update(Buffer.from(bodyBytes)).digest('hex');
  const message = `POST\n/api/assets/ast_1/photo\n${timestamp}\n${bodyHash}`;
  const expected = nodeCrypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(message).digest('hex');
  assert.equal(digest, expected);
});

test('signedHeadersBytes omits X-Signature when there is no deviceSecret (e.g. loopback pairing not yet done)', async () => {
  const headers = await Sync.signedHeadersBytes({ token: 'tok123' }, 'POST', '/api/assets/ast_1/photo', new Uint8Array([1]));
  assert.equal(headers.Authorization, 'Bearer tok123');
  assert.equal('X-Signature' in headers, false);
});

test('dataUrlToBytes round-trips a small string', () => {
  const dataUrl = 'data:image/jpeg;base64,' + Buffer.from('hello').toString('base64');
  const bytes = Sync.dataUrlToBytes(dataUrl);
  assert.equal(Buffer.from(bytes).toString('utf8'), 'hello');
});

test('dataUrlToBytes round-trips a realistic multi-KB binary payload (not just ASCII text)', () => {
  const original = Buffer.alloc(20000);
  for (let i = 0; i < original.length; i++) original[i] = (i * 7) % 256; // includes every byte value, not just printable ASCII
  const dataUrl = 'data:image/jpeg;base64,' + original.toString('base64');
  const bytes = Sync.dataUrlToBytes(dataUrl);
  assert.deepEqual(Buffer.from(bytes), original);
});

test('uploadPhoto POSTs the decoded bytes as the body with image/jpeg content-type and a valid signature', async () => {
  const nodeCrypto = require('node:crypto');
  const secretHex = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const original = Buffer.from('fake-jpeg-bytes-not-really-a-jpeg-but-long-enough-to-matter');
  const dataUrl = 'data:image/jpeg;base64,' + original.toString('base64');
  let seen;
  global.fetch = async (url, options) => {
    seen = { url, options };
    return { ok: true, status: 200 };
  };
  global.Settings = { get: async () => ({ serverUrl: 'http://192.168.0.1:8765', token: 'tok123', deviceSecret: secretHex }) };
  await Sync.uploadPhoto('ast_42', dataUrl);
  assert.equal(seen.url, 'http://192.168.0.1:8765/api/assets/ast_42/photo');
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.headers['Content-Type'], 'image/jpeg');
  assert.equal(seen.options.headers.Authorization, 'Bearer tok123');
  assert.deepEqual(Buffer.from(seen.options.body), original);
  const [timestamp, digest] = seen.options.headers['X-Signature'].split('.');
  const bodyHash = nodeCrypto.createHash('sha256').update(original).digest('hex');
  const message = `POST\n/api/assets/ast_42/photo\n${timestamp}\n${bodyHash}`;
  const expected = nodeCrypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(message).digest('hex');
  assert.equal(digest, expected);
});

test('uploadPhoto throws on a non-ok response', async () => {
  global.fetch = async () => ({ ok: false, status: 500 });
  global.Settings = { get: async () => ({ serverUrl: 'http://x', token: 't' }) };
  await assert.rejects(
    () => Sync.uploadPhoto('ast_1', 'data:image/jpeg;base64,' + Buffer.from('x').toString('base64')),
    /HTTP 500/,
  );
});

test('flushQueue still marks a plain 400 as "failed", unaffected by conflict handling', async () => {
  global.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'Недостаточно остатка.' }),
  });
  const failed = [];
  global.Db = {
    listPendingActions: async () => ([
      { client_action_id: 'a1', status: 'pending', payload: { type: 'issue', assetId: 'ast_1' } },
    ]),
    markActionFailed: async (id, error) => failed.push({ id, error }),
  };
  const result = await Sync.flushQueue({ serverUrl: 'http://x', token: 't' });
  assert.equal(result.failed, 1);
  assert.equal(result.conflicted, 0);
  assert.deepEqual(failed, [{ id: 'a1', error: 'Недостаточно остатка.' }]);
});

test('retryPendingPhotoUploads clears the specific queue entry on a successful upload (reuses uploadPhoto, so it signs correctly)', async () => {
  const nodeCrypto = require('node:crypto');
  const secretHex = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const dataUrl = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');
  let seen;
  const cleared = [];
  global.fetch = async (url, options) => {
    seen = { url, options };
    return { ok: true, status: 200 };
  };
  global.Settings = { get: async () => ({ serverUrl: 'http://192.168.0.1:8765', token: 'tok123', deviceSecret: secretHex }) };
  global.Db = {
    listPendingPhotoUploads: async () => ([{ assetId: 'ast_1', localPath: dataUrl, createdAt: '2026-09-04T00:00:00.000Z' }]),
    clearPendingPhotoUpload: async (assetId) => cleared.push(assetId),
  };
  await Sync.retryPendingPhotoUploads();
  assert.deepEqual(cleared, ['ast_1'], 'only the retried entry is cleared');
  assert.equal(seen.url, 'http://192.168.0.1:8765/api/assets/ast_1/photo');
  // Confirms the retry went through the real uploadPhoto() (HMAC-signed), not a second inline fetch.
  assert.ok(seen.options.headers['X-Signature']);
  assert.match(seen.options.headers['X-Signature'], /^\d+\.[0-9a-f]{64}$/);
});

test('retryPendingPhotoUploads leaves the entry queued when the upload fails (network error) — no throw, retried next Sync.run()', async () => {
  const dataUrl = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');
  let clearedCount = 0;
  global.fetch = async () => { throw new TypeError('Failed to fetch'); };
  global.Settings = { get: async () => ({ serverUrl: 'http://192.168.0.1:8765', token: 'tok123' }) };
  global.Db = {
    listPendingPhotoUploads: async () => ([{ assetId: 'ast_1', localPath: dataUrl, createdAt: '2026-09-04T00:00:00.000Z' }]),
    clearPendingPhotoUpload: async () => { clearedCount += 1; },
  };
  await assert.doesNotReject(() => Sync.retryPendingPhotoUploads());
  assert.equal(clearedCount, 0, 'a network error must leave the entry queued, not clear it');
});

test('retryPendingPhotoUploads leaves the entry queued when the server rejects the upload (non-2xx)', async () => {
  const dataUrl = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');
  let clearedCount = 0;
  global.fetch = async () => ({ ok: false, status: 500 });
  global.Settings = { get: async () => ({ serverUrl: 'http://192.168.0.1:8765', token: 'tok123' }) };
  global.Db = {
    listPendingPhotoUploads: async () => ([{ assetId: 'ast_1', localPath: dataUrl, createdAt: '2026-09-04T00:00:00.000Z' }]),
    clearPendingPhotoUpload: async () => { clearedCount += 1; },
  };
  await Sync.retryPendingPhotoUploads();
  assert.equal(clearedCount, 0);
});
