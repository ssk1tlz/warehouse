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
