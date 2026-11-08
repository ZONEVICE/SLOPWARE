/**
 * What the editor area shows when no tab is open: the workspace name and
 * the most useful starting actions with their shortcuts.
 */
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';

const ACTIONS = [
  ['file.newFile', 'new-file'],
  ['quickopen.files', 'go-to-file'],
  ['quickopen.commands', 'command'],
  ['search.inFiles', 'search'],
  ['terminal.toggle', 'terminal'],
  ['workspace.open', 'folder-open'],
  ['settings.open', 'settings'],
];

export function renderWelcome(app, el) {
  el.replaceChildren(
    h('div.welcome', {},
      icon('logo', 'welcome-logo'),
      h('h1.welcome-title', { text: app.workspace?.name || 'Tendril' }),
      h('p.welcome-path', { text: app.workspace?.root || '' }),
      h('div.welcome-actions', {}, ACTIONS.map(([id, iconName]) => {
        const command = app.commands.get(id);
        if (!command) return null;
        return h('button.welcome-action', { type: 'button', onclick: () => app.commands.run(id) },
          icon(iconName),
          h('span.welcome-action-title', { text: command.title }),
          h('kbd', { text: app.commands.shortcut(id) }));
      })),
    ),
  );
}
