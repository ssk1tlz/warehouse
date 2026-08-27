function getPreferences() {
  return Capacitor.Plugins.Preferences;
}

async function get(preferences = getPreferences()) {
  const [urlResult, tokenResult, secretResult] = await Promise.all([
    preferences.get({ key: 'serverUrl' }),
    preferences.get({ key: 'authToken' }),
    preferences.get({ key: 'deviceSecret' }),
  ]);
  return {
    serverUrl: (urlResult.value || '').replace(/\/$/, ''),
    token: tokenResult.value || '',
    deviceSecret: secretResult.value || '',
  };
}

async function set({ serverUrl, token, deviceSecret }, preferences = getPreferences()) {
  await preferences.set({ key: 'serverUrl', value: (serverUrl || '').replace(/\/$/, '') });
  await preferences.set({ key: 'authToken', value: token || '' });
  await preferences.set({ key: 'deviceSecret', value: deviceSecret || '' });
}

const Settings = { get, set };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Settings;
}
if (typeof window !== 'undefined') {
  window.Settings = Settings;
}
