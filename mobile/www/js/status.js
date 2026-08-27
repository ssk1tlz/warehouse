let connected = false;

function render() {
  const el = document.getElementById('connStatus');
  el.textContent = connected ? '● Подключено' : '● Офлайн';
  el.classList.toggle('online', connected);
  el.classList.toggle('offline', !connected);
}

function report(pulled) {
  connected = pulled;
  render();
}

function start() {
  render();
  setInterval(() => Sync.run().then((r) => report(r.pulled)), 15000);
}

window.ConnStatus = { start, report };
