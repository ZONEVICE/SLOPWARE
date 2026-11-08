/**
 * View menu: the command palette, sidebar views and position, the panel,
 * and the editor display toggles (word wrap, minimap, line numbers,
 * whitespace, font size). Display toggles are settings, saved to
 * settings.json so every browser gets them.
 */
export function register(app) {
  const { commands, menus, toolbar, sidebar, settings } = app;
  const c = (def) => commands.register({ category: 'View', ...def });
  const toggleSetting = (key) => () => settings.set(key, !settings.get(key));

  c({ id: 'view.explorer', title: 'Explorer', icon: 'files', keys: 'Mod+Shift+E', run: () => sidebar.show('explorer') });
  c({
    id: 'view.toggleSidebar',
    title: 'Toggle Sidebar',
    icon: 'sidebar-left',
    keys: 'Mod+B',
    checked: () => sidebar.visible,
    run: () => sidebar.toggle(),
  });
  c({
    id: 'view.sidebarSide',
    title: 'Move Sidebar Right',
    menuTitle: 'Sidebar on the Right',
    icon: 'swap-side',
    checked: () => sidebar.side === 'right',
    run: () => settings.set('ui.sidebar_side', sidebar.side === 'right' ? 'left' : 'right'),
  });
  c({ id: 'view.wordWrap', title: 'Word Wrap', icon: 'wrap', keys: 'Alt+Z', checked: () => !!settings.get('editor.word_wrap'), run: toggleSetting('editor.word_wrap') });
  c({ id: 'view.minimap', title: 'Minimap', icon: 'minimap', checked: () => !!settings.get('editor.minimap'), run: toggleSetting('editor.minimap') });
  c({ id: 'view.lineNumbers', title: 'Line Numbers', checked: () => settings.get('editor.line_numbers') !== false, run: toggleSetting('editor.line_numbers') });
  c({ id: 'view.whitespace', title: 'Render Whitespace', checked: () => !!settings.get('editor.render_whitespace'), run: toggleSetting('editor.render_whitespace') });
  const zoom = (delta) => () => settings.set('editor.font_size', Math.min(72, Math.max(6, (settings.get('editor.font_size') || 14) + delta)));
  c({ id: 'view.zoomIn', title: 'Increase Font Size', icon: 'zoom-in', keys: 'Mod+=', run: zoom(1) });
  c({ id: 'view.zoomOut', title: 'Decrease Font Size', icon: 'zoom-out', keys: 'Mod+-', run: zoom(-1) });
  c({ id: 'view.zoomReset', title: 'Reset Font Size', keys: 'Mod+0', run: () => settings.set('editor.font_size', 14) });
  c({
    id: 'view.fullScreen',
    title: 'Full Screen',
    icon: 'maximize',
    checked: () => !!document.fullscreenElement,
    run: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()),
  });

  const add = (command, group, order) => menus.add('view', { command, group, order });
  add('quickopen.commands', '1_palette', 1);
  add('view.explorer', '2_views', 1);
  add('search.inFiles', '2_views', 2);
  add('terminal.toggle', '2_views', 3);
  add('view.toggleSidebar', '3_layout', 1);
  add('view.sidebarSide', '3_layout', 2);
  add('view.fullScreen', '3_layout', 3);
  add('view.wordWrap', '4_editor', 1);
  add('view.minimap', '4_editor', 2);
  add('view.lineNumbers', '4_editor', 3);
  add('view.whitespace', '4_editor', 4);
  add('view.zoomIn', '5_zoom', 1);
  add('view.zoomOut', '5_zoom', 2);
  add('view.zoomReset', '5_zoom', 3);

  toolbar.add({ command: 'view.wordWrap', group: '4', order: 1, priority: 3 });
  toolbar.add({ command: 'view.minimap', group: '4', order: 2, priority: 3 });
  toolbar.add({ command: 'view.toggleSidebar', group: '5', order: 1, priority: 1 });
  toolbar.add({ command: 'view.sidebarSide', group: '5', order: 2, priority: 4 });

  // Apply the side from settings now and whenever it changes.
  sidebar.setSide(settings.get('ui.sidebar_side', 'left'));
  app.bus.on('settings:changed', (s) => sidebar.setSide(s.ui?.sidebar_side || 'left'));
}
