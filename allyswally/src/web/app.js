// Orchestrator: the PIN gate, tab switching, the WebSocket lifecycle, and
// wiring the four tab modules together. Each module exposes an `init(app)` and
// an optional `onShow()` hook; `app` is the shared context they talk through.

import { $, $$, api, store, getToken, setToken, clearToken, toast } from './util.js';
import { WsClient } from './net.js';
import { applyTheme, currentTheme, updateRgbLoop } from './themes.js';
import { initMouse } from './mouse.js';
import { initKeyboard } from './keyboard.js';
import { initMasked } from './masked.js';
import { initSettings } from './settings.js';
import { initBand, renderBand } from './band.js';
import { showGuide } from './gestures.js';

const app = {
  ws: null,
  boot: null,
  activeTab: 'mouse',
  latencyHistory: [],
  hooks: { onShow: {} },

  send(obj) { this.ws && this.ws.send(obj); },
  move(dx, dy) { this.ws && this.ws.move(dx, dy); },
  scroll(v, h) { this.ws && this.ws.scroll(v, h); },
  setMoveMode(rel) { this.ws && this.ws.setMoveMode(rel); },

  async refreshBootstrap() {
    this.boot = await api('/api/bootstrap');
    renderBand(app, this.boot.band || []);
    return this.boot;
  },

  switchTab(name) {
    this.activeTab = name;
    $$('.tab').forEach(t => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.panel').forEach(p => { p.hidden = p.id !== `tab-${name}`; });
    // The band belongs to Mouse and Keyboard only.
    const bandVisible = (name === 'mouse' || name === 'keyboard') && store.get('showBand', '1') === '1';
    $('#band').hidden = !bandVisible;
    const hook = this.hooks.onShow[name];
    if (hook) hook();
  },

  registerShow(name, fn) { this.hooks.onShow[name] = fn; },
};

// ---- PIN gate --------------------------------------------------------------

function showPin(message = '', kind = '') {
  $('#app').hidden = true;
  $('#pin-screen').hidden = false;
  const m = $('#pin-message');
  m.textContent = message;
  m.className = 'pin-message' + (kind ? ' ' + kind : '');
  const input = $('#pin-input');
  input.value = '';
  setTimeout(() => input.focus(), 50);
}

function wirePin() {
  const form = $('#pin-form');
  const input = $('#pin-input');
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = input.value.trim();
    if (pin.length < 1) return;
    try {
      const res = await api('/api/pin', { method: 'POST', body: { pin } });
      if (res && res.token) {
        setToken(res.token);
        await enterApp();
      }
    } catch (err) {
      if (err.status === 429) {
        showPin('This device is locked after 3 wrong tries. Restart AllySwally on the host to unlock.', 'error');
      } else if (err.body && err.body.error === 'wrong') {
        const left = err.body.remaining;
        showPin(`Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left before lockout.`, 'error');
      } else {
        showPin('Could not verify the PIN. Check the connection.', 'error');
      }
    }
  });
}

// ---- Enter the app ---------------------------------------------------------

async function enterApp() {
  try {
    app.boot = await api('/api/bootstrap');
  } catch (err) {
    if (err.status === 401) { clearToken(); showPin(''); return; }
    showPin('Could not load. Retrying…'); setTimeout(enterApp, 1200); return;
  }

  $('#pin-screen').hidden = true;
  $('#app').hidden = false;

  connectWs();
  initBand(app);
  renderBand(app, app.boot.band || []);

  // URL params let the screenshot harness jump to a tab/theme behind the gate.
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme');
  if (theme) applyTheme(theme);
  const wantTab = params.get('tab') || store.get('lastTab', 'mouse');
  app.switchTab(wantTab);

  // First-run gesture guide.
  if (store.get('guideSeen', '0') !== '1') {
    showGuide(false);
    store.set('guideSeen', '1');
  }
}

function connectWs() {
  if (app.ws) app.ws.close();
  app.ws = new WsClient({
    onStatus: (s) => updateConnStatus(s),
    onLatency: (ms) => updateLatency(ms),
    onEvent: (type, msg) => handleWsEvent(type, msg),
  });
  app.ws.connect();
}

function handleWsEvent(type, msg) {
  switch (type) {
    case 'authOk':
      updateConnStatus('open');
      break;
    case 'authFail':
      clearToken();
      showPin('Session no longer valid. Enter the PIN again.');
      break;
    case 'kick':
      clearToken();
      showPin(msg.reason === 'pinRegenerated'
        ? 'The PIN was regenerated on the host. Enter the new PIN.'
        : 'Disconnected by the host.');
      break;
    case 'bandReload':
      app.boot.band = msg.band || [];
      renderBand(app, app.boot.band);
      break;
    case 'configChanged':
      // Refresh bootstrap so settings/host data stay current.
      app.refreshBootstrap().then(() => {
        const hook = app.hooks.onShow[app.activeTab];
        if (hook) hook();
      }).catch(() => {});
      break;
    case 'runResult':
      reportRun(msg.result);
      break;
  }
}

function reportRun(result) {
  if (!result) return;
  if (result.ok === false) { toast(result.error || 'Command failed', 'error'); return; }
  if (result.kind === 'script' && result.launched && !result.detached) {
    const code = result.exitCode;
    toast(result.timedOut ? 'Script timed out' : `Script exited (${code})`, result.timedOut ? 'error' : 'ok');
  } else {
    toast('Done', 'ok');
  }
}

// ---- Connection + latency indicators --------------------------------------

function updateConnStatus(status) {
  const lat = $('#latency');
  if (status === 'reconnecting' || status === 'connecting') {
    lat.textContent = '…'; lat.className = 'latency mid';
  } else if (status === 'closed') {
    lat.textContent = 'off'; lat.className = 'latency bad';
  }
  app.connStatus = status;
  const hook = app.hooks.onShow.settings;
  if (app.activeTab === 'settings' && hook) hook();
}

function updateLatency(ms) {
  const lat = $('#latency');
  lat.textContent = `${ms}ms`;
  lat.className = 'latency ' + (ms < 40 ? 'good' : ms < 120 ? 'mid' : 'bad');
  app.latencyHistory.push(ms);
  if (app.latencyHistory.length > 40) app.latencyHistory.shift();
  app.lastLatency = ms;
}

// ---- Tabs ------------------------------------------------------------------

function wireTabs() {
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      app.switchTab(tab.dataset.tab);
      store.set('lastTab', tab.dataset.tab);
    });
  });
  $('#band-toggle').addEventListener('click', () => {
    const show = store.get('showBand', '1') === '1';
    store.set('showBand', show ? '0' : '1');
    app.switchTab(app.activeTab);
  });
}

// ---- Boot ------------------------------------------------------------------

function main() {
  applyTheme(currentTheme());
  updateRgbLoop();
  wirePin();
  wireTabs();

  // Build the tab modules up front (their panels exist in the DOM).
  initMouse(app);
  initKeyboard(app);
  initMasked(app);
  initSettings(app);

  // Try to enter directly: with a stored token, or when the host runs in the
  // debug no-auth mode (bootstrap succeeds without a token). A 401 falls back
  // to the PIN screen.
  enterApp();
}

// Expose a tiny surface for modules that need to re-enter the PIN screen
// (e.g. the Settings "log out" action) without a circular import.
app.showPin = showPin;
app.enterApp = enterApp;
app.reconnect = connectWs;

document.addEventListener('DOMContentLoaded', main);
window.__app = app; // handy for debugging in the browser console
