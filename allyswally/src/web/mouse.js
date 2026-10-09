// The trackpad: pointer-driven cursor movement, taps, drag, two-finger scroll,
// the virtual buttons and the scroll potentiometer. Movement deltas are scaled
// client-side by the pointer-speed multiplier and an optional acceleration
// curve, then coalesced by the WebSocket client once per frame.

import { $, store, haptic } from './util.js';

export function initMouse(app) {
  const pad = $('#trackpad');
  const pointers = new Map();
  let primaryId = null;
  let lastX = 0, lastY = 0;
  let startX = 0, startY = 0, startT = 0, movedDist = 0;
  let dragging = false, dragLock = false, twoFinger = false;
  let scrollAnchor = 0, scrollAnchorX = 0;
  let longPress = null;
  let lastTapT = 0, singleTapTimer = null;

  const settings = () => ({
    mult: (parseInt(store.get('dpi', '100'), 10) || 100) / 100,
    accel: store.get('accel', 'none'),
    tapClick: store.get('tapClick', '1') === '1',
    doubleTapMs: parseInt(store.get('doubleTapMs', '300'), 10) || 300,
    scrollSpeed: (parseInt(store.get('scrollSpeed', '8'), 10) || 8),
    natural: store.get('naturalScroll', '0') === '1',
    leftHanded: store.get('leftHanded', '0') === '1',
  });

  function accelFactor(speed, mode) {
    if (mode === 'soft') return 1 + Math.min(speed / 40, 1.5);
    if (mode === 'strong') return 1 + Math.min(speed / 20, 3);
    return 1;
  }

  function ripple(x, y) {
    const r = document.createElement('span');
    r.className = 'ripple';
    const rect = pad.getBoundingClientRect();
    r.style.left = (x - rect.left) + 'px';
    r.style.top = (y - rect.top) + 'px';
    pad.appendChild(r);
    setTimeout(() => r.remove(), 420);
  }

  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pad.classList.add('active');

    if (pointers.size === 1) {
      primaryId = e.pointerId;
      lastX = e.clientX; lastY = e.clientY;
      startX = e.clientX; startY = e.clientY; startT = performance.now();
      movedDist = 0;
      // Long-press to begin a drag.
      longPress = setTimeout(() => {
        if (!dragging && !twoFinger) {
          dragging = true;
          app.send({ type: 'down', button: resolveButton('left') });
          haptic(20);
        }
      }, 420);
    } else if (pointers.size === 2) {
      clearTimeout(longPress); longPress = null;
      twoFinger = true;
      const pts = [...pointers.values()];
      scrollAnchor = (pts[0].y + pts[1].y) / 2;
      scrollAnchorX = (pts[0].x + pts[1].x) / 2;
    }
  });

  pad.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = settings();

    if (twoFinger && pointers.size >= 2) {
      const pts = [...pointers.values()];
      const cy = (pts[0].y + pts[1].y) / 2;
      const cx = (pts[0].x + pts[1].x) / 2;
      let dv = cy - scrollAnchor;
      let dh = cx - scrollAnchorX;
      scrollAnchor = cy; scrollAnchorX = cx;
      const k = s.scrollSpeed / 2 * (s.natural ? -1 : 1);
      app.scroll(Math.round(dv * k), Math.round(dh * (s.natural ? -1 : 1)));
      return;
    }

    if (e.pointerId !== primaryId) return;
    let dx = e.clientX - lastX;
    let dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    const dist = Math.hypot(dx, dy);
    movedDist += dist;
    if (movedDist > 8 && longPress) { clearTimeout(longPress); longPress = null; }
    const f = s.mult * accelFactor(dist, s.accel);
    app.move(dx * f, dy * f);
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (longPress) { clearTimeout(longPress); longPress = null; }

    if (dragging && pointers.size === 0) {
      app.send({ type: 'up', button: resolveButton('left') });
      dragging = false;
    }
    if (twoFinger && pointers.size < 2) twoFinger = false;

    if (pointers.size === 0) {
      pad.classList.remove('active');
      const s = settings();
      const dt = performance.now() - startT;
      const wasTap = e.pointerId === primaryId && movedDist < 8 && dt < 250 && !dragging;
      if (wasTap && s.tapClick && !dragLock) handleTap(s, e);
      primaryId = null;
    }
  }
  pad.addEventListener('pointerup', endPointer);
  pad.addEventListener('pointercancel', endPointer);

  function handleTap(s, e) {
    ripple(e.clientX, e.clientY);
    const now = performance.now();
    if (now - lastTapT < s.doubleTapMs) {
      // Double tap → double click.
      if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null; }
      app.send({ type: 'click', button: resolveButton('left'), double: true });
      haptic(14);
      lastTapT = 0;
    } else {
      lastTapT = now;
      singleTapTimer = setTimeout(() => {
        app.send({ type: 'click', button: resolveButton('left') });
        haptic(10);
        singleTapTimer = null;
      }, s.doubleTapMs);
    }
  }

  // Left-handed mode swaps the physical left/right click mapping.
  function resolveButton(name) {
    const lh = store.get('leftHanded', '0') === '1';
    if (!lh) return name;
    if (name === 'left') return 'right';
    if (name === 'right') return 'left';
    return name;
  }

  // Virtual buttons.
  $$all('.mbtn[data-button]').forEach(btn => {
    btn.addEventListener('click', () => {
      haptic(10);
      app.send({ type: 'click', button: resolveButton(btn.dataset.button) });
    });
  });

  // Drag lock: hold the left button down for comfortable dragging.
  const dragBtn = $('#drag-lock');
  dragBtn.addEventListener('click', () => {
    dragLock = !dragLock;
    dragBtn.setAttribute('aria-pressed', dragLock ? 'true' : 'false');
    app.send({ type: dragLock ? 'down' : 'up', button: resolveButton('left') });
    haptic(14);
  });

  // Scroll potentiometer: scroll proportionally while dragging, snap to 0.
  const pot = $('#scroll-pot');
  let potLast = 0;
  pot.addEventListener('input', () => {
    const v = parseInt(pot.value, 10);
    const s = settings();
    const delta = (potLast - v) * (s.scrollSpeed / 6) * (s.natural ? -1 : 1);
    if (Math.abs(delta) >= 1) app.scroll(Math.round(delta), 0);
    potLast = v;
  });
  const resetPot = () => { pot.value = '0'; potLast = 0; };
  pot.addEventListener('pointerup', resetPot);
  pot.addEventListener('pointercancel', resetPot);
  pot.addEventListener('change', resetPot);

  // Options toggle.
  const optsToggle = $('#mouse-opts-toggle');
  const optsBody = $('#mouse-opts');
  optsToggle.addEventListener('click', () => {
    const open = optsBody.hidden;
    optsBody.hidden = !open;
    optsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    optsToggle.textContent = open ? 'Fewer options' : 'More options';
  });

  // DPI + scroll speed sliders (mirror the device settings).
  const dpi = $('#dpi-slider'), dpiOut = $('#dpi-out');
  const scr = $('#scroll-speed'), scrOut = $('#scroll-out');
  const syncSliders = () => {
    dpi.value = store.get('dpi', '100');
    dpiOut.textContent = (parseInt(dpi.value, 10) / 100).toFixed(1) + '×';
    scr.value = store.get('scrollSpeed', '8');
    scrOut.textContent = scr.value;
  };
  dpi.addEventListener('input', () => { store.set('dpi', dpi.value); dpiOut.textContent = (parseInt(dpi.value, 10) / 100).toFixed(1) + '×'; });
  scr.addEventListener('input', () => { store.set('scrollSpeed', scr.value); scrOut.textContent = scr.value; });

  // Movement mode chips.
  const abs = $('#mode-abs'), rel = $('#mode-rel');
  const applyMode = (relative) => {
    abs.setAttribute('aria-pressed', relative ? 'false' : 'true');
    rel.setAttribute('aria-pressed', relative ? 'true' : 'false');
    store.set('moveMode', relative ? 'rel' : 'abs');
    app.setMoveMode(relative);
  };
  abs.addEventListener('click', () => applyMode(false));
  rel.addEventListener('click', () => applyMode(true));

  app.registerShow('mouse', () => {
    syncSliders();
    applyMode(store.get('moveMode', 'abs') === 'rel');
    applyLeftHanded();
  });

  function applyLeftHanded() {
    const lh = store.get('leftHanded', '0') === '1';
    $('.mouse-wrap').style.flexDirection = lh ? 'row-reverse' : 'row';
  }

  // Helper that scopes querySelectorAll to the document.
  function $$all(sel) { return Array.from(document.querySelectorAll(sel)); }
}
