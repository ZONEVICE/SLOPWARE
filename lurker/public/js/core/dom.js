/**
 * Element builders. File and folder names come from someone's disk, so the
 * interface is built with DOM nodes and textContent only: there is
 * deliberately no helper that parses HTML.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('button', { class: 'btn', onClick: fn, title: 'Close' }, 'Close')
 * Props: class, text, style (object), dataset (object), on<Event> listeners,
 * boolean attributes (true/false), everything else becomes an attribute.
 * Children may be nodes, strings, numbers, arrays, or null/false (skipped).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined && value !== false) el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function applyProps(el, props) {
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style') setStyle(el, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' && 'value' in el) el.value = value;
    else if (key === 'checked' || key === 'selected' || key === 'disabled' || key === 'hidden') el[key] = Boolean(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Set CSS properties through the CSSOM (allowed by the page's CSP, unlike style attributes). */
export function setStyle(el, styles) {
  for (const [name, value] of Object.entries(styles)) {
    if (value === null || value === undefined) el.style.removeProperty(name);
    else el.style.setProperty(name, typeof value === 'number' && !name.startsWith('--') ? `${value}px` : String(value));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export function replaceChildren(el, ...children) {
  clear(el);
  return append(el, children);
}

/** Run `fn` at most once per animation frame, with the latest arguments. */
export function rafThrottle(fn) {
  let scheduled = false;
  let lastArgs = [];
  return (...args) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...lastArgs);
    });
  };
}

export function debounce(fn, ms) {
  let timer = 0;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}
