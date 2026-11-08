/**
 * Drop-down menus, shared by the menu bar and right-click context menus.
 *
 * An item is one of:
 *   { label, icon?, keys?, run, disabled?, danger?, checked? }
 *   { label, submenu: [items] | () => [items] }
 *   { separator: true }
 *
 * Keyboard: Up/Down move, Right opens a submenu, Left/Escape close it, Enter
 * runs. Only one menu tree is open at a time.
 */
import { h, placeWithin } from '../core/dom.js';
import { icon } from '../core/icons.js';

let active = null; // { root, close }

/** Closes whichever menu is open. */
export function closeMenus() {
  if (active) active.close();
}

export function menuIsOpen() {
  return !!active;
}

function renderItems(items, depth, closeAll) {
  const list = h('div.menu', { role: 'menu' });
  let submenuEl = null;
  const closeSub = () => {
    submenuEl?.remove();
    submenuEl = null;
    list.querySelectorAll('.menu-item.expanded').forEach((el) => el.classList.remove('expanded'));
  };
  const resolved = items.filter(Boolean);
  // Drop leading, trailing and doubled separators.
  const cleaned = resolved.filter((item, i) => !(item.separator && (i === 0 || i === resolved.length - 1 || resolved[i - 1].separator)));
  for (const item of cleaned) {
    if (item.separator) {
      list.append(h('div.menu-separator', { role: 'separator' }));
      continue;
    }
    const hasSub = !!item.submenu;
    const row = h(
      'div.menu-item',
      {
        role: 'menuitem',
        tabindex: '-1',
        class: [item.disabled ? 'disabled' : '', item.danger ? 'danger' : '', hasSub ? 'has-submenu' : ''].join(' '),
        'aria-disabled': item.disabled ? 'true' : null,
        'aria-checked': item.checked !== undefined ? String(!!item.checked) : null,
      },
      h('span.menu-check', {}, item.checked ? icon('check') : item.icon ? icon(item.icon) : null),
      h('span.menu-label', { text: item.label }),
      h('span.menu-keys', { text: item.keys || '' }),
      hasSub ? icon('chevron-right', 'menu-arrow') : null,
    );
    const openSub = () => {
      if (!hasSub || item.disabled) return;
      if (row.classList.contains('expanded')) return;
      closeSub();
      row.classList.add('expanded');
      const subItems = typeof item.submenu === 'function' ? item.submenu() : item.submenu;
      submenuEl = renderItems(subItems, depth + 1, closeAll);
      submenuEl.classList.add('submenu');
      document.body.append(submenuEl);
      const rect = row.getBoundingClientRect();
      submenuEl.style.left = `${rect.right - 2}px`;
      submenuEl.style.top = `${rect.top - 4}px`;
      const subRect = submenuEl.getBoundingClientRect();
      if (subRect.right > window.innerWidth - 4) submenuEl.style.left = `${Math.max(4, rect.left - subRect.width + 2)}px`;
      if (subRect.bottom > window.innerHeight - 4) submenuEl.style.top = `${Math.max(4, window.innerHeight - subRect.height - 4)}px`;
      list.subClose = closeSub;
    };
    row.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'touch') return;
      row.focus({ preventScroll: true });
      if (hasSub) openSub();
      else closeSub();
    });
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      if (item.disabled) return;
      if (hasSub) {
        openSub();
        submenuEl?.querySelector('.menu-item:not(.disabled)')?.focus();
        return;
      }
      closeAll();
      item.run?.();
    });
    row.addEventListener('keydown', (event) => {
      const rows = [...list.querySelectorAll(':scope > .menu-item:not(.disabled)')];
      const index = rows.indexOf(row);
      if (event.key === 'ArrowDown') rows[(index + 1) % rows.length]?.focus();
      else if (event.key === 'ArrowUp') rows[(index - 1 + rows.length) % rows.length]?.focus();
      else if (event.key === 'ArrowRight' && hasSub) {
        openSub();
        submenuEl?.querySelector('.menu-item:not(.disabled)')?.focus();
      } else if (event.key === 'ArrowLeft' && depth > 0) {
        list.remove();
        list.onLeft?.();
      } else if (event.key === 'Enter' || event.key === ' ') row.click();
      else if (event.key === 'Escape') closeAll();
      else return;
      event.preventDefault();
      event.stopPropagation();
    });
    list.append(row);
  }
  list.closeSub = closeSub;
  return list;
}

/**
 * Opens a menu at (x, y). `onClose` runs when it closes for any reason.
 * `anchor` is the button that opened it: pressing it is not a click
 * "outside", so the button's own click handler can close the menu (a
 * toggle) instead of the menu closing on pointerdown and the click opening
 * it again. Returns the menu element.
 */
export function openMenu(items, x, y, { onClose, alignRight = false, focusFirst = false, className = '', anchor = null } = {}) {
  closeMenus();
  const root = renderItems(items, 0, () => close());
  if (className) root.classList.add(className);
  document.body.append(root);
  placeWithin(root, x, y, { alignRight });
  const outside = (event) => {
    if (event.target instanceof Element && event.target.closest('.menu')) return;
    if (anchor && event.target instanceof Node && anchor.contains(event.target)) return;
    close();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  function close() {
    if (!active || active.root !== root) return;
    active = null;
    root.closeSub?.();
    document.querySelectorAll('.menu.submenu').forEach((el) => el.remove());
    root.remove();
    window.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
    onClose?.();
  }
  active = { root, close, anchor };
  setTimeout(() => {
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
  });
  if (focusFirst) root.querySelector('.menu-item:not(.disabled)')?.focus();
  else root.focus?.();
  return root;
}

/**
 * Opens `items` as a drop-down below `button`, or closes it when that
 * button's menu is already open (a second click toggles it shut).
 */
export function dropdown(button, items, { alignRight = false, className = '', onClose } = {}) {
  if (active?.anchor === button) {
    closeMenus();
    return null;
  }
  const rect = button.getBoundingClientRect();
  const list = typeof items === 'function' ? items() : items;
  return openMenu(list, alignRight ? rect.right : rect.left, rect.bottom + 2, { alignRight, className, onClose, anchor: button });
}

/** Opens a context menu at a mouse/touch event's position. */
export function contextMenu(event, items) {
  event.preventDefault();
  event.stopPropagation();
  const x = event.clientX ?? event.touches?.[0]?.clientX ?? 0;
  const y = event.clientY ?? event.touches?.[0]?.clientY ?? 0;
  return openMenu(items, x, y, { className: 'context-menu' });
}
