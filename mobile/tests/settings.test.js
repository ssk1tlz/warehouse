const test = require('node:test');
const assert = require('node:assert/strict');
const Settings = require('../www/js/settings.js');

function fakePreferences() {
  const store = new Map();
  return {
    get: async ({ key }) => ({ value: store.has(key) ? store.get(key) : null }),
    set: async ({ key, value }) => { store.set(key, value); },
  };
}

test('get() returns empty defaults when nothing stored', async () => {
  const prefs = fakePreferences();
  assert.deepEqual(await Settings.get(prefs), { serverUrl: '', token: '', deviceSecret: '', role: '' });
});

test('set() then get() round-trips serverUrl/token/deviceSecret/role', async () => {
  const prefs = fakePreferences();
  await Settings.set({ serverUrl: 'http://192.168.0.1:8765', token: 'tok123', deviceSecret: 'sec456', role: 'admin' }, prefs);
  assert.deepEqual(await Settings.get(prefs), {
    serverUrl: 'http://192.168.0.1:8765', token: 'tok123', deviceSecret: 'sec456', role: 'admin',
  });
});

test('set() strips a trailing slash from serverUrl', async () => {
  const prefs = fakePreferences();
  await Settings.set({ serverUrl: 'http://192.168.0.1:8765/', token: 't', deviceSecret: 's' }, prefs);
  const result = await Settings.get(prefs);
  assert.equal(result.serverUrl, 'http://192.168.0.1:8765');
});
