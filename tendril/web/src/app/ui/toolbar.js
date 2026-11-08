/**
 * The icon toolbar. Features add buttons with
 * `app.toolbar.add({ command, icon?, group, order, priority? })` or any element
 * with `app.toolbar.addElement(el, { group, order })`. Buttons show the
 * command's title and shortcut as a tooltip, reflect toggle state
 * (`aria-pressed`) and disabled state, and refresh whenever a command runs
 * or the active tab changes. `priority` decides which buttons survive on
 * narrow screens: 1 = always, 2 = hidden on phones in portrait (<= 480px),
 * 3 = hidden on phones (< 768px), 4 = wide screens only (>= 1280px).
 */
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';

export function createToolbar(app, host) {
  const entries = [];
  const bar = h('div.toolbar', { role: 'toolbar', 'aria-label': 'Tools' });
  host.append(bar);

  function render() {
    bar.replaceChildren();
    const sorted = [...entries].sort((a, b) => a.group.localeCompare(b.group) || a.order - b.order);
    let group = null;
    for (const entry of sorted) {
      if (group !== null && entry.group !== group) bar.append(h('span.toolbar-sep', { 'aria-hidden': 'true' }));
      group = entry.group;
      bar.append(entry.el);
    }
    refresh();
  }

  function refresh() {
    for (const entry of entries) {
      if (!entry.command) continue;
      const command = app.commands.get(entry.command);
      if (!command) continue;
      entry.el.disabled = !app.commands.enabled(entry.command);
      if (command.checked) entry.el.setAttribute('aria-pressed', String(app.commands.checked(entry.command)));
    }
  }

  const api = {
    add({ command, icon: iconName, group = '5', order = 50, priority = 3 }) {
      const def = app.commands.get(command);
      const title = def?.title || command;
      const keys = app.commands.shortcut(command);
      const el = h(
        'button.icon-btn.toolbar-btn',
        {
          type: 'button',
          'aria-label': title,
          'data-tip': title,
          'data-keys': keys || null,
          class: `prio-${priority}`,
          onclick: () => app.commands.run(command),
        },
        icon(iconName || def?.icon || 'command'),
      );
      entries.push({ command, el, group, order });
      render();
      return el;
    },
    addElement(el, { group = '9', order = 50 } = {}) {
      entries.push({ el, group, order });
      render();
      return el;
    },
    refresh,
  };

  app.bus.on('command:ran', refresh);
  app.bus.on('tab:active', refresh);
  app.bus.on('doc:dirty', refresh);
  app.bus.on('settings:changed', refresh);
  return api;
}
