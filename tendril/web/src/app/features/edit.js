/**
 * Edit menu: history, clipboard, find/replace and line editing. Most of
 * these forward to the active editor adapter (`app.editors.exec`).
 */
const activeText = (app) => app.tabs.activeDoc?.kind === 'text' && app.editors.ready;

/** Registers an editor command that forwards to the adapter. */
export function editorCommand(app, def) {
  return app.commands.register({
    native: true,
    when: activeText,
    ...def,
    run: async () => {
      if (def.requires && !app.editors.supports(def.exec)) {
        app.ui.toast.info(def.requires);
        return;
      }
      const done = await app.editors.exec(def.exec, ...(def.args || []));
      // `false` means the editor could not do it for this file.
      if (done === false && def.unavailable) app.ui.toast.info(def.unavailable(app));
    },
  });
}

export function register(app) {
  const e = (def) => editorCommand(app, { category: 'Edit', ...def });
  e({ id: 'edit.undo', title: 'Undo', icon: 'undo', keys: 'Mod+Z', exec: 'undo' });
  e({ id: 'edit.redo', title: 'Redo', icon: 'redo', keys: ['Mod+Y', 'Mod+Shift+Z'], exec: 'redo' });
  e({ id: 'edit.cut', title: 'Cut', icon: 'cut', keys: 'Mod+X', exec: 'cut' });
  e({ id: 'edit.copy', title: 'Copy', icon: 'copy', keys: 'Mod+C', exec: 'copy' });
  e({ id: 'edit.paste', title: 'Paste', icon: 'paste', keys: 'Mod+V', exec: 'paste' });
  e({ id: 'edit.find', title: 'Find', icon: 'search', keys: 'Mod+F', exec: 'find' });
  e({ id: 'edit.replace', title: 'Replace', icon: 'replace', keys: 'Mod+H', exec: 'replace', native: false });
  e({ id: 'edit.toggleComment', title: 'Toggle Line Comment', icon: 'comment', keys: 'Mod+/', exec: 'toggleComment' });
  e({ id: 'edit.toggleBlockComment', title: 'Toggle Block Comment', keys: 'Shift+Alt+A', exec: 'toggleBlockComment' });
  e({ id: 'edit.indent', title: 'Indent Line', keys: 'Mod+]', exec: 'indent' });
  e({ id: 'edit.outdent', title: 'Outdent Line', keys: 'Mod+[', exec: 'outdent' });
  e({ id: 'edit.deleteLine', title: 'Delete Line', keys: 'Mod+Shift+K', exec: 'deleteLine' });
  // Not native: Tendril handles the key itself, so CodeMirror (which has no
  // formatter) explains why nothing happens, and Monaco says when the
  // language has no formatter instead of silently doing nothing.
  e({
    id: 'edit.format',
    title: 'Format Document',
    icon: 'format',
    keys: 'Shift+Alt+F',
    exec: 'format',
    native: false,
    requires: 'Formatting is available with the Monaco editor (Tools > Editor).',
    unavailable: (a) => `Monaco has no formatter for ${a.tabs.activeDoc?.language?.name || 'this language'}. It formats JSON, CSS, HTML, JavaScript and TypeScript.`,
  });
  e({ id: 'edit.trimTrailing', title: 'Trim Trailing Whitespace', exec: 'trimTrailing' });
  e({ id: 'edit.upperCase', title: 'Transform to Uppercase', exec: 'upperCase' });
  e({ id: 'edit.lowerCase', title: 'Transform to Lowercase', exec: 'lowerCase' });
  e({ id: 'edit.sortLines', title: 'Sort Lines Ascending', exec: 'sortLines' });
  e({ id: 'edit.foldAll', title: 'Fold All', exec: 'foldAll' });
  e({ id: 'edit.unfoldAll', title: 'Unfold All', exec: 'unfoldAll' });

  const add = (command, group, order) => app.menus.add('edit', { command, group, order });
  add('edit.undo', '1_history', 1);
  add('edit.redo', '1_history', 2);
  add('edit.cut', '2_clipboard', 1);
  add('edit.copy', '2_clipboard', 2);
  add('edit.paste', '2_clipboard', 3);
  add('edit.find', '3_find', 1);
  add('edit.replace', '3_find', 2);
  add('search.inFiles', '3_find', 3);
  add('edit.toggleComment', '4_lines', 1);
  add('edit.toggleBlockComment', '4_lines', 2);
  add('edit.indent', '4_lines', 3);
  add('edit.outdent', '4_lines', 4);
  add('edit.deleteLine', '4_lines', 5);
  add('edit.format', '5_transform', 1);
  add('edit.trimTrailing', '5_transform', 2);
  add('edit.upperCase', '5_transform', 3);
  add('edit.lowerCase', '5_transform', 4);
  add('edit.sortLines', '5_transform', 5);
  add('edit.foldAll', '6_fold', 1);
  add('edit.unfoldAll', '6_fold', 2);

  app.toolbar.add({ command: 'edit.undo', group: '2', order: 1, priority: 2 });
  app.toolbar.add({ command: 'edit.redo', group: '2', order: 2, priority: 2 });
  app.toolbar.add({ command: 'edit.find', group: '3', order: 1, priority: 1 });
  app.toolbar.add({ command: 'edit.replace', group: '3', order: 2, priority: 4 });
}
