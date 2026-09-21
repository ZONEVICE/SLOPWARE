/**
 * DOM helpers.
 *
 * SECURITY RULE, ENFORCED BY THIS MODULE: user-controlled text never reaches
 * `innerHTML`. `el()` sets strings with `textContent`, and there is deliberately
 * no escape hatch for raw HTML. Every username, message body, room name and
 * filename in Pellets flows through here.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Append children of any supported shape to a node.
 * Accepts nodes, strings/numbers (become text), arrays, and null/false (skipped).
 * @param {Node} node
 * @param {any} children
 */
export function append(node, children) {
  if (children === null || children === undefined || children === false) return node;
  if (Array.isArray(children)) {
    for (const child of children) append(node, child);
    return node;
  }
  if (children instanceof Node) {
    node.appendChild(children);
    return node;
  }
  node.appendChild(document.createTextNode(String(children)));
  return node;
}

/**
 * Create an element.
 *
 * Supported props:
 *   class     -> className
 *   text      -> textContent (safe by construction)
 *   dataset   -> Object.assign on element.dataset
 *   style     -> object assigned to element.style
 *   on<Event> -> addEventListener, e.g. onClick, onInput
 *   ref       -> callback receiving the created node
 *   anything else becomes an attribute (true renders as a bare attribute)
 *
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'ref' && typeof value === 'function') value(node);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }

  append(node, children);
  return node;
}

/**
 * Reference an icon from the inline sprite in index.html.
 * @param {string} name Sprite id without the `i-` prefix.
 * @param {string} [className]
 */
export function icon(name, className = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

/** Remove every child of a node. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Replace the contents of a node. */
export function render(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

/**
 * Add a listener and get its remover back, so a view can tear itself down.
 * @returns {() => void}
 */
export function on(target, event, handler, options) {
  target.addEventListener(event, handler, options);
  return () => target.removeEventListener(event, handler, options);
}

/** Collect several teardown functions into one. */
export function disposer() {
  /** @type {(() => void)[]} */
  const items = [];
  const add = (fn) => {
    if (typeof fn === 'function') items.push(fn);
    return fn;
  };
  add.dispose = () => {
    while (items.length) {
      const fn = items.pop();
      try {
        fn();
      } catch (error) {
        console.error('[dispose]', error);
      }
    }
  };
  return add;
}

/**
 * Apply a user hue to an element. Everything colour-related in the UI goes
 * through this, so a null hue degrades to a neutral grey instead of breaking.
 * @param {HTMLElement} node
 * @param {number|null|undefined} hue
 */
export function applyHue(node, hue) {
  if (typeof hue === 'number' && Number.isFinite(hue)) {
    node.style.setProperty('--hue', String(hue));
    node.style.removeProperty('--user-sat');
  } else {
    node.style.setProperty('--hue', '220');
    node.style.setProperty('--user-sat', '0%');
  }
  return node;
}
