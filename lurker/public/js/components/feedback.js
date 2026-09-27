/** Toasts, confirmation dialogs and popover menus. */
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';

export function toast(message, { kind = 'info', timeout = 4200 } = {}) {
  const host = document.getElementById('toasts');
  const glyph = kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info';
  const el = h('div', { class: ['toast', kind] }, icon(glyph, { size: 18 }), h('span', { text: message }));
  host.append(el);
  setTimeout(() => el.remove(), timeout);
  return el;
}

/**
 * A modal question. Resolves true when confirmed.
 *
 * The buttons settle the promise themselves instead of waiting for the
 * dialog's "close" event, which browsers deliver late (or not at all) to a
 * tab in the background.
 */
export function confirmDialog({ title, text, confirm = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'dialog' });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };
    const form = h(
      'form',
      {
        method: 'dialog',
        onSubmit: (event) => {
          event.preventDefault();
          finish(true);
        },
      },
      h('h2', { text: title }),
      text ? h('p', { text }) : null,
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'btn', text: cancel, onClick: () => finish(false) }),
        h('button', { type: 'submit', class: ['btn', danger ? 'danger' : 'primary'], text: confirm, autofocus: true }),
      ),
    );
    dialog.append(form);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener('close', () => finish(false));
    document.body.append(dialog);
    dialog.showModal();
  });
}

let openMenu = null;

/**
 * A popover menu under `anchor`. Entries: { label, checked?, onSelect, icon? },
 * 'separator', or { heading }.
 */
export function showMenu(anchor, entries) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const entry of entries) {
    if (entry === 'separator') {
      menu.append(h('hr'));
    } else if (entry.heading) {
      menu.append(h('div', { class: 'menu-label', text: entry.heading }));
    } else {
      menu.append(
        h(
          'button',
          {
            type: 'button',
            role: entry.checked === undefined ? 'menuitem' : 'menuitemradio',
            'aria-checked': entry.checked === undefined ? null : String(Boolean(entry.checked)),
            onClick: () => {
              closeMenu();
              entry.onSelect();
            },
          },
          entry.icon ? icon(entry.icon, { size: 17 }) : null,
          h('span', { text: entry.label }),
          entry.checked ? h('span', { class: 'check-mark' }, icon('check', { size: 16 })) : null,
        ),
      );
    }
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
  const below = rect.bottom + 6;
  const top = below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - menu.offsetHeight - 6) : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  const onPointer = (event) => {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) closeMenu();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      anchor.focus();
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', onPointer, true));
  document.addEventListener('keydown', onKey, true);
  openMenu = { menu, cleanup: () => {
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
  } };
  menu.querySelector('button')?.focus();
}

export function closeMenu() {
  if (!openMenu) return;
  openMenu.cleanup();
  openMenu.menu.remove();
  openMenu = null;
}
