// Small shared helpers: DOM, storage, fetch, haptics, toasts, hold-to-confirm.
// No framework; everything here is plain DOM and fetch.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Create an element with properties/attributes and children. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v === false || v == null) { /* skip */ }
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- Local storage (per-device settings) ----------------------------------
const PREFIX = 'allyswally.';
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, value); } catch (e) {}
  },
  getJSON(key, fallback) {
    const v = this.get(key, null);
    if (v == null) return fallback;
    try { return JSON.parse(v); } catch (e) { return fallback; }
  },
  setJSON(key, value) { this.set(key, JSON.stringify(value)); },
  remove(key) { try { localStorage.removeItem(PREFIX + key); } catch (e) {} },
  clearAll() {
    try {
      Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).forEach(k => localStorage.removeItem(k));
    } catch (e) {}
  },
};

export const getToken = () => store.get('token', null);
export const setToken = (t) => store.set('token', t);
export const clearToken = () => store.remove('token');

/** Authenticated JSON fetch. Throws {status, body} on failure. */
export async function api(path, { method = 'GET', body = null } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers['X-Token'] = token;
  if (body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    body: body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = text; }
  if (!res.ok) throw { status: res.status, body: parsed };
  return parsed;
}

// ---- Haptics (Android only; iOS has no vibrate) ----------------------------
export function haptic(ms = 10) {
  if (store.get('haptics', '1') !== '1') return;
  const intensity = parseInt(store.get('hapticIntensity', '100'), 10) / 100;
  try { if (navigator.vibrate) navigator.vibrate(Math.max(1, Math.round(ms * intensity))); } catch (e) {}
}

// ---- Toasts ----------------------------------------------------------------
export function toast(message, kind = '') {
  const host = $('#toasts');
  if (!host) return;
  const t = el('div', { class: `toast ${kind}`, text: message });
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 2200);
}

// ---- Hold-to-confirm -------------------------------------------------------
/**
 * Wire a button so it must be held ~`duration` ms (with a filling progress bar)
 * before `onComplete` fires. Guards destructive and power actions.
 */
export function holdToConfirm(button, duration, onComplete) {
  const fill = el('span', { class: 'fill' });
  button.classList.add('hold');
  button.appendChild(fill);
  let raf = null, start = 0, done = false;

  const step = (now) => {
    if (!start) start = now;
    const pct = clamp((now - start) / duration, 0, 1);
    fill.style.width = (pct * 100) + '%';
    if (pct >= 1) {
      if (!done) { done = true; haptic(40); onComplete(); }
      reset();
    } else {
      raf = requestAnimationFrame(step);
    }
  };
  const begin = (e) => {
    e.preventDefault();
    done = false; start = 0;
    raf = requestAnimationFrame(step);
    haptic(8);
  };
  const reset = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = null; start = 0;
    fill.style.width = '0%';
  };
  button.addEventListener('pointerdown', begin);
  button.addEventListener('pointerup', reset);
  button.addEventListener('pointercancel', reset);
  button.addEventListener('pointerleave', reset);
  return button;
}

// ---- Key click sound (Web Audio, no audio files) ---------------------------
let audioCtx = null;
export function keyClick() {
  if (store.get('keySound', '0') !== '1') return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = 440 + Math.random() * 60;
    gain.gain.setValueAtTime(0.04, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.05);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.06);
  } catch (e) {}
}

// ---- Modal ----------------------------------------------------------------
/** Open the shared modal overlay with a content node. Returns a close fn. */
export function openModal(contentNode) {
  const host = $('#modal');
  host.innerHTML = '';
  const card = el('div', { class: 'modal-card' }, [contentNode]);
  host.appendChild(card);
  host.hidden = false;
  const onBackdrop = (e) => { if (e.target === host) close(); };
  host.addEventListener('pointerdown', onBackdrop);
  function close() { host.hidden = true; host.innerHTML = ''; host.removeEventListener('pointerdown', onBackdrop); }
  return close;
}

/** Format a seconds count as a compact duration like "1h 20m" or "45s". */
export function humanDuration(secs) {
  secs = Math.max(0, Math.floor(secs));
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
