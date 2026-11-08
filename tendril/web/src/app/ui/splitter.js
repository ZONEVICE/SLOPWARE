/**
 * Draggable splitters for the sidebar width and the terminal panel height.
 * The size is a CSS variable on the workbench and is remembered per browser.
 * Double-click restores the default.
 */
import { h } from '../core/dom.js';
import { store } from '../core/store.js';

/**
 * @param {object} o
 * @param {HTMLElement} o.root element that holds the CSS variable
 * @param {string} o.variable e.g. "--sidebar-width"
 * @param {'x'|'y'} o.axis
 * @param {number} o.min @param {number} o.max @param {number} o.initial
 * @param {() => number} [o.direction] +1 or -1: which way growing goes
 * @param {string} o.key localStorage key
 * @param {() => void} [o.onResize]
 */
export function createSplitter({ root, variable, axis, min, max, initial, direction = () => 1, key, onResize }) {
  const handle = h('div.splitter', { class: `splitter-${axis}`, role: 'separator', 'aria-orientation': axis === 'x' ? 'vertical' : 'horizontal', tabindex: '-1' });
  const clamp = (v) => Math.round(Math.min(Math.max(v, min), typeof max === 'function' ? max() : max));
  let size = clamp(store.get(key, initial));
  const apply = () => {
    root.style.setProperty(variable, `${size}px`);
    onResize?.(size);
  };
  apply();

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
    const start = axis === 'x' ? event.clientX : event.clientY;
    const startSize = size;
    const move = (e) => {
      const delta = (axis === 'x' ? e.clientX : e.clientY) - start;
      size = clamp(startSize + delta * direction());
      apply();
    };
    const up = () => {
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing-x', 'resizing-y');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      store.set(key, size);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => {
    size = clamp(initial);
    apply();
    store.set(key, size);
  });

  return {
    handle,
    get size() {
      return size;
    },
    set(value) {
      size = clamp(value);
      apply();
    },
  };
}
