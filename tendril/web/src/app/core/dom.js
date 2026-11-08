/**
 * Tiny DOM helpers. No framework: elements are built with `h()` and updated
 * by hand. Text always goes through textContent (never innerHTML) so file
 * names and contents can never inject markup.
 */
import { icon } from './icons.js';

/**
 * Creates an element.
 * @param {string} tag tag name, optionally with classes: "button.btn.primary"
 * @param {object} [props] attributes; `on*` functions become listeners,
 *   `class` / `text` / `style` / `dataset` are handled specially
 * @param {...(Node|string|null|false)} children
 */
export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = [el.className, value].filter(Boolean).join(' ');
    else if (key === 'text') el.textContent = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

/** Appends children, skipping null/false, turning strings into text. */
export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** A button with an icon (and optional label) and a tooltip. */
export function iconButton(name, tip, onClick, extra = {}) {
  const btn = h('button.icon-btn', { type: 'button', 'aria-label': tip, 'data-tip': tip, onclick: onClick, ...extra }, icon(name));
  return btn;
}

/** Removes every child. */
export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** Calls `fn` at most once per `wait` ms, trailing call included. */
export function debounce(fn, wait) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

/** True on touch-first devices (phones, tablets). */
export const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

/** True on narrow screens (the mobile layout). */
export const isNarrow = () => window.matchMedia('(max-width: 767px)').matches;

/** True on macOS / iOS (for Cmd vs Ctrl in shortcut labels). */
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Keeps a floating element (menu, tooltip) inside the viewport. */
export function placeWithin(el, x, y, { alignRight = false } = {}) {
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = alignRight ? x - rect.width : x;
  let top = y;
  if (left + rect.width > vw - 4) left = Math.max(4, vw - rect.width - 4);
  if (left < 4) left = 4;
  if (top + rect.height > vh - 4) top = Math.max(4, vh - rect.height - 4);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

/** Triggers a browser download of a Blob or URL. */
export function downloadUrl(url, name = '') {
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
}
