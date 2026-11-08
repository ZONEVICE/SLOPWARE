/** Selection menu: select all, smart expand, line moves, multi-cursor. */
import { editorCommand } from './edit.js';

export function register(app) {
  const s = (def) => editorCommand(app, { category: 'Selection', ...def });
  s({ id: 'selection.all', title: 'Select All', keys: 'Mod+A', exec: 'selectAll' });
  s({ id: 'selection.expand', title: 'Expand Selection', keys: 'Shift+Alt+Right', exec: 'expandSelection' });
  s({ id: 'selection.copyLineUp', title: 'Copy Line Up', keys: 'Shift+Alt+Up', exec: 'copyLineUp' });
  s({ id: 'selection.copyLineDown', title: 'Copy Line Down', keys: 'Shift+Alt+Down', exec: 'copyLineDown' });
  s({ id: 'selection.moveLineUp', title: 'Move Line Up', keys: 'Alt+Up', exec: 'moveLineUp' });
  s({ id: 'selection.moveLineDown', title: 'Move Line Down', keys: 'Alt+Down', exec: 'moveLineDown' });
  s({ id: 'selection.cursorAbove', title: 'Add Cursor Above', keys: 'Mod+Alt+Up', exec: 'addCursorAbove' });
  s({ id: 'selection.cursorBelow', title: 'Add Cursor Below', keys: 'Mod+Alt+Down', exec: 'addCursorBelow' });
  s({ id: 'selection.nextOccurrence', title: 'Add Next Occurrence', keys: 'Mod+D', exec: 'selectNextOccurrence' });
  s({ id: 'selection.allOccurrences', title: 'Select All Occurrences', keys: 'Mod+Shift+L', exec: 'selectAllOccurrences' });

  const add = (command, group, order) => app.menus.add('selection', { command, group, order });
  add('selection.all', '1', 1);
  add('selection.expand', '1', 2);
  add('selection.copyLineUp', '2', 1);
  add('selection.copyLineDown', '2', 2);
  add('selection.moveLineUp', '2', 3);
  add('selection.moveLineDown', '2', 4);
  add('selection.cursorAbove', '3', 1);
  add('selection.cursorBelow', '3', 2);
  add('selection.nextOccurrence', '3', 3);
  add('selection.allOccurrences', '3', 4);
  app.menus.add('selection', {
    group: '4',
    items: () => [{ label: 'Column selection: Alt+drag (CodeMirror) / Shift+Alt+drag (Monaco)', disabled: true }],
  });
}
