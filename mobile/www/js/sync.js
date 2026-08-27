function authHeaders(settings) {
  return settings.token ? { Authorization: `Bearer ${settings.token}` } : {};
}

async function pair(serverUrl, code) {
  const response = await fetch(`${serverUrl}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function flushQueue(settings) {
  const pending = await Db.listPendingActions();
  let flushed = 0;
  let failed = 0;
  for (const row of pending) {
    if (row.status === 'failed') continue; // don't auto-retry — surface it, let the user retry explicitly (queue screen, Task 8)
    try {
      const response = await fetch(`${settings.serverUrl}/api/mobile/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(settings) },
        body: JSON.stringify(row.payload),
      });
      if (response.ok) {
        await Db.markActionSynced(row.client_action_id);
        flushed += 1;
      } else {
        const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        await Db.markActionFailed(row.client_action_id, body.error || `HTTP ${response.status}`);
        failed += 1;
      }
    } catch (err) {
      // Network error mid-flush (e.g. Wi-Fi dropped) — leave it 'pending', try again next Sync.run().
      break;
    }
  }
  return { flushed, failed };
}

async function pullState(settings) {
  const response = await fetch(`${settings.serverUrl}/api/state`, {
    headers: authHeaders(settings),
  });
  if (!response.ok) throw new Error(`GET /api/state failed: HTTP ${response.status}`);
  const state = await response.json();
  await Db.replaceState(state);
}

async function run() {
  const settings = await Settings.get();
  if (!settings.serverUrl || !settings.token) return { pulled: false, flushed: 0, failed: 0 };
  const { flushed, failed } = await flushQueue(settings);
  let pulled = false;
  try {
    await pullState(settings);
    pulled = true;
  } catch (err) {
    // Offline or server unreachable — the cache from the last successful pull stays as-is.
    pulled = false;
  }
  return { pulled, flushed, failed };
}

const Sync = { run, flushQueue, pullState, pair };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Sync;
}
if (typeof window !== 'undefined') {
  window.Sync = Sync;
}
