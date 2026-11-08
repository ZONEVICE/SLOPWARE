/**
 * Modal dialogs, promise-based: `confirm`, `prompt`, `alert`, `choose`.
 * Escape cancels, Enter accepts, focus stays inside while open. Browser
 * dialogs (window.prompt...) are never used: they are ugly, block the page
 * and cannot be themed.
 */
import { h } from '../core/dom.js';

let open = 0;

/** True while any dialog is open (keyboard shortcuts pause). */
export const dialogOpen = () => open > 0;

function modal({ title, message, body, buttons, onKey, initialFocus, wide = false }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const close = (value) => {
      open -= 1;
      overlay.remove();
      document.removeEventListener('keydown', keydown, true);
      if (previous && previous.focus) previous.focus({ preventScroll: true });
      resolve(value);
    };
    const footer = h(
      'div.dialog-buttons',
      {},
      buttons.map((b) =>
        h('button.btn', {
          type: 'button',
          class: [b.primary ? 'primary' : '', b.danger ? 'danger' : ''].join(' '),
          text: b.label,
          onclick: () => {
            // A function value may veto closing by returning undefined (invalid input).
            const value = b.value instanceof Function ? b.value() : b.value;
            if (value !== undefined) close(value);
          },
        }),
      ),
    );
    const panel = h(
      'div.dialog',
      { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, class: wide ? 'wide' : '' },
      title ? h('h2.dialog-title', { text: title }) : null,
      message ? h('p.dialog-message', { text: message }) : null,
      body || null,
      footer,
    );
    const overlay = h('div.dialog-overlay', { onpointerdown: (e) => e.target === overlay && close(null) }, panel);
    const keydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(null);
      } else if (event.key === 'Tab') {
        const focusable = [...panel.querySelectorAll('button, input, select, textarea, [tabindex]')].filter((el) => !el.disabled);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      } else if (onKey) {
        onKey(event, close);
      }
      event.stopPropagation();
    };
    document.addEventListener('keydown', keydown, true);
    open += 1;
    document.body.append(overlay);
    requestAnimationFrame(() => (initialFocus?.(panel) || footer.querySelector('.primary') || footer.lastElementChild)?.focus());
  });
}

export const dialog = {
  /** Resolves true when confirmed. */
  async confirm({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
    const value = await modal({
      title,
      message,
      buttons: [
        { label: cancelLabel, value: false },
        { label: confirmLabel, value: true, primary: !danger, danger },
      ],
      onKey: (event, close) => {
        if (event.key === 'Enter' && document.activeElement?.tagName !== 'BUTTON') close(true);
      },
    });
    return value === true;
  },

  /** Resolves with the text, or null when cancelled. */
  prompt({ title, message, value = '', placeholder = '', confirmLabel = 'OK', validate, select }) {
    const input = h('input.input', { type: 'text', value, placeholder, spellcheck: 'false', autocomplete: 'off' });
    const error = h('div.dialog-error');
    const check = () => {
      const problem = validate ? validate(input.value) : null;
      error.textContent = problem || '';
      return !problem;
    };
    input.addEventListener('input', check);
    const accept = () => (check() ? input.value : undefined);
    return modal({
      title,
      message,
      body: h('div.dialog-field', {}, input, error),
      buttons: [
        { label: 'Cancel', value: null },
        { label: confirmLabel, value: accept, primary: true },
      ],
      initialFocus: () => {
        input.focus();
        if (select) input.setSelectionRange(select[0], select[1]);
        else input.select();
        return input;
      },
      onKey: (event, close) => {
        if (event.key === 'Enter' && event.target === input && check()) {
          event.preventDefault();
          close(input.value);
        }
      },
    }).then((result) => (result === undefined ? null : result));
  },

  alert({ title, message, body, wide }) {
    return modal({ title, message, body, wide, buttons: [{ label: 'Close', value: true, primary: true }] });
  },

  /** Resolves with the chosen id, or null. `choices`: [{id, label, primary, danger}] */
  choose({ title, message, choices, body }) {
    return modal({
      title,
      message,
      body,
      buttons: [{ label: 'Cancel', value: null }, ...choices.map((c) => ({ ...c, value: c.id }))],
    });
  },
};
