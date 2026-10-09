// Virtual keyboards, hand-built from HTML/CSS. Several sizes (100/80/60/40/20
// %), a symbols layer, a command centre (F-keys, media), a landscape toggle
// that rotates without turning the device, and a bridge to the device's own
// native keyboard. Character keys send layout-independent Unicode text; letters
// combined with Ctrl/Alt/Win send a key combo so shortcuts work; special keys
// send named key events.

import { $, el, store, haptic, toast, keyClick } from './util.js';

// Shift map for the US number/symbol row.
const SHIFT = {
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*',
  '9': '(', '0': ')', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':',
  "'": '"', ',': '<', '.': '>', '/': '?', '`': '~',
};

const SIZES = [
  { id: '100', label: '100%' },
  { id: '80', label: '80%' },
  { id: '60', label: '60%' },
  { id: '40', label: '40%' },
  { id: '20', label: '20%' },
  { id: 'symbols', label: 'Sym' },
  { id: 'nav', label: 'Nav' },
];

// Special-key factory.
const K = (name, label, cls = 'mod', flex) => ({ t: 'k', name, label: label || name, cls, flex });
// Character key.
const C = (c) => ({ t: 'c', c });
const chars = (s) => s.split('').map(C);

function layout(id) {
  const fnRow = [K('esc', 'Esc'), K('f1', 'F1'), K('f2', 'F2'), K('f3', 'F3'), K('f4', 'F4'),
    K('f5', 'F5'), K('f6', 'F6'), K('f7', 'F7'), K('f8', 'F8'), K('f9', 'F9'), K('f10', 'F10'),
    K('f11', 'F11'), K('f12', 'F12')];
  const numRow = [...chars('1234567890'), C('-'), C('='), K('backspace', '⌫', 'mod', 1.6)];
  const qRow = [...chars('qwertyuiop'), C('['), C(']'), C('\\')];
  const aRow = [...chars('asdfghjkl'), C(';'), C("'"), K('enter', '⏎', 'mod', 1.8)];
  const zRow = [K('shift', '⇧', 'mod shiftkey', 1.6), ...chars('zxcvbnm'), C(','), C('.'), C('/'), K('shift', '⇧', 'mod shiftkey', 1.6)];
  const arrows = [K('up', '↑'), K('down', '↓'), K('left', '←'), K('right', '→')];
  const bottom = [K('ctrl', 'Ctrl'), K('win', 'Win'), K('alt', 'Alt'),
    { t: 'c', c: ' ', label: 'space', cls: 'space' }, K('alt', 'Alt'), K('menu', '☰'), K('ctrl', 'Ctrl')];

  switch (id) {
    case '100':
      return [fnRow, numRow, qRow, aRow, zRow, [...bottom, ...arrows]];
    case '80':
      return [numRow, qRow, aRow, zRow, [...bottom, ...arrows]];
    case '60':
      return [numRow, qRow, aRow, zRow, bottom];
    case '40':
      return [qRow, aRow, zRow,
        [K('ctrl', 'Ctrl'), K('alt', 'Alt'), { t: 'c', c: ' ', label: 'space', cls: 'space' }, K('backspace', '⌫'), K('enter', '⏎')]];
    case '20':
      return [[K('esc', 'Esc'), K('tab', 'Tab'), { t: 'c', c: ' ', label: 'space', cls: 'space' }, K('backspace', '⌫'), K('enter', '⏎')],
        arrows];
    case 'symbols':
      return [
        chars('!@#$%^&*()'),
        chars('`~-_=+[]{}'),
        chars('\\|;:\'",.'),
        [...chars('<>/?'), K('backspace', '⌫'), K('enter', '⏎', 'mod', 1.6)],
      ];
    case 'nav':
      return [
        [K('home', 'Home'), K('up', '↑'), K('end', 'End'), K('pageup', 'PgUp')],
        [K('left', '←'), K('down', '↓'), K('right', '→'), K('pagedown', 'PgDn')],
        [K('insert', 'Ins'), K('delete', 'Del'), K('tab', 'Tab'), K('esc', 'Esc')],
        [K('ctrl', 'Ctrl'), K('alt', 'Alt'), { t: 'c', c: ' ', label: 'space', cls: 'space' }, K('enter', '⏎')],
      ];
    default:
      return layout('60');
  }
}

export function initKeyboard(app) {
  const stage = $('#keyboard');
  const layoutBar = $('#kb-layouts');
  const cmd = $('#kb-command');
  const native = $('#native-buffer');

  // Modifier arming state. Ctrl/Alt/Win arm for the next key; Shift can lock.
  const armed = new Set();
  let shiftLocked = false;

  // Build the layout selector.
  SIZES.forEach(size => {
    const chip = el('button', {
      class: 'chip', text: size.label, 'data-size': size.id,
      onclick: () => selectSize(size.id),
    });
    layoutBar.appendChild(chip);
  });

  // Command centre.
  const commands = [
    K('esc', 'Esc'), K('tab', 'Tab'), K('delete', 'Del'), K('printscreen', 'PrtSc'),
    K('voldown', '🔉'), K('volup', '🔊'), K('mute', '🔇'), K('playpause', '⏯'),
    K('home', 'Home'), K('end', 'End'), K('pageup', 'PgUp'), K('pagedown', 'PgDn'),
  ];
  commands.forEach(k => {
    const btn = el('button', { class: 'key', text: k.label, 'aria-label': k.name,
      onclick: () => { pressSpecial(k.name); } });
    cmd.appendChild(btn);
  });

  function selectSize(id) {
    store.set('kbLayout', id);
    [...layoutBar.children].forEach(c => c.classList.toggle('active', c.dataset.size === id));
    render(id);
  }

  function render(id) {
    stage.innerHTML = '';
    const rows = layout(id);
    const wrap = el('div', { class: 'kb-rows' });
    rows.forEach(row => {
      const r = el('div', { class: 'kb-row' });
      row.forEach(tok => r.appendChild(buildKey(tok)));
      wrap.appendChild(r);
    });
    stage.appendChild(wrap);
    refreshShiftLabels();
  }

  function buildKey(tok) {
    if (tok.t === 'c') {
      const label = tok.label || tok.c;
      const key = el('button', { class: 'key' + (tok.cls ? ' ' + tok.cls : ''), 'aria-label': label === ' ' ? 'space' : label });
      key.dataset.char = tok.c;
      key.textContent = displayChar(tok.c);
      key.addEventListener('pointerdown', (e) => { e.preventDefault(); pressChar(tok.c, key); });
      return key;
    }
    const key = el('button', { class: 'key ' + (tok.cls || 'mod'), text: tok.label, 'aria-label': tok.name });
    if (tok.flex) key.style.flexGrow = tok.flex;
    key.dataset.mod = ['ctrl', 'alt', 'win', 'shift', 'menu'].includes(tok.name) ? tok.name : '';
    if (isModifier(tok.name)) {
      key.addEventListener('pointerdown', (e) => { e.preventDefault(); toggleMod(tok.name, key); });
    } else {
      key.addEventListener('pointerdown', (e) => { e.preventDefault(); pressSpecial(tok.name); });
    }
    return key;
  }

  function isModifier(name) { return ['ctrl', 'alt', 'win', 'shift'].includes(name); }

  function displayChar(c) {
    if (c === ' ') return 'space';
    const up = armed.has('shift') || shiftLocked;
    if (up) return SHIFT[c] || c.toUpperCase();
    return c;
  }

  function refreshShiftLabels() {
    [...stage.querySelectorAll('.key[data-char]')].forEach(k => {
      k.textContent = displayChar(k.dataset.char);
    });
    [...stage.querySelectorAll('.key[data-mod="shift"]')].forEach(k => {
      k.classList.toggle('locked', shiftLocked);
      k.classList.toggle('down', armed.has('shift'));
    });
  }

  let lastShiftTap = 0;
  function toggleMod(name, key) {
    haptic(8);
    if (name === 'shift') {
      const now = performance.now();
      if (now - lastShiftTap < 320) { // double-tap → caps lock
        shiftLocked = !shiftLocked;
        armed.delete('shift');
      } else {
        if (shiftLocked) { shiftLocked = false; }
        else if (armed.has('shift')) armed.delete('shift');
        else armed.add('shift');
      }
      lastShiftTap = now;
      refreshShiftLabels();
      return;
    }
    if (armed.has(name)) armed.delete(name); else armed.add(name);
    key.classList.toggle('locked', armed.has(name));
  }

  function clearArmed() {
    armed.forEach(m => { if (m !== 'shift' || !shiftLocked) armed.delete(m); });
    if (!shiftLocked) armed.delete('shift');
    [...stage.querySelectorAll('.key.mod')].forEach(k => {
      const m = k.dataset.mod;
      if (m && m !== 'shift') k.classList.toggle('locked', armed.has(m));
    });
    refreshShiftLabels();
  }

  function pressChar(c, key) {
    haptic(6); keyClick();
    key.classList.add('down');
    setTimeout(() => key.classList.remove('down'), 90);
    const comboMods = [...armed].filter(m => m === 'ctrl' || m === 'alt' || m === 'win');
    if (comboMods.length) {
      // Ctrl/Alt/Win + key → a combo (shortcut).
      const keys = [...comboMods];
      if (armed.has('shift') || shiftLocked) keys.push('shift');
      keys.push(c === ' ' ? 'space' : c);
      app.send({ type: 'combo', keys });
    } else {
      // Plain typing (layout-independent). Shift picks the upper glyph.
      const up = armed.has('shift') || shiftLocked;
      const text = c === ' ' ? ' ' : (up ? (SHIFT[c] || c.toUpperCase()) : c);
      app.send({ type: 'text', text });
    }
    clearArmed();
  }

  function pressSpecial(name) {
    haptic(6); keyClick();
    const comboMods = [...armed];
    if (comboMods.length) {
      app.send({ type: 'combo', keys: [...comboMods, name] });
      clearArmed();
    } else if (name === 'voldown' || name === 'volup' || name === 'mute' || name === 'playpause') {
      app.send({ type: 'media', name });
    } else {
      app.send({ type: 'key', name, action: 'tap' });
    }
  }

  // Landscape toggle. The rotated stage is sized and centred from the area
  // available below the toolbar, computed here so touches land on the right key.
  const landBtn = $('#kb-landscape');
  function applyLandscape(on) {
    landBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) {
      stage.classList.add('landscape');
      const top = $('#kb-command').getBoundingClientRect().bottom + 6;
      const availH = Math.max(160, window.innerHeight - top - 10);
      const availW = window.innerWidth - 10;
      // After a 90° rotation the element's width spans the screen's height.
      stage.style.width = availH + 'px';
      stage.style.height = availW + 'px';
      stage.style.left = (window.innerWidth / 2) + 'px';
      stage.style.top = (top + availH / 2) + 'px';
      stage.style.transform = 'translate(-50%, -50%) rotate(90deg)';
    } else {
      stage.classList.remove('landscape');
      stage.removeAttribute('style');
    }
  }
  landBtn.addEventListener('click', () => {
    const on = !stage.classList.contains('landscape');
    store.set('kbLandscape', on ? '1' : '0');
    applyLandscape(on);
  });
  window.addEventListener('resize', () => {
    if (stage.classList.contains('landscape')) applyLandscape(true);
  });

  // Native device keyboard bridge.
  setupNative(app, native);
  $('#kb-native').addEventListener('click', () => {
    native.focus();
    // iOS needs the focus to come straight from the user gesture (it does here).
    toast('Device keyboard active — type to send', 'ok');
  });

  app.registerShow('keyboard', () => {
    const id = store.get('kbLayout', '60');
    [...layoutBar.children].forEach(c => c.classList.toggle('active', c.dataset.size === id));
    render(id);
    applyLandscape(store.get('kbLandscape', '0') === '1');
  });
}

// ---- Native keyboard: diff the hidden textarea to extract typed input ------
function setupNative(app, native) {
  const SENTINEL = '\u200b'; // zero-width space so backspace is detectable when "empty"
  const mode = () => store.get('kbNativeMode', 'immediate');
  const reset = () => { native.value = SENTINEL; };
  reset();

  native.addEventListener('focus', () => { document.body.classList.add('native-active'); reset(); });
  native.addEventListener('blur', () => { document.body.classList.remove('native-active'); });

  native.addEventListener('input', () => {
    if (mode() !== 'immediate') return; // buffer mode sends on demand
    const val = native.value;
    if (!val.startsWith(SENTINEL)) {
      // The sentinel was deleted → a Backspace on an empty field.
      app.send({ type: 'key', name: 'backspace', action: 'tap' });
      reset();
      return;
    }
    const typed = val.slice(SENTINEL.length);
    if (typed.length === 0) return;
    // Enter arrives as a newline.
    for (const ch of typed) {
      if (ch === '\n') app.send({ type: 'key', name: 'enter', action: 'tap' });
      else app.send({ type: 'text', text: ch });
    }
    reset();
  });

  native.addEventListener('keydown', (e) => {
    // keyCode 229 means an IME is composing; rely on `input` instead.
    if (e.keyCode === 229) return;
    if (mode() === 'immediate' && e.key === 'Backspace' && native.value === SENTINEL) {
      app.send({ type: 'key', name: 'backspace', action: 'tap' });
      e.preventDefault();
    }
  });

  // Expose a buffer-mode sender used by the Send button when that mode is on.
  native._sendBuffer = () => {
    const text = native.value.replace(SENTINEL, '');
    if (text) app.send({ type: 'text', text });
    reset();
  };
}
