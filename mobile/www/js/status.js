let connected = false;
let reauthNeeded = false;

function render() {
  const el = document.getElementById('connStatus');
  // "Сеанс истёк" is a different problem from "офлайн": the server IS reachable,
  // it rejected our token. Showing plain "Офлайн" would send the user hunting
  // for a Wi-Fi problem that doesn't exist.
  if (reauthNeeded) {
    el.textContent = '● Нужна привязка';
    el.classList.remove('online', 'offline');
    el.classList.add('expired');
    return;
  }
  el.textContent = connected ? '● Подключено' : '● Офлайн';
  el.classList.remove('expired');
  el.classList.toggle('online', connected);
  el.classList.toggle('offline', !connected);
}

function report(pulled, needsReauth) {
  connected = pulled;
  reauthNeeded = Boolean(needsReauth);
  render();
}

function start() {
  render();
  setInterval(() => Sync.run().then((r) => report(r.pulled, r.needsReauth)), 15000);
}

window.ConnStatus = { start, report };
