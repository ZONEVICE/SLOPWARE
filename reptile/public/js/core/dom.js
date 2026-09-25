/**
 * DOM helpers.
 *
 * `h()` builds elements from plain values. Text always goes through
 * `textContent` or text nodes: file names, host names and messages from other
 * machines are displayed, and none of them may ever be parsed as HTML. There
 * is deliberately no raw-HTML escape hatch here.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Create an element.
 * @param {string} tag
 * @param {Record<string, any>|null} [props] `class`, `text`, `dataset`,
 *   `on<event>` handlers, DOM properties (checked, disabled, value...) or attributes.
 * @param {...any} children Nodes, strings, numbers, arrays, or null/false (skipped).
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

/** Append children, flattening arrays and skipping empty values. */
export function append(el, children) {
  for (const child of [children].flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Replace all children of `el`. */
export function replace(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

/**
 * Icon paths, 24x24 viewBox, drawn with strokes. Built with createElementNS,
 * never from markup strings.
 */
const ICONS = {
  host: ['M4 5h16v6H4z', 'M4 13h16v6H4z', 'M8 8h.01', 'M8 16h.01'],
  sync: ['M4 11a8 8 0 0 1 14-5l2 2', 'M20 4v4h-4', 'M20 13a8 8 0 0 1-14 5l-2-2', 'M4 20v-4h4'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4'],
  link: ['M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1', 'M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1'],
  radar: ['M12 12l6-6', 'M12 3a9 9 0 1 0 9 9', 'M12 7a5 5 0 1 0 5 5', 'M12 12h.01'],
  chevron: ['M9 6l6 6-6 6'],
  back: ['M15 6l-6 6 6 6'],
  check: ['M5 12l5 5 9-10'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  alert: ['M12 3l10 18H2z', 'M12 10v4', 'M12 17h.01'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v6', 'M12 7h.01'],
  lock: ['M6 11h12v10H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  computer: ['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4'],
  refresh: ['M20 11a8 8 0 1 0-2 6', 'M20 5v6h-6'],
  dice: ['M5 5h14v14H5z', 'M9 9h.01', 'M15 15h.01', 'M15 9h.01', 'M9 15h.01'],
};

/**
 * An inline SVG icon.
 * @param {keyof typeof ICONS} name
 * @param {string} [extraClass]
 */
export function icon(name, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon ${extraClass}`.trim());
  for (const d of ICONS[name] || []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * Debounce a function.
 * @template {(...args: any[]) => void} F
 * @param {F} fn
 * @param {number} ms
 * @returns {F & { cancel: () => void }}
 */
export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** Mark a button busy (spinner, disabled) while `task` runs. */
export async function withBusy(button, task) {
  button.disabled = true;
  button.classList.add('busy');
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.classList.remove('busy');
  }
}
