/**
 * Modal dialog.
 *
 * Used by the "choose your username" prompt, the room creator and the delete
 * confirmation. Handles focus capture, Escape, backdrop clicks and restoring
 * focus to whatever was focused before.
 *
 * A modal can be `dismissible: false`, which is how the identity prompt behaves
 * when a client opens a room link without having picked a username yet.
 */
import { el, icon, on, disposer } from '../core/dom.js';

const root = () => document.getElementById('modal-root');

/** Elements that can receive keyboard focus, for the focus trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.description]
 * @param {Node|Node[]} [options.content] Body of the dialog.
 * @param {Node[]} [options.actions] Footer buttons.
 * @param {boolean} [options.dismissible] Escape / backdrop / close button.
 * @param {() => void} [options.onClose]
 * @returns {{ close: () => void, element: HTMLElement }}
 */
export function openModal({ title, description, content, actions, dismissible = true, onClose }) {
  const off = disposer();
  const previouslyFocused = document.activeElement;

  const dialog = el(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el(
      'div',
      { class: 'modal-head' },
      el(
        'div',
        { class: 'grow' },
        el('h2', { class: 'modal-title', text: title }),
        description ? el('p', { class: 'modal-desc', text: description }) : null,
      ),
      dismissible
        ? el(
            'button',
            { class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': 'Close', onClick: () => close() },
            icon('close'),
          )
        : null,
    ),
    content || null,
    actions && actions.length ? el('div', { class: 'modal-actions' }, actions) : null,
  );

  const backdrop = el('div', { class: 'modal-backdrop' }, dialog);

  function close() {
    off.dispose();
    backdrop.remove();
    if (onClose) onClose();
    // Give focus back where it came from, if that element still exists.
    if (previouslyFocused && document.contains(previouslyFocused)) {
      try {
        previouslyFocused.focus({ preventScroll: true });
      } catch {
        /* focus is best effort */
      }
    }
  }

  off(
    on(backdrop, 'mousedown', (event) => {
      if (dismissible && event.target === backdrop) close();
    }),
  );

  off(
    on(document, 'keydown', (event) => {
      if (event.key === 'Escape' && dismissible) {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;

      // Focus trap: keep Tab cycling inside the dialog.
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((node) => node.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }),
  );

  root().appendChild(backdrop);

  // Focus the first meaningful control so the dialog is usable from the keyboard.
  const target = dialog.querySelector('input, textarea, button.btn-primary') || dialog;
  requestAnimationFrame(() => {
    try {
      target.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  });

  return { close, element: dialog };
}

/**
 * Yes/no confirmation built on `openModal`.
 * @returns {Promise<boolean>}
 */
export function confirmModal({ title, description, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const modal = openModal({
      title,
      description,
      dismissible: true,
      onClose: () => finish(false),
      actions: [
        el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: () => modal.close() }),
        el('button', {
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          type: 'button',
          text: confirmLabel,
          onClick: () => {
            finish(true);
            modal.close();
          },
        }),
      ],
    });
  });
}
