/**
 * Transient notifications.
 *
 * Used for errors that should not interrupt the flow ("this room was deleted",
 * "upload failed"). Never used for anything the user must acknowledge - that is
 * what `confirmModal` is for.
 */
import { el } from '../core/dom.js';

const root = () => document.getElementById('toast-root');
const MAX_VISIBLE = 4;

/**
 * @param {string} message
 * @param {{ tone?: 'info'|'error'|'success', duration?: number }} [options]
 */
export function toast(message, options = {}) {
  const container = root();
  if (!container) return () => {};

  const node = el('div', {
    class: 'toast',
    role: options.tone === 'error' ? 'alert' : 'status',
    dataset: { tone: options.tone || 'info' },
    text: message,
  });

  container.appendChild(node);

  // Keep the stack short so it never covers the composer.
  while (container.children.length > MAX_VISIBLE) container.firstChild.remove();

  const duration = options.duration ?? (options.tone === 'error' ? 6000 : 3800);
  const timer = setTimeout(dismiss, duration);

  function dismiss() {
    clearTimeout(timer);
    if (!node.isConnected) return;
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 240);
  }

  node.addEventListener('click', dismiss);
  return dismiss;
}

/** Shorthand for an error toast; accepts an Error or a string. */
export function toastError(error) {
  const message = typeof error === 'string' ? error : error?.message || 'Something went wrong.';
  return toast(message, { tone: 'error' });
}
