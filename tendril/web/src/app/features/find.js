/**
 * Find menu and the Search sidebar view: find/replace in the file, find in
 * files, go to file, go to line and (Monaco) go to symbol.
 */
import { createSearchView } from '../sidebar/search.js';
import { quickPick } from '../ui/quickpick.js';
import { editorCommand } from './edit.js';

export function register(app) {
  const search = createSearchView(app);
  app.sidebar.addView({
    id: 'search',
    title: 'Search',
    icon: 'search',
    keys: 'search.inFiles',
    render: (el) => search.render(el),
  });

  const f = (def) => editorCommand(app, { category: 'Find', ...def });
  f({ id: 'find.next', title: 'Find Next', keys: 'F3', exec: 'findNext' });
  f({ id: 'find.previous', title: 'Find Previous', keys: 'Shift+F3', exec: 'findPrevious' });
  f({
    id: 'goto.symbol',
    title: 'Go to Symbol in File…',
    keys: 'Mod+Shift+O',
    exec: 'gotoSymbol',
    native: false,
    requires: 'Go to Symbol is available with the Monaco editor (Tools > Editor).',
  });

  app.commands.register({
    id: 'search.inFiles',
    title: 'Find in Files',
    category: 'Find',
    icon: 'search',
    keys: 'Mod+Shift+F',
    run: () => {
      app.sidebar.show('search');
      const selected = app.tabs.activeDoc?.kind === 'text' ? window.getSelection()?.toString() : '';
      search.focus(selected && selected.length < 200 && !selected.includes('\n') ? selected : '');
    },
  });

  app.commands.register({
    id: 'goto.line',
    title: 'Go to Line…',
    category: 'Find',
    keys: 'Mod+G',
    when: () => app.tabs.activeDoc?.kind === 'text',
    run: () => {
      const cursor = app.editors.cursor();
      const lines = cursor?.lines || 1;
      quickPick({
        placeholder: `Type a line number between 1 and ${lines}, optionally :column`,
        items: (query) => {
          const [line, col] = query.split(/[:,]/).map((n) => parseInt(n, 10));
          if (!line) return [{ label: `Current line: ${cursor?.line || 1}, column ${cursor?.col || 1}`, detail: 'Type a line number to go there' }];
          const target = Math.min(Math.max(1, line), lines);
          return [{ label: `Go to line ${target}${col ? `, column ${col}` : ''}`, line: target, col: col || 1 }];
        },
        onAccept: (item) => item.line && app.editors.exec('goto', item.line, item.col),
      });
    },
  });

  const add = (command, group, order) => app.menus.add('find', { command, group, order });
  add('edit.find', '1_file', 1);
  add('edit.replace', '1_file', 2);
  add('find.next', '1_file', 3);
  add('find.previous', '1_file', 4);
  add('search.inFiles', '2_workspace', 1);
  add('quickopen.files', '3_goto', 1);
  add('goto.line', '3_goto', 2);
  add('goto.symbol', '3_goto', 3);
}
