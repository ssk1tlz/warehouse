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

// Bytes-native counterparts to signRequest/signedHeaders above, for bodies that
// are raw binary (e.g. a JPEG) rather than text — a blob's bytes can't safely
// round-trip through a JS string, so this hashes/signs the Uint8Array directly
// instead of going through TextEncoder. Kept separate from signRequest/
// signedHeaders (used by the tested, working JSON-action sync path) so this
// addition carries zero risk to that path.
async function signRequestBytes(method, path, bodyBytes, secretHex) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHashBuffer = await crypto.subtle.digest('SHA-256', bodyBytes);
  const bodyHashHex = toHex(new Uint8Array(bodyHashBuffer));
  const message = `${method}\n${path}\n${timestamp}\n${bodyHashHex}`;
  const key = await crypto.subtle.importKey('raw', fromHex(secretHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return `${timestamp}.${toHex(new Uint8Array(signatureBuffer))}`;
}

async function signedHeadersBytes(settings, method, path, bodyBytes) {
  const headers = settings.token ? { Authorization: `Bearer ${settings.token}` } : {};
  if (settings.deviceSecret) {
    headers['X-Signature'] = await signRequestBytes(method, path, bodyBytes, settings.deviceSecret);
  }
  return headers;
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Shared by this task's immediate-upload attempt and Task C6's retry loop —
// both paths sign correctly with zero duplicated upload logic.
//
// The body is sent as a File, NOT a raw Uint8Array. This project runs with
// CapacitorHttp.enabled: true, which patches window.fetch on real devices:
// its convertBody() TextDecoder().decode()'s a Uint8Array body into a JS
// string, corrupting any bytes that aren't valid UTF-8 (which a JPEG almost
// always contains) before it ever reaches the network. A File body takes a
// different, byte-exact branch (base64-encoded and decoded back to the
// original bytes on the Java side), so the server receives exactly what was
// captured. The HMAC signature is still computed over the original
// `bodyBytes` (not the File) — since File preserves those bytes exactly,
// the signature the server checks against still matches what it receives.
async function uploadPhoto(assetId, dataUrl) {
  const settings = await Settings.get();
  const bodyBytes = dataUrlToBytes(dataUrl);
  const bodyFile = new File([bodyBytes], 'photo.jpg', { type: 'image/jpeg' });
  const path = `/api/assets/${assetId}/photo`;
  const headers = { 'Content-Type': 'image/jpeg', ...(await signedHeadersBytes(settings, 'POST', path, bodyBytes)) };
  const response = await fetch(`${settings.serverUrl}${path}`, { method: 'POST', headers, body: bodyFile });
  if (!response.ok) {
    // A non-2xx here means the server explicitly rejected THIS request
    // (403 wrong role, 404 asset deleted, 400 body too large, ...) — retrying
    // the identical request will never succeed. Mark the error `.permanent`
    // so callers (retryPendingPhotoUploads below, and screens.js's
    // uploadOrQueuePhoto) can tell it apart from a network-level throw
    // (genuinely offline/unreachable — transient, worth retrying).
    const error = new Error(`upload failed: HTTP ${response.status}`);
    error.permanent = true;
    error.status = response.status;
    throw error;
  }
}

// GET counterpart to uploadPhoto() above, for displaying an asset's photo on
// the asset screen (screens.js's openAssetScreen -> renderAssetPhotoPreview,
// mirroring desktop's app.js renderAssetPhotoPreview). Uses the text
// signRequest/signedHeaders (not the bytes variant) since a GET has no body.
// Returns the raw Response (ok or not) rather than throwing on a non-2xx —
// the caller checks response.ok itself, same shape as desktop's apiFetch(),
// so a 404 (genuinely no photo yet) is handled by the caller as "show
// placeholder" rather than as a thrown error.
async function getPhoto(assetId) {
  const settings = await Settings.get();
  const path = `/api/assets/${assetId}/photo`;
  const headers = await signedHeaders(settings, 'GET', path, '');
  return fetch(`${settings.serverUrl}${path}`, { headers });
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
  let conflicted = 0;
  let needsReauth = false;
  for (const row of pending) {
    if (row.status === 'failed' || row.status === 'conflict') continue; // surfaced, retried explicitly
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
      } else if (response.status === 401) {
        // The session was revoked/expired — the action itself is perfectly
        // valid, so do NOT mark it 'failed' (failed actions are never
        // auto-retried). Leave it 'pending' and stop, exactly like the
        // network-error path below; it flushes once the device is re-paired.
        needsReauth = true;
        break;
      } else if (response.status === 409) {
        const body = await response.json().catch(() => ({ currentAsset: {} }));
        await Db.markActionConflict(row.client_action_id, body.currentAsset || {});
        conflicted += 1;
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
  return { flushed, failed, conflicted, needsReauth };
}

// Drains pending_photo_uploads the same way flushQueue drains pending_actions:
// reuses Sync.uploadPhoto() (correctly signed, see Task C5) so there's no
// second upload implementation. A failed attempt (still offline, server
// unreachable) leaves the entry queued for the next Sync.run() to retry.
async function retryPendingPhotoUploads() {
  const pending = await Db.listPendingPhotoUploads();
  for (const photo of pending) {
    try {
      await uploadPhoto(photo.assetId, photo.localPath);
      await Db.clearPendingPhotoUpload(photo.assetId);
    } catch (err) {
      if (err && err.permanent) {
        // The server definitively rejected this exact upload — retrying it
        // again next Sync.run() would just fail the same way forever
        // (e.g. the role changed, the asset was deleted, the body was too
        // large). Drop it from the queue instead of looping silently, and
        // surface the loss rather than hiding it.
        await Db.clearPendingPhotoUpload(photo.assetId);
        const message = `Не удалось отправить фото (HTTP ${err.status}). Снято с очереди.`;
        if (typeof Toast !== 'undefined' && Toast && typeof Toast.show === 'function') {
          Toast.show(message, 'error');
        } else {
          console.error(message);
        }
        continue;
      }
      // Still offline or server unreachable — leave it queued, retry next Sync.run().
    }
  }
}

async function pullState(settings) {
  const headers = await signedHeaders(settings, 'GET', '/api/state', '');
  const response = await fetch(`${settings.serverUrl}/api/state`, { headers });
  if (!response.ok) {
    const error = new Error(`GET /api/state failed: HTTP ${response.status}`);
    // Distinguishes "your session is gone, re-pair this device" from
    // "no network" — same flag name apiFetch() uses in the desktop app.js.
    if (response.status === 401) error.sessionExpired = true;
    throw error;
  }
  const state = await response.json();
  await Db.replaceState(state);
}

async function run() {
  const settings = await Settings.get();
  if (!settings.serverUrl || !settings.token) return { pulled: false, flushed: 0, failed: 0, needsReauth: false };
  const { flushed, failed, needsReauth } = await flushQueue(settings);
  await retryPendingPhotoUploads();
  let pulled = false;
  let sessionExpired = Boolean(needsReauth);
  try {
    await pullState(settings);
    pulled = true;
  } catch (err) {
    // Offline or server unreachable — the cache from the last successful pull stays as-is.
    // A 401 is different in kind: the server IS reachable, it rejected us.
    pulled = false;
    if (err && err.sessionExpired) sessionExpired = true;
  }
  return { pulled, flushed, failed, needsReauth: sessionExpired };
}

const Sync = { run, flushQueue, pullState, pair, signRequest, signedHeaders, signRequestBytes, signedHeadersBytes, dataUrlToBytes, uploadPhoto, retryPendingPhotoUploads, getPhoto };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Sync;
}
if (typeof window !== 'undefined') {
  window.Sync = Sync;
}
