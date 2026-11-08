/** Terminal menu and commands for the bottom panel. */
import { createTerminals } from '../terminal/panel.js';

export function register(app) {
  const terminals = createTerminals(app);
  app.terminals = terminals;
  const c = (def) => app.commands.register({ category: 'Terminal', ...def });

  c({
    id: 'terminal.toggle',
    title: 'Toggle Terminal',
    icon: 'terminal',
    keys: 'Mod+`',
    terminal: true,
    checked: () => app.panel.visible,
    run: () => app.panel.toggle(),
  });
  c({ id: 'terminal.new', title: 'New Terminal', icon: 'plus', keys: 'Mod+Shift+`', terminal: true, run: (_app, path = '') => terminals.create(path) });
  c({ id: 'terminal.kill', title: 'Kill Terminal', icon: 'trash', when: () => terminals.count > 0, run: () => terminals.kill() });
  c({ id: 'terminal.clear', title: 'Clear Terminal', icon: 'clear', when: () => terminals.count > 0, run: () => terminals.clear() });
  c({
    id: 'terminal.maximize',
    title: 'Maximize Panel',
    icon: 'maximize',
    checked: () => app.panel.maximized,
    run: () => {
      if (!app.panel.visible) app.panel.show();
      app.panel.toggleMaximize();
    },
  });

  const add = (command, group, order) => app.menus.add('terminal', { command, group, order });
  add('terminal.new', '1', 1);
  add('terminal.toggle', '1', 2);
  add('terminal.kill', '2', 1);
  add('terminal.clear', '2', 2);
  add('terminal.maximize', '3', 1);
  app.toolbar.add({ command: 'terminal.toggle', group: '5', order: 3, priority: 1 });
}
