function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function signRequest(method, path, bodyText, secretHex) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyBytes = new TextEncoder().encode(bodyText || '');
  const bodyHashBuffer = await crypto.subtle.digest('SHA-256', bodyBytes);
  const bodyHashHex = toHex(new Uint8Array(bodyHashBuffer));
  const message = `${method}\n${path}\n${timestamp}\n${bodyHashHex}`;
  const key = await crypto.subtle.importKey('raw', fromHex(secretHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return `${timestamp}.${toHex(new Uint8Array(signatureBuffer))}`;
}

async function signedHeaders(settings, method, path, bodyText) {
  const headers = settings.token ? { Authorization: `Bearer ${settings.token}` } : {};
  if (settings.deviceSecret) {
    headers['X-Signature'] = await signRequest(method, path, bodyText, settings.deviceSecret);
  }
  return headers;
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
      const bodyText = JSON.stringify(row.payload);
      const headers = { 'Content-Type': 'application/json', ...(await signedHeaders(settings, 'POST', '/api/mobile/action', bodyText)) };
      const response = await fetch(`${settings.serverUrl}/api/mobile/action`, {
        method: 'POST',
        headers,
        body: bodyText,
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
  const headers = await signedHeaders(settings, 'GET', '/api/state', '');
  const response = await fetch(`${settings.serverUrl}/api/state`, { headers });
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

const Sync = { run, flushQueue, pullState, pair, signRequest };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Sync;
}
if (typeof window !== 'undefined') {
  window.Sync = Sync;
}
