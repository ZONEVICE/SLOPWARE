/**
 * A modal confirmation built on the native <dialog> element.
 */
import { h } from '../core/dom.js';

/**
 * @param {{ title: string, message: string, confirmLabel?: string, danger?: boolean }} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, confirmLabel = 'Continue', danger = false }) {
  return new Promise((resolve) => {
    const cancel = h('button', { type: 'button', class: 'btn', text: 'Cancel' });
    const accept = h('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}`, text: confirmLabel });
    const dialog = h('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-title' }, h('h2', { id: 'confirm-title', text: title }), h('p', { text: message }), h('div', { class: 'actions' }, cancel, accept));
    const finish = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(false));
    accept.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    document.body.append(dialog);
    dialog.showModal();
    accept.focus();
  });
}
