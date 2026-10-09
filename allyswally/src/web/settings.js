// Settings: an accordion of grouped sections. Each control is tagged with its
// scope — Device (saved in localStorage, affects only this phone) or Host
// (saved in config.json, affects every client) — and destructive or power
// actions require a hold-to-confirm.

import { $, el, api, store, toast, haptic, holdToConfirm, humanDuration } from './util.js';
import { THEMES, applyTheme, currentTheme, setScale, getScale, setReduceMotion, reduceMotionEnabled } from './themes.js';
import { showGuide } from './gestures.js';

let appRef = null;

export function initSettings(app) {
  appRef = app;
  app.registerShow('settings', render);
}

function render() {
  const root = $('#settings');
  root.innerHTML = '';
  root.append(
    appearanceSection(),
    mouseSection(),
    keyboardSection(),
    connectionSection(),
    hostSection(),
    dataSection(),
    diagnosticsSection(),
    serverSection(),
    aboutSection(),
  );
  // Re-open the previously open section.
  const open = store.get('settingsOpen', 'appearance');
  const match = [...root.querySelectorAll('.acc')].find(a => a.dataset.key === open);
  if (match) match.classList.add('open');
}

// ---- Accordion helper ------------------------------------------------------
function acc(key, title, bodyNodes) {
  const body = el('div', { class: 'acc-body' }, bodyNodes);
  const head = el('button', { class: 'acc-head' }, [
    el('span', { text: title }),
    el('span', { class: 'chev', html: '&#9656;' }),
  ]);
  const wrap = el('div', { class: 'acc', dataset: { key } }, [head, body]);
  head.addEventListener('click', () => {
    const willOpen = !wrap.classList.contains('open');
    wrap.classList.toggle('open', willOpen);
    if (willOpen) store.set('settingsOpen', key);
  });
  return wrap;
}

function scope(kind) {
  return el('span', { class: 'scope ' + (kind === 'host' ? 'host' : ''), text: kind === 'host' ? 'Host' : 'Device' });
}

function row(labelText, control, scopeKind, desc) {
  const left = el('div', {}, [
    el('div', {}, [el('span', { class: 'label', text: labelText }), scope(scopeKind)]),
    desc ? el('p', { class: 'set-desc', text: desc }) : null,
  ]);
  return el('div', { class: 'set-row' }, [left, control]);
}

function toggle(getVal, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = getVal();
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'switch' }, [input, el('span', { class: 'track' }), el('span', { class: 'thumb' })]);
}

function rangeControl(min, max, step, getVal, onInput, fmt) {
  const out = el('output', { text: fmt(getVal()) });
  const input = el('input', { type: 'range', min, max, step, value: getVal() });
  input.addEventListener('input', () => { onInput(input.value); out.textContent = fmt(input.value); });
  return el('div', { style: 'display:flex;align-items:center;gap:8px', }, [input, out]);
}

function selectControl(options, getVal, onChange) {
  const sel = el('select', {});
  options.forEach(([v, l]) => { const o = el('option', { value: v, text: l }); if (v === getVal()) o.selected = true; sel.appendChild(o); });
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

// ---- Appearance (Device) ---------------------------------------------------
function appearanceSection() {
  const grid = el('div', { class: 'theme-grid' });
  THEMES.forEach(t => {
    const chip = el('button', { class: 'theme-chip' + (currentTheme() === t.id ? ' active' : ''), 'data-theme-id': t.id });
    const sw = el('div', { class: 'swatch' });
    t.swatch.forEach(c => { const i = el('i'); i.style.background = c; sw.appendChild(i); });
    chip.append(sw, el('div', { class: 'name', text: t.name }));
    chip.addEventListener('click', () => {
      applyTheme(t.id); haptic(10);
      [...grid.children].forEach(c => c.classList.toggle('active', c.dataset.themeId === t.id));
    });
    grid.appendChild(chip);
  });

  const fullscreenBtn = el('button', { class: 'btn btn-sm', text: 'Enter fullscreen', onclick: () => toggleFullscreen() });

  return acc('appearance', 'Appearance', [
    el('div', { class: 'field' }, [el('label', { html: 'Theme ' }), grid]),
    row('Interface scale', rangeControl(0.85, 1.3, 0.05, () => getScale(), (v) => setScale(v), (v) => Math.round(v * 100) + '%'), 'device'),
    row('Haptic vibration (Android)', toggle(() => store.get('haptics', '1') === '1', (v) => store.set('haptics', v ? '1' : '0')), 'device'),
    row('Haptic intensity', rangeControl(10, 100, 10, () => parseInt(store.get('hapticIntensity', '100'), 10), (v) => store.set('hapticIntensity', v), (v) => v + '%'), 'device'),
    row('Reduce animations', toggle(() => reduceMotionEnabled(), (v) => setReduceMotion(v)), 'device', 'Also respects your system “reduce motion” setting.'),
    row('Show shortcut band by default', toggle(() => store.get('showBand', '1') === '1', (v) => { store.set('showBand', v ? '1' : '0'); appRef.switchTab(appRef.activeTab); }), 'device'),
    row('Fullscreen', fullscreenBtn, 'device'),
  ]);
}

function toggleFullscreen() {
  const d = document;
  if (!d.fullscreenElement) { (d.documentElement.requestFullscreen || (() => {})).call(d.documentElement); }
  else { (d.exitFullscreen || (() => {})).call(d); }
}

// ---- Mouse (Device) --------------------------------------------------------
function mouseSection() {
  return acc('mouse', 'Mouse', [
    row('Pointer speed', rangeControl(20, 300, 5, () => parseInt(store.get('dpi', '100'), 10), (v) => store.set('dpi', v), (v) => (v / 100).toFixed(2) + '×'), 'device'),
    row('Acceleration', selectControl([['none', 'None'], ['soft', 'Soft'], ['strong', 'Strong']], () => store.get('accel', 'none'), (v) => store.set('accel', v)), 'device'),
    row('Movement mode', selectControl([['abs', 'Absolute (predictable)'], ['rel', 'Relative (games)']], () => store.get('moveMode', 'abs'), (v) => { store.set('moveMode', v); appRef.setMoveMode(v === 'rel'); }), 'device'),
    row('Scroll speed', rangeControl(1, 20, 1, () => parseInt(store.get('scrollSpeed', '8'), 10), (v) => store.set('scrollSpeed', v), (v) => String(v)), 'device'),
    row('Natural scroll', toggle(() => store.get('naturalScroll', '0') === '1', (v) => store.set('naturalScroll', v ? '1' : '0')), 'device'),
    row('Tap to click', toggle(() => store.get('tapClick', '1') === '1', (v) => store.set('tapClick', v ? '1' : '0')), 'device'),
    row('Double-tap time', rangeControl(200, 500, 25, () => parseInt(store.get('doubleTapMs', '300'), 10), (v) => store.set('doubleTapMs', v), (v) => v + 'ms'), 'device'),
    row('Left-handed', toggle(() => store.get('leftHanded', '0') === '1', (v) => store.set('leftHanded', v ? '1' : '0')), 'device', 'Swaps left/right buttons and mirrors the controls.'),
  ]);
}

// ---- Keyboard (Device) -----------------------------------------------------
function keyboardSection() {
  return acc('keyboard', 'Keyboard', [
    row('Default layout', selectControl([['100', '100%'], ['80', '80%'], ['60', '60%'], ['40', '40%'], ['20', '20%']], () => store.get('kbLayout', '60'), (v) => store.set('kbLayout', v)), 'device'),
    row('Default orientation', selectControl([['0', 'Normal'], ['1', 'Landscape']], () => store.get('kbLandscape', '0'), (v) => store.set('kbLandscape', v)), 'device'),
    row('Key sound', toggle(() => store.get('keySound', '0') === '1', (v) => store.set('keySound', v ? '1' : '0')), 'device', 'Generated with Web Audio, no files.'),
    row('Native keyboard mode', selectControl([['immediate', 'Send immediately'], ['buffer', 'Buffer then send']], () => store.get('kbNativeMode', 'immediate'), (v) => store.set('kbNativeMode', v)), 'device'),
  ]);
}

// ---- Connection ------------------------------------------------------------
function connectionSection() {
  const status = appRef.connStatus || 'connecting';
  const dotClass = status === 'open' ? 'ok' : status === 'closed' ? 'bad' : 'warn';
  const statusRow = row('Status',
    el('span', {}, [el('span', { class: 'status-dot ' + dotClass }), el('span', { text: status })]), 'device');

  // Latency mini-graph.
  const graph = el('div', { class: 'mini-graph' });
  const hist = appRef.latencyHistory || [];
  const max = Math.max(60, ...hist);
  hist.forEach(ms => { const b = el('i'); b.style.height = Math.max(2, (ms / max) * 36) + 'px'; graph.appendChild(b); });
  const latRow = row(`Latency ${appRef.lastLatency != null ? appRef.lastLatency + 'ms' : '—'}`, graph, 'device');

  const host = (appRef.boot && appRef.boot.host) || {};
  const ifaceList = el('div', {});
  (host.interfaces || []).forEach(i => ifaceList.appendChild(el('p', { class: 'set-desc', text: `${i.ip} — ${i.kind} (${i.name})` })));

  const clients = el('div', {});
  (host.clients || []).forEach(c => {
    clients.appendChild(el('p', { class: 'set-desc', text: `${c.ip} · ${humanDuration(c.connectedSecs)}${c.thisDevice ? ' · this device' : ''}` }));
  });

  const logout = el('button', { class: 'btn btn-sm btn-danger', text: 'Log out this device', onclick: async () => {
    try { await api('/api/logout', { method: 'POST', body: {} }); } catch (e) {}
    const { clearToken } = await import('./util.js');
    clearToken();
    if (appRef.ws) appRef.ws.close();
    appRef.showPin('Logged out. Enter the PIN to reconnect.');
  }});

  return acc('connection', 'Connection', [
    statusRow, latRow,
    el('div', { class: 'field' }, [el('label', { text: 'Host addresses' }), ifaceList]),
    el('div', { class: 'field' }, [el('label', { text: 'Connected clients' }), (host.clients && host.clients.length) ? clients : el('p', { class: 'set-desc', text: 'none' })]),
    row('Session', logout, 'device'),
  ]);
}

// ---- Host ------------------------------------------------------------------
function hostSection() {
  const host = (appRef.boot && appRef.boot.host) || {};
  const b = host.battery || {};
  const info = el('div', {});
  const line = (t) => info.appendChild(el('p', { class: 'set-desc', text: t }));
  line(`Computer: ${host.computerName || '—'}`);
  line(`Windows: ${host.windows || '—'}`);
  if (b.present) {
    const pct = b.percent != null ? b.percent + '%' : 'unknown';
    const left = b.secondsLeft ? ` · ~${humanDuration(b.secondsLeft)} left` : '';
    line(`Battery: ${pct}${b.charging ? ' (charging)' : ''}${left}`);
  } else {
    line('Battery: none (desktop)');
  }
  line(`Host uptime: ${humanDuration(host.hostUptimeSecs || 0)}`);
  line(`Server uptime: ${humanDuration(host.serverUptimeSecs || 0)}`);
  line(`Elevated: ${host.elevated ? 'yes' : 'no'}`);
  if (!host.elevated) line('⚠ Not elevated — input to admin windows is blocked by Windows.');
  const fw = host.firewall || {};
  line(`Firewall rule: ${fw.ready ? 'in place' : 'not confirmed'}`);

  const power = (label, action, cls) => {
    const btn = el('button', { class: `btn btn-sm ${cls || ''}`, text: label });
    holdToConfirm(btn, 1000, () => doPower(action, label));
    btn.classList.add('power');
    return btn;
  };
  const powerRow = el('div', { class: 'card-actions' }, [
    power('Lock', 'lock'),
    power('Screen off', 'monitorOff'),
    power('Sleep', 'suspend'),
    power('Restart', 'reboot', 'btn-danger'),
    power('Shut down', 'shutdown', 'btn-danger'),
  ]);

  return acc('host', 'Host', [
    el('div', { class: 'field' }, [el('label', { text: 'Information' }), info]),
    el('div', { class: 'field' }, [el('label', { html: 'Power actions ' }), el('span', { class: 'scope host', text: 'Host' }), powerRow]),
    el('p', { class: 'set-desc', text: 'Power and energy actions require holding the button ~1s.' }),
  ]);
}

async function doPower(action, label) {
  try {
    await api('/api/power', { method: 'POST', body: { action } });
    toast(`${label}: sent`, 'ok');
  } catch (e) { toast(`${label} failed`, 'error'); }
}

// ---- Data ------------------------------------------------------------------
function dataSection() {
  const exportBtn = el('button', { class: 'btn btn-sm', text: 'Export configuration', onclick: doExport });
  const importBtn = el('button', { class: 'btn btn-sm', text: 'Import configuration', onclick: doImport });
  const resetDevice = el('button', { class: 'btn btn-sm btn-danger', text: 'Hold to reset this device' });
  holdToConfirm(resetDevice, 1000, () => { store.clearAll(); toast('Device settings cleared', 'ok'); setTimeout(() => location.reload(), 600); });
  const resetHost = el('button', { class: 'btn btn-sm btn-danger', text: 'Hold to reset host data' });
  holdToConfirm(resetHost, 1200, async () => {
    try { await api('/api/reset', { method: 'POST', body: { target: 'host' } }); toast('Host data reset (backup saved)', 'ok'); await appRef.refreshBootstrap(); render(); }
    catch (e) { toast('Reset failed', 'error'); }
  });
  const openFolder = el('button', { class: 'btn btn-sm', text: 'Open data folder on host', onclick: async () => {
    try { await api('/api/open-data-folder', { method: 'POST', body: {} }); } catch (e) { toast('Could not open folder', 'error'); }
  }});

  return acc('data', 'Data', [
    row('Export', exportBtn, 'host', 'Downloads one JSON with all MASKED items and config.'),
    row('Import', importBtn, 'host', 'Combine with or replace existing data. A backup is saved first.'),
    row('Reset this device', resetDevice, 'device', 'Clears local settings in this browser.'),
    row('Reset host data', resetHost, 'host', 'Restores defaults. A dated backup is saved first.'),
    row('Open data folder', openFolder, 'host'),
  ]);
}

async function doExport() {
  try {
    const res = await fetch('/api/export', { headers: { 'X-Token': store.get('token', '') } });
    const text = await res.text();
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'allyswally-config.json' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Exported', 'ok');
  } catch (e) { toast('Export failed', 'error'); }
}

function doImport() {
  const input = el('input', { type: 'file', accept: 'application/json,.json' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { toast('Not valid JSON', 'error'); return; }
    const mode = confirm('OK = Combine with existing data, Cancel = Replace everything') ? 'combine' : 'replace';
    try {
      await api('/api/import', { method: 'POST', body: { mode, data } });
      toast(`Imported (${mode})`, 'ok');
      await appRef.refreshBootstrap(); render();
    } catch (e) { toast('Import failed', 'error'); }
  });
  input.click();
}

// ---- Diagnostics -----------------------------------------------------------
function diagnosticsSection() {
  const levelSel = selectControl([['', 'All'], ['info', 'Info'], ['warning', 'Warning'], ['error', 'Error']], () => '', (v) => loadLogs(v));
  const logsBox = el('div', { class: 'logs', text: 'Loading…' });
  const errorsBox = el('div', {});
  const testBtn = el('button', { class: 'btn btn-sm', text: 'Test latency now', onclick: () => testLatency() });

  async function loadLogs(level) {
    try {
      const d = await api(`/api/diagnostics?limit=200${level ? '&level=' + level : ''}`);
      logsBox.innerHTML = '';
      (d.logs || []).slice().reverse().forEach(line => {
        const lvl = line.level || 'info';
        logsBox.appendChild(el('div', { class: 'log-line ' + lvl }, [
          el('span', { class: 'lt', text: (line.ts || '').slice(11) + ' ' }),
          document.createTextNode(`${line.event} ${extras(line)}`),
        ]));
      });
      if (!(d.logs || []).length) logsBox.textContent = 'No log entries.';
      errorsBox.innerHTML = '';
      (d.jsonErrors || []).forEach(e => errorsBox.appendChild(el('p', { class: 'set-desc', style: 'color:var(--danger)', text: `${e.file}: ${e.message} (line ${e.line}, col ${e.column})` })));
    } catch (e) { logsBox.textContent = 'Could not load logs.'; }
  }
  function extras(line) {
    return Object.keys(line).filter(k => !['ts', 'level', 'event'].includes(k)).map(k => `${k}=${JSON.stringify(line[k])}`).join(' ');
  }
  async function testLatency() {
    const t0 = performance.now();
    try { await api('/api/latency', { method: 'POST', body: {} }); toast(`Round trip ${Math.round(performance.now() - t0)}ms`, 'ok'); }
    catch (e) { toast('Test failed', 'error'); }
  }
  setTimeout(() => loadLogs(''), 0);

  return acc('diagnostics', 'Diagnostics', [
    row('Filter level', levelSel, 'device'),
    el('div', { class: 'field' }, [el('label', { text: 'Recent logs' }), logsBox]),
    el('div', { class: 'field' }, [el('label', { text: 'JSON errors' }), errorsBox]),
    row('Latency test', testBtn, 'device'),
  ]);
}

// ---- Server ----------------------------------------------------------------
function serverSection() {
  const regen = el('button', { class: 'btn btn-sm btn-danger', text: 'Hold to regenerate PIN' });
  holdToConfirm(regen, 1200, async () => {
    try { await api('/api/server', { method: 'POST', body: { action: 'regenPin' } }); }
    catch (e) {}
    // The server kicks everyone; the WebSocket kick handler shows the PIN screen.
  });
  const stop = el('button', { class: 'btn btn-sm btn-danger', text: 'Hold to stop server' });
  holdToConfirm(stop, 1500, async () => {
    try { await api('/api/server', { method: 'POST', body: { action: 'stop' } }); } catch (e) {}
    toast('Server stopping…');
  });
  return acc('server', 'Server', [
    row('Regenerate PIN', regen, 'host', 'New PIN on the console; all sessions are kicked, including this one.'),
    row('Stop server', stop, 'host', 'Closes the process cleanly and flushes logs.'),
    el('p', { class: 'set-desc', text: 'Blocked IPs are only cleared by restarting the process — by design.' }),
  ]);
}

// ---- About -----------------------------------------------------------------
function aboutSection() {
  const boot = appRef.boot || {};
  const logo = el('img', { src: '/icon.svg', width: 56, height: 56, alt: '' });
  const guideBtn = el('button', { class: 'btn btn-sm', text: 'Show gesture guide', onclick: () => showGuide(true) });
  return acc('about', 'About', [
    el('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:8px' }, [
      logo,
      el('div', {}, [
        el('div', { style: 'font-weight:700;font-size:1.1rem', text: 'AllySwally' }),
        el('div', { class: 'set-desc', text: `v${boot.version || '1.0.0'} · built ${boot.buildDate || ''}` }),
      ]),
    ]),
    el('p', { class: 'set-desc', text: 'Developer: ZONEVICE. Built with Claude Code Opus 4.8, Max effort.' }),
    el('p', { class: 'set-desc', text: 'A LAN assistance tool for a Windows handheld — trackpad, keyboard and power-user commands from your phone.' }),
    row('Gestures', guideBtn, 'device'),
  ]);
}
