/**
 * Quick open: "Go to File" (Ctrl+P) and the command palette (Ctrl+Shift+P /
 * F1), one picker with VS Code's prefixes: no prefix searches files, ">"
 * lists commands, ":" jumps to a line.
 *
 * The file list comes from /api/fs/files (one walk, cached briefly) and is
 * filtered in the browser with fuzzy matching, so typing costs no request.
 */
import { api } from '../core/api.js';
import { fuzzyFilter } from '../core/fuzzy.js';
import { fileIcon } from '../core/languages.js';
import { basename, dirname } from '../core/paths.js';
import { quickPick } from '../ui/quickpick.js';

export function register(app) {
  let files = null;
  let loadedAt = 0;
  let truncated = false;

  async function fileList() {
    if (files && Date.now() - loadedAt < 30_000) return files;
    try {
      const result = await api.get('/api/fs/files');
      files = result.files;
      truncated = result.truncated;
      loadedAt = Date.now();
    } catch (err) {
      app.ui.toast.error(`Could not list files: ${err.message}`);
      files = files || [];
    }
    return files;
  }
  app.bus.on('fs:changed', () => {
    files = null;
  });

  function commandItems(query) {
    const commands = app.commands.all().filter((c) => !c.hidden && app.commands.enabled(c.id));
    return fuzzyFilter(query, commands, (c) => `${c.category ? `${c.category}: ` : ''}${c.title}`, 300).map(({ item, positions }) => ({
      label: `${item.category ? `${item.category}: ` : ''}${item.title}`,
      positions,
      keys: app.commands.shortcut(item.id),
      icon: item.icon,
      command: item.id,
    }));
  }

  async function fileItems(query) {
    const list = await fileList();
    const recent = app.tabs.all().filter((t) => t.doc).map((t) => t.doc.path);
    const ordered = query ? list : [...new Set([...recent, ...list])];
    const results = fuzzyFilter(query, ordered, (p) => p, 150).map(({ item, positions }) => {
      const { icon, color } = fileIcon(item);
      const nameStart = item.length - basename(item).length;
      return {
        label: basename(item),
        description: dirname(item),
        positions: positions.filter((p) => p >= nameStart).map((p) => p - nameStart),
        icon,
        iconColor: color,
        path: item,
      };
    });
    if (truncated && !query) results.push({ separator: true, label: 'Only part of the workspace was listed (too many files).' });
    return results;
  }

  function open(initial = '') {
    quickPick({
      placeholder: 'Search files by name (">" for commands, ":" for a line)',
      value: initial,
      items: (query) => {
        if (query.startsWith('>')) return commandItems(query.slice(1));
        if (query.startsWith(':')) {
          const line = parseInt(query.slice(1), 10);
          if (!app.tabs.activeDoc || app.tabs.activeDoc.kind !== 'text') return [{ label: 'Open a text file first' }];
          return [{ label: line ? `Go to line ${line}` : 'Type a line number', line }];
        }
        return fileItems(query);
      },
      emptyText: 'No matching files',
      onAccept: (item) => {
        if (item.command) app.commands.run(item.command);
        else if (item.path) app.tabs.open(item.path);
        else if (item.line) app.editors.exec('goto', item.line, 1);
      },
    });
  }

  app.commands.register({ id: 'quickopen.files', title: 'Go to File…', category: 'Go', icon: 'go-to-file', keys: 'Mod+P', terminal: true, run: () => open('') });
  app.commands.register({
    id: 'quickopen.commands',
    title: 'Command Palette…',
    category: 'View',
    icon: 'command',
    keys: ['Mod+Shift+P', 'F1'],
    terminal: true,
    run: () => open('>'),
  });
  app.toolbar.add({ command: 'quickopen.commands', group: '6', order: 1, priority: 1 });
}
