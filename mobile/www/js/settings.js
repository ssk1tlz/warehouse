const { Preferences } = Capacitor.Plugins;

async function get() {
  const [urlResult, pwResult] = await Promise.all([
    Preferences.get({ key: 'serverUrl' }),
    Preferences.get({ key: 'serverPassword' }),
  ]);
  return {
    serverUrl: (urlResult.value || '').replace(/\/$/, ''), // strip trailing slash so `${serverUrl}/api/...` never double-slashes
    password: pwResult.value || '',
  };
}

async function set({ serverUrl, password }) {
  await Preferences.set({ key: 'serverUrl', value: (serverUrl || '').replace(/\/$/, '') });
  await Preferences.set({ key: 'serverPassword', value: password || '' });
}

window.Settings = { get, set };
