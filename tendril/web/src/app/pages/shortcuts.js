/**
 * The Keyboard Shortcuts tab: every command with its shortcut, grouped by
 * category and searchable. Generated from the command registry, so it is
 * always complete.
 */
import { h } from '../core/dom.js';

export function openShortcuts(app) {
  return app.tabs.openPage({
    id: 'shortcuts',
    title: 'Keyboard Shortcuts',
    icon: 'keyboard',
    render: (el) => {
      el.classList.add('shortcuts-page');
      const search = h('input.input', { type: 'search', placeholder: 'Search commands or keys', spellcheck: 'false' });
      const table = h('div.shortcuts-table');
      const render = () => {
        const q = search.value.trim().toLowerCase();
        const groups = new Map();
        for (const command of app.commands.all()) {
          if (command.hidden) continue;
          const keys = app.commands.shortcut(command.id);
          const text = `${command.category || ''} ${command.title} ${keys}`.toLowerCase();
          if (q && !text.includes(q)) continue;
          const group = command.category || 'Other';
          if (!groups.has(group)) groups.set(group, []);
          groups.get(group).push({ command, keys });
        }
        table.replaceChildren(...[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([group, items]) =>
          h('section.shortcut-group', {}, h('h2', { text: group }),
            ...items.sort((a, b) => a.command.title.localeCompare(b.command.title)).map(({ command, keys }) =>
              h('div.shortcut-row', {},
                h('button.shortcut-title', { type: 'button', text: command.title, onclick: () => app.commands.run(command.id) }),
                keys ? h('kbd', { text: keys }) : h('span.shortcut-none', { text: '—' }))))));
      };
      search.addEventListener('input', render);
      el.append(h('div.shortcuts-inner', {}, h('h1', { text: 'Keyboard Shortcuts' }),
        h('p.muted', { text: 'Some browser shortcuts (Ctrl+W, Ctrl+T, Ctrl+N) cannot be taken over by a web page, so Tendril uses Alt for those.' }),
        search, table));
      render();
    },
  });
}
