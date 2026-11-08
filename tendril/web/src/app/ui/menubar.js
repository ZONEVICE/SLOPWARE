/**
 * The classic menu bar (File, Edit, Selection, View, Find, Terminal, Tools,
 * Preferences, Help) and its model.
 *
 * Features add entries with `app.menus.add(menuId, entry)`:
 *   { command: 'file.save', group: '2_save', order: 1 }
 *   { label: 'Theme', submenu: () => [items], group, order }
 *   { items: () => [items], group, order }   // several dynamic items
 * Groups sort by name and are separated by lines; `order` sorts within one.
 * On narrow screens the bar collapses into a single "Menu" button whose
 * entries open as submenus.
 */
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { closeMenus, dropdown, menuIsOpen, openMenu } from './menu.js';

export const MENU_BAR = [
  ['file', 'File'],
  ['edit', 'Edit'],
  ['selection', 'Selection'],
  ['view', 'View'],
  ['find', 'Find'],
  ['terminal', 'Terminal'],
  ['tools', 'Tools'],
  ['preferences', 'Preferences'],
  ['help', 'Help'],
];

/** The menu model. */
export function createMenus(app) {
  const entries = new Map(MENU_BAR.map(([id]) => [id, []]));

  function commandItem(id) {
    const command = app.commands.get(id);
    if (!command) return null;
    return {
      label: command.menuTitle || command.title,
      icon: command.icon,
      keys: app.commands.shortcut(id),
      disabled: !app.commands.enabled(id),
      checked: command.checked ? app.commands.checked(id) : undefined,
      danger: command.danger,
      run: () => app.commands.run(id),
    };
  }

  return {
    add(menuId, entry) {
      if (!entries.has(menuId)) entries.set(menuId, []);
      entries.get(menuId).push({ group: '5_other', order: 50, ...entry });
    },
    /** Resolved menu items for a menu id. */
    items(menuId) {
      const list = [...(entries.get(menuId) || [])].sort(
        (a, b) => a.group.localeCompare(b.group) || a.order - b.order,
      );
      const out = [];
      let group = null;
      for (const entry of list) {
        if (group !== null && entry.group !== group) out.push({ separator: true });
        group = entry.group;
        if (entry.command) {
          const item = commandItem(entry.command);
          if (item) out.push(item);
        } else if (entry.submenu) {
          out.push({ label: entry.label, icon: entry.icon, submenu: entry.submenu });
        } else if (entry.items) {
          out.push(...entry.items());
        }
      }
      return out;
    },
    commandItem,
  };
}

/** Renders the menu bar into `host`. */
export function createMenuBar(app, host) {
  const bar = h('nav.menubar', { 'aria-label': 'Main menu' });
  let openId = null;

  const open = (id, button) => {
    const rect = button.getBoundingClientRect();
    openId = id;
    bar.querySelectorAll('.menubar-item').forEach((b) => b.classList.toggle('open', b === button));
    openMenu(app.menus.items(id), rect.left, rect.bottom + 2, {
      onClose: () => {
        if (openId === id) {
          openId = null;
          button.classList.remove('open');
        }
      },
      focusFirst: false,
      anchor: button,
    });
  };

  for (const [id, label] of MENU_BAR) {
    const button = h('button.menubar-item', { type: 'button', text: label, 'aria-haspopup': 'menu', 'data-menu': id });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (openId === id) closeMenus();
      else open(id, button);
    });
    button.addEventListener('pointerenter', () => {
      if (openId && openId !== id && menuIsOpen()) open(id, button);
    });
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        event.preventDefault();
        open(id, button);
        document.querySelector('body > .menu .menu-item:not(.disabled)')?.focus();
      }
    });
    bar.append(button);
  }

  // Compact variant for narrow screens: one button, menus as submenus.
  const compact = h('button.icon-btn.menubar-compact', { type: 'button', 'aria-label': 'Menu', 'data-tip': 'Menu' }, icon('menu'));
  compact.addEventListener('click', (event) => {
    event.stopPropagation();
    dropdown(compact, () => MENU_BAR.map(([id, label]) => ({ label, submenu: () => app.menus.items(id) })), { className: 'compact-menu' });
  });

  host.append(compact, bar);
  return bar;
}
