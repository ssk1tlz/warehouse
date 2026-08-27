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
  };
  const result = await Sync.run();
  assert.equal(result.needsReauth, true);
  assert.equal(result.pulled, false);
});

test('run() reports needsReauth:false when the server is merely unreachable', async () => {
  // Offline must stay distinguishable from "session revoked".
  global.fetch = async () => { throw new TypeError('Failed to fetch'); };
  global.Settings = { get: async () => ({ serverUrl: 'http://x', token: 'tok' }) };
  global.Db = { listPendingActions: async () => [], replaceState: async () => {} };
  const result = await Sync.run();
  assert.equal(result.needsReauth, false);
  assert.equal(result.pulled, false);
});
