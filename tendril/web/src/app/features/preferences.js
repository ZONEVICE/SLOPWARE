/** Preferences menu: Settings, the nine themes, keyboard shortcuts. */
import { THEMES, applyTheme, currentTheme } from '../core/themes.js';
import { openSettings } from '../pages/settings.js';
import { openShortcuts } from '../pages/shortcuts.js';
import { quickPick } from '../ui/quickpick.js';

export function register(app) {
  const c = (def) => app.commands.register({ category: 'Preferences', ...def });
  c({ id: 'settings.open', title: 'Settings', icon: 'settings', keys: 'Mod+,', terminal: true, run: () => openSettings(app) });
  c({ id: 'shortcuts.open', title: 'Keyboard Shortcuts', icon: 'keyboard', run: () => openShortcuts(app) });
  c({
    id: 'theme.set',
    title: 'Set Theme',
    hidden: true,
    run: (_app, id) => {
      applyTheme(id);
      app.bus.emit('theme:changed', currentTheme());
    },
  });
  c({
    id: 'theme.pick',
    title: 'Color Theme…',
    icon: 'palette',
    run: () => {
      const original = currentTheme().id;
      const preview = (id) => {
        if (id === currentTheme().id) return;
        applyTheme(id, { remember: false });
        app.bus.emit('theme:changed', currentTheme());
      };
      return quickPick({
        placeholder: 'Choose a theme (moving through the list previews it)',
        items: THEMES.map((t) => ({ label: t.name, description: t.id === original ? 'current' : t.kind, id: t.id, picked: t.id === original })),
        onSelect: (item) => preview(item.id),
        onCancel: () => preview(original),
        onAccept: (item) => app.commands.run('theme.set', item.id),
      });
    },
  });
  for (const theme of THEMES) {
    c({
      id: `theme.use.${theme.id}`,
      title: `Theme: ${theme.name}`,
      menuTitle: theme.name,
      checked: () => currentTheme().id === theme.id,
      run: () => app.commands.run('theme.set', theme.id),
    });
  }

  app.menus.add('preferences', { command: 'settings.open', group: '1', order: 1 });
  app.menus.add('preferences', { command: 'shortcuts.open', group: '1', order: 2 });
  app.menus.add('preferences', {
    label: 'Theme',
    icon: 'palette',
    group: '2',
    order: 1,
    submenu: () => THEMES.map((t) => app.menus.commandItem(`theme.use.${t.id}`)),
  });
  app.menus.add('preferences', { command: 'theme.pick', group: '2', order: 2 });
  app.menus.add('preferences', { command: 'view.zoomIn', group: '3', order: 1 });
  app.menus.add('preferences', { command: 'view.zoomOut', group: '3', order: 2 });
  app.menus.add('preferences', { label: 'Editor', group: '4', order: 1, submenu: () => [app.menus.commandItem('editor.use.codemirror'), app.menus.commandItem('editor.use.monaco')] });
  app.toolbar.add({ command: 'theme.pick', group: '6', order: 2, priority: 4 });
  app.toolbar.add({ command: 'settings.open', group: '6', order: 3, priority: 2 });
}
