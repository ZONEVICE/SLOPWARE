/**
 * Short-lived messages in the corner of the screen.
 */
import { h } from '../core/dom.js';

/**
 * @param {string} message
 * @param {{ kind?: 'info'|'error', timeout?: number }} [options]
 */
export function toast(message, { kind = 'info', timeout = 4500 } = {}) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = h('div', { class: `toast ${kind === 'error' ? 'error' : ''}`, role: kind === 'error' ? 'alert' : 'status', text: message });
  box.append(el);
  setTimeout(() => el.remove(), timeout);
}
