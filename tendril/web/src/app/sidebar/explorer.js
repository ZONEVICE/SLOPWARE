/**
 * The Explorer: the workspace's file tree.
 *
 * - Lazy: a folder is listed only when it is expanded; nothing walks the
 *   whole tree.
 * - Virtualised: only the rows in view exist in the DOM, so a folder with
 *   thousands of entries costs the same as one with ten.
 * - Selection: click, Ctrl/Cmd+click (toggle), Shift+click (range);
 *   keyboard: arrows, Enter, F2 (rename), Delete, Ctrl+C/X/V.
 * - Edits: new file/folder and rename happen inline; copy/cut/paste and
 *   drag-and-drop move or copy (hold Ctrl/Alt to copy); files dragged in from
 *   the desktop are uploaded to the folder they are dropped on.
 * - Context menu on right-click, long-press, or the row's "more" button on
 *   touch screens.
 * - Refreshes the folders it shows when files change (`fs:changed`) and when
 *   the window regains focus (quietly).
 */
import { api } from '../core/api.js';
import { h, iconButton, isNarrow, isTouch } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { fileIcon } from '../core/languages.js';
import { basename, dirname, isWithin, join, naturalCompare } from '../core/paths.js';
import { contextMenu } from '../ui/menu.js';

export function createExplorer(app) {
  let decorate = null; // see setDecorator
  const children = new Map(); // dir path -> entries[]
  const expanded = new Set(['']);
  const loading = new Set();
  let selection = new Set();
  let anchor = null;
  let focused = null;
  let clipboard = null; // { paths, cut }
  let editing = null; // { kind: 'rename'|'file'|'dir', path, parent }
  let editInput = null; // the inline name field, kept across repaints
  let rows = [];
  let el = null;
  let scroller = null;
  let spacer = null;
  let rowHeight = 22;

  // ------------------------------------------------------------ data
  async function load(dir, { quiet = false } = {}) {
    if (loading.has(dir)) return;
    loading.add(dir);
    try {
      const result = await api.get('/api/fs/list', { query: { path: dir }, quiet });
      const showHidden = app.settings.get('ui.show_hidden_files', true);
      const entries = result.entries
        .filter((e) => showHidden || !e.hidden)
        .map((e) => ({ ...e, path: join(dir, e.name) }));
      entries.sort((a, b) => (a.kind === 'dir') !== (b.kind === 'dir') ? (a.kind === 'dir' ? -1 : 1) : naturalCompare(a.name, b.name));
      children.set(dir, entries);
    } catch (err) {
      if (err.code === 'not_found' || err.code === 'not_a_directory') {
        children.delete(dir);
        expanded.delete(dir);
      } else if (!quiet) {
        app.ui.toast.error(`Could not list ${dir || 'the workspace'}: ${err.message}`);
      }
    } finally {
      loading.delete(dir);
    }
  }

  /** Re-lists every loaded folder that is (or contains) one of `paths`' parents. */
  async function refresh(paths = null, { quiet = false } = {}) {
    const dirs = paths
      ? [...new Set(paths.map((p) => dirname(p)).concat(paths))].filter((d) => children.has(d))
      : [...children.keys()];
    await Promise.all(dirs.map((d) => load(d, { quiet })));
    // Forget folders that disappeared.
    for (const dir of [...children.keys()]) {
      if (dir && !findEntry(dir)) {
        children.delete(dir);
        expanded.delete(dir);
      }
    }
    render();
  }

  function findEntry(path) {
    return (children.get(dirname(path)) || []).find((e) => e.path === path) || null;
  }

  function flatten() {
    const out = [];
    const walk = (dir, depth) => {
      const entries = children.get(dir) || [];
      if (editing && editing.kind !== 'rename' && editing.parent === dir) {
        out.push({ editRow: true, depth, kind: editing.kind });
      }
      for (const entry of entries) {
        out.push({ entry, depth });
        if (entry.kind === 'dir' && expanded.has(entry.path)) {
          if (!children.has(entry.path)) {
            out.push({ placeholder: true, depth: depth + 1 });
            load(entry.path).then(render);
          } else walk(entry.path, depth + 1);
        }
      }
    };
    walk('', 0);
    return out;
  }

  // ---------------------------------------------------------- render
  function render() {
    if (!el) return;
    rows = flatten();
    rowHeight = parseFloat(getComputedStyle(el).getPropertyValue('--row-height')) || (isTouch() ? 34 : 22);
    spacer.style.height = `${rows.length * rowHeight}px`;
    paint();
    app.bus.emit('explorer:rendered');
  }

  function paint() {
    if (!scroller) return;
    const top = scroller.scrollTop;
    const height = scroller.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / rowHeight) - 10);
    const last = Math.min(rows.length, Math.ceil((top + height) / rowHeight) + 10);
    const fragment = document.createDocumentFragment();
    for (let i = first; i < last; i += 1) fragment.append(renderRow(rows[i], i));
    const fresh = editInput && !editInput.isConnected && !editInput.dataset.shown;
    spacer.replaceChildren(fragment);
    if (editInput?.isConnected) {
      // Repaints move the same input around; give it the focus back.
      editInput.focus({ preventScroll: true });
      if (fresh) {
        editInput.dataset.shown = '1';
        const name = editInput.value;
        const dot = editing?.kind === 'rename' && !name.startsWith('.') ? name.lastIndexOf('.') : -1;
        editInput.setSelectionRange(0, dot > 0 ? dot : name.length);
      }
    }
    if (!rows.length) {
      spacer.append(h('div.tree-empty', { text: 'This folder is empty.' }));
    }
  }

  function renderRow(row, index) {
    const style = { top: `${index * rowHeight}px`, '--depth': row.depth };
    if (row.placeholder) {
      const node = h('div.tree-row.placeholder', { style }, h('span.tree-indent'), h('span.tree-loading', { text: 'Loading…' }));
      node.style.setProperty('--depth', row.depth);
      return node;
    }
    if (row.editRow) return editRow(row, style);
    const { entry } = row;
    const isDir = entry.kind === 'dir';
    const open = isDir && expanded.has(entry.path);
    const doc = app.documents.get(entry.path);
    const renaming = editing?.kind === 'rename' && editing.path === entry.path;
    const node = h('div.tree-row', {
      role: 'treeitem',
      'aria-level': String(row.depth + 1),
      'aria-expanded': isDir ? String(open) : null,
      'aria-selected': String(selection.has(entry.path)),
      'data-path': entry.path,
      draggable: renaming ? 'false' : 'true',
      class: [
        selection.has(entry.path) ? 'selected' : '',
        focused === entry.path ? 'focused' : '',
        app.tabs.activeDoc?.path === entry.path ? 'active-file' : '',
        entry.hidden ? 'hidden-entry' : '',
        clipboard?.cut && clipboard.paths.includes(entry.path) ? 'cut' : '',
        entry.unreachable ? 'unreachable' : '',
      ].join(' '),
    });
    node.style.top = style.top;
    node.style.setProperty('--depth', row.depth);
    node.append(h('span.tree-indent'));
    node.append(isDir ? icon(open ? 'chevron-down' : 'chevron-right', 'tree-twisty') : h('span.tree-twisty'));
    if (isDir) {
      node.append(icon(open ? 'folder-open' : 'folder', 'tree-icon folder'));
    } else {
      const { icon: iconName, color } = fileIcon(entry.path);
      const glyph = icon(iconName, 'tree-icon');
      glyph.style.color = `var(${color})`;
      node.append(glyph);
    }
    if (renaming) {
      node.classList.add('tree-edit');
      node.append(editInput || (editInput = nameInput(entry.name, (value) => commitRename(entry, value))));
    } else {
      node.append(h('span.tree-name', { text: entry.name }));
      if (entry.symlink) node.append(icon('link', 'tree-badge'));
      if (doc?.dirty) node.append(h('span.tree-dirty', { 'aria-label': 'unsaved' }));
      const deco = decorate?.(entry.path, isDir);
      if (deco) {
        if (deco.className) node.classList.add(...deco.className.split(' '));
        if (deco.badge) node.append(h('span.tree-deco', { text: deco.badge, 'data-tip': deco.title || null }));
      }
      if (isTouch()) {
        node.append(iconButton('more', 'Actions', (event) => {
          event.stopPropagation();
          if (!selection.has(entry.path)) select(entry.path);
          contextMenu(event, menuFor(entry));
        }, { class: 'tree-more' }));
      }
    }
    return node;
  }

  function editRow(row, style) {
    const node = h('div.tree-row.tree-edit');
    node.style.top = style.top;
    node.style.setProperty('--depth', row.depth);
    node.append(h('span.tree-indent'), h('span.tree-twisty'), icon(row.kind === 'dir' ? 'folder' : 'file', 'tree-icon'));
    node.append(editInput || (editInput = nameInput('', (value) => commitCreate(value))));
    return node;
  }

  function nameInput(value, commit) {
    let done = false;
    const input = h('input.tree-input', { type: 'text', value, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Name' });
    const finish = (save) => {
      if (done) return;
      done = true;
      editInput = null;
      if (save && input.value.trim() && input.value !== value) commit(input.value.trim());
      else cancelEdit();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
    });
    // A repaint briefly detaches the field; only a real loss of focus commits.
    input.addEventListener('blur', () => setTimeout(() => {
      if (input.isConnected && document.activeElement !== input && document.hasFocus()) finish(true);
    }, 0));
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    input.addEventListener('click', (event) => event.stopPropagation());
    return input;
  }

  function cancelEdit() {
    editing = null;
    editInput = null;
    render();
    scroller?.focus({ preventScroll: true });
  }

  // ------------------------------------------------------- selection
  function select(path, { additive = false, range = false } = {}) {
    if (range && anchor) {
      const paths = rows.filter((r) => r.entry).map((r) => r.entry.path);
      const a = paths.indexOf(anchor);
      const b = paths.indexOf(path);
      if (a >= 0 && b >= 0) {
        selection = new Set(paths.slice(Math.min(a, b), Math.max(a, b) + 1));
        focused = path;
        render();
        return;
      }
    }
    if (additive) {
      if (selection.has(path)) selection.delete(path);
      else selection.add(path);
    } else selection = new Set([path]);
    anchor = path;
    focused = path;
    render();
  }

  function selectedEntries() {
    const out = [];
    for (const path of selection) {
      const entry = findEntry(path);
      if (entry) out.push(entry);
    }
    return out;
  }

  /** The folder new items go into: the focused folder, or the parent of the focused file. */
  function targetFolder() {
    const entry = focused ? findEntry(focused) : null;
    if (!entry) return '';
    return entry.kind === 'dir' ? entry.path : dirname(entry.path);
  }

  // --------------------------------------------------------- actions
  async function toggle(entry) {
    if (expanded.has(entry.path)) expanded.delete(entry.path);
    else {
      expanded.add(entry.path);
      if (!children.has(entry.path)) await load(entry.path);
    }
    render();
  }

  /** Opens a file (or toggles a folder). A single click keeps the focus in
   *  the tree, like VS Code; Enter and double-click move it to the editor. */
  function openEntry(entry, { focus = false } = {}) {
    if (entry.kind === 'dir') return toggle(entry);
    if (entry.unreachable) {
      app.ui.toast.warn(`${entry.name} points outside the workspace or nowhere.`);
      return null;
    }
    if (isNarrow()) app.sidebar.hideDrawer();
    return app.tabs.open(entry.path, { focus });
  }

  async function startCreate(kind, parent = targetFolder()) {
    app.sidebar.show('explorer');
    if (parent) {
      expanded.add(parent);
      if (!children.has(parent)) await load(parent);
    }
    editing = { kind, parent };
    render();
    const index = rows.findIndex((r) => r.editRow);
    if (index >= 0) scrollToIndex(index);
  }

  async function commitCreate(name) {
    const { kind, parent } = editing;
    editing = null;
    const path = join(parent, name);
    try {
      await api.post('/api/fs/create', { path, dir: kind === 'dir' });
      await load(parent);
      selection = new Set([path]);
      focused = path;
      anchor = path;
      render();
      app.bus.emit('fs:changed', { paths: [path] });
      if (kind === 'file') app.tabs.open(path);
    } catch (err) {
      app.ui.toast.error(`Could not create ${name}: ${err.message}`);
      render();
    }
  }

  function startRename(entry = selectedEntries()[0]) {
    if (!entry) return;
    editing = { kind: 'rename', path: entry.path };
    render();
  }

  async function commitRename(entry, name) {
    editing = null;
    const to = join(dirname(entry.path), name);
    await move([entry.path], dirname(entry.path), { renameTo: to });
  }

  /** Moves (or copies) paths into folder `dest`. */
  async function move(paths, dest, { copy = false, renameTo = null } = {}) {
    const done = [];
    for (const from of paths) {
      const to = renameTo || join(dest, basename(from));
      if (!copy && to === from) continue;
      if (isWithin(from, dest) && !renameTo) {
        app.ui.toast.warn(`Cannot ${copy ? 'copy' : 'move'} ${basename(from)} into itself.`);
        continue;
      }
      try {
        if (copy) {
          const target = to === from ? null : to;
          if (target) await api.post('/api/fs/copy', { from, to: target });
          else await api.post('/api/fs/duplicate', { path: from });
        } else {
          await moveOne(from, to);
        }
        done.push(to);
      } catch (err) {
        app.ui.toast.error(`Could not ${copy ? 'copy' : 'move'} ${basename(from)}: ${err.message}`);
      }
    }
    await refresh([...paths, ...done, dest]);
    if (done.length) {
      selection = new Set(done);
      focused = done[0];
      render();
      app.bus.emit('fs:changed', { paths: [...paths, ...done] });
    }
  }

  async function moveOne(from, to) {
    try {
      await api.post('/api/fs/rename', { from, to });
    } catch (err) {
      if (err.code !== 'exists') throw err;
      const ok = await app.ui.dialog.confirm({
        title: 'Replace?',
        message: `${basename(to)} already exists in ${dirname(to) || 'the workspace root'}. Replace it?`,
        confirmLabel: 'Replace',
        danger: true,
      });
      if (!ok) throw new Error('cancelled');
      await api.post('/api/fs/rename', { from, to, overwrite: true });
    }
    app.documents.rename(from, to);
    if (expanded.has(from)) {
      for (const p of [...expanded]) if (isWithin(from, p)) {
        expanded.delete(p);
        expanded.add(to + p.slice(from.length));
      }
    }
  }

  async function remove(entries = selectedEntries()) {
    if (!entries.length) return;
    const names = entries.map((e) => e.name);
    if (app.settings.get('ui.confirm_delete', true)) {
      const ok = await app.ui.dialog.confirm({
        title: entries.length === 1 ? `Delete ${names[0]}?` : `Delete ${entries.length} items?`,
        message: `${entries.length === 1 ? (entries[0].kind === 'dir' ? 'This folder and everything in it' : 'This file') : names.slice(0, 6).join(', ') + (names.length > 6 ? '…' : '')} will be deleted permanently. This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
    }
    const paths = entries.map((e) => e.path);
    try {
      const result = await api.post('/api/fs/delete', { paths });
      for (const failure of result.errors) app.ui.toast.error(`Could not delete ${failure.path}: ${failure.message}`);
    } catch (err) {
      app.ui.toast.error(`Delete failed: ${err.message}`);
    }
    for (const path of paths) {
      for (const tab of app.tabs.all()) {
        if (tab.doc && isWithin(path, tab.doc.path)) await app.tabs.close(tab, { force: true });
      }
    }
    selection = new Set();
    await refresh(paths);
    app.bus.emit('fs:changed', { paths });
  }

  function copyToClipboard(cut) {
    const paths = [...selection];
    if (!paths.length) return;
    clipboard = { paths, cut };
    render();
    app.ui.toast.info(`${cut ? 'Cut' : 'Copied'} ${paths.length === 1 ? basename(paths[0]) : `${paths.length} items`}. Paste into a folder.`);
  }

  async function paste(dest = targetFolder()) {
    if (!clipboard) return;
    const { paths, cut } = clipboard;
    if (cut) clipboard = null;
    if (cut) await move(paths, dest);
    else {
      // Copies into the same folder get a " copy" name from the server.
      const done = [];
      for (const from of paths) {
        try {
          if (dirname(from) === dest) {
            done.push((await api.post('/api/fs/duplicate', { path: from })).path);
          } else {
            let to = join(dest, basename(from));
            try {
              await api.post('/api/fs/copy', { from, to });
            } catch (err) {
              if (err.code !== 'exists') throw err;
              await api.post('/api/fs/copy', { from, to: (to = join(dest, `${basename(from)} copy`)) });
            }
            done.push(to);
          }
        } catch (err) {
          app.ui.toast.error(`Could not paste ${basename(from)}: ${err.message}`);
        }
      }
      await refresh([dest, ...done]);
      selection = new Set(done);
      render();
      app.bus.emit('fs:changed', { paths: done });
    }
  }

  /** Uploads browser File objects into `dest`. */
  async function upload(files, dest = targetFolder()) {
    const list = [...files];
    if (!list.length) return;
    const toast = app.ui.toast.info(`Uploading ${list.length} file${list.length > 1 ? 's' : ''}…`, { sticky: true });
    let ok = 0;
    for (const file of list) {
      const path = join(dest, file.name);
      try {
        await api.put('/api/fs/upload', file, { query: { path } });
        ok += 1;
      } catch (err) {
        if (err.code === 'exists') {
          const replace = await app.ui.dialog.confirm({ title: 'Replace?', message: `${path} already exists. Replace it?`, confirmLabel: 'Replace', danger: true });
          if (replace) {
            try {
              await api.put('/api/fs/upload', file, { query: { path, overwrite: 1 } });
              ok += 1;
            } catch (e) {
              app.ui.toast.error(`Upload of ${file.name} failed: ${e.message}`);
            }
          }
        } else app.ui.toast.error(`Upload of ${file.name} failed: ${err.message}`);
      }
    }
    toast.close();
    if (ok) app.ui.toast.success(`Uploaded ${ok} file${ok > 1 ? 's' : ''} to ${dest || 'the workspace root'}.`);
    if (dest) expanded.add(dest);
    await refresh([dest]);
    app.bus.emit('fs:changed', { paths: list.map((f) => join(dest, f.name)) });
  }

  function pickAndUpload(dest = targetFolder()) {
    const input = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
    input.addEventListener('change', () => {
      upload(input.files, dest);
      input.remove();
    });
    document.body.append(input);
    input.click();
  }

  async function reveal(path) {
    app.sidebar.show('explorer');
    const parts = path.split('/');
    let dir = '';
    for (const part of parts.slice(0, -1)) {
      dir = join(dir, part);
      expanded.add(dir);
      if (!children.has(dir)) await load(dir);
    }
    selection = new Set([path]);
    focused = path;
    anchor = path;
    render();
    const index = rows.findIndex((r) => r.entry?.path === path);
    if (index >= 0) scrollToIndex(index);
  }

  function scrollToIndex(index) {
    if (!scroller) return;
    const top = index * rowHeight;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + rowHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + rowHeight - scroller.clientHeight;
  }

  function collapseAll() {
    expanded.clear();
    expanded.add('');
    render();
  }

  // --------------------------------------------------------- menus
  function menuFor(entry) {
    const many = selection.size > 1 && selection.has(entry?.path);
    const folder = entry ? (entry.kind === 'dir' ? entry.path : dirname(entry.path)) : '';
    const items = [];
    if (entry && !many && entry.kind !== 'dir') {
      items.push({ label: 'Open', icon: 'file', run: () => openEntry(entry) });
      items.push({ separator: true });
    }
    items.push(
      { label: 'New File…', icon: 'new-file', run: () => startCreate('file', folder) },
      { label: 'New Folder…', icon: 'new-folder', run: () => startCreate('dir', folder) },
      { label: 'Upload Files…', icon: 'upload', run: () => pickAndUpload(folder) },
      { separator: true },
    );
    if (entry) {
      items.push(
        { label: 'Cut', icon: 'cut', keys: 'Ctrl+X', run: () => copyToClipboard(true) },
        { label: 'Copy', icon: 'copy', keys: 'Ctrl+C', run: () => copyToClipboard(false) },
      );
    }
    items.push({ label: 'Paste', icon: 'paste', keys: 'Ctrl+V', disabled: !clipboard, run: () => paste(folder) });
    if (entry) {
      items.push(
        { separator: true },
        { label: 'Rename…', icon: 'rename', keys: 'F2', disabled: many, run: () => startRename(entry) },
        { label: 'Duplicate', icon: 'duplicate', disabled: many, run: () => move([entry.path], dirname(entry.path), { copy: true }) },
        { label: many ? `Delete ${selection.size} Items` : 'Delete', icon: 'trash', keys: 'Delete', danger: true, run: () => remove() },
        { separator: true },
        { label: 'Copy Path', run: () => app.commands.run('file.copyPath', entry.path) },
        { label: 'Copy Relative Path', run: () => app.commands.run('file.copyRelativePath', entry.path) },
      );
      if (entry.kind !== 'dir') items.push({ label: 'Download', icon: 'download', run: () => app.commands.run('file.download', entry.path) });
      if (entry.kind === 'dir') items.push({ label: 'Open Terminal Here', icon: 'terminal', run: () => app.commands.run('terminal.new', entry.path) });
    }
    items.push({ separator: true }, { label: 'Refresh', icon: 'refresh', run: () => refresh() }, { label: 'Collapse All', icon: 'collapse-all', run: collapseAll });
    return items;
  }

  // --------------------------------------------------------- events
  function rowFromEvent(event) {
    const node = event.target instanceof Element ? event.target.closest('.tree-row[data-path]') : null;
    return node ? rows.find((r) => r.entry?.path === node.dataset.path)?.entry || null : null;
  }

  function mount(container) {
    el = h('div.explorer', { role: 'tree', 'aria-label': 'Files' });
    spacer = h('div.tree-spacer');
    scroller = h('div.tree-scroll', { tabindex: '0' }, spacer);
    el.append(scroller);
    container.append(el);

    scroller.addEventListener('scroll', () => requestAnimationFrame(paint), { passive: true });
    new ResizeObserver(() => paint()).observe(scroller);

    scroller.addEventListener('click', (event) => {
      const entry = rowFromEvent(event);
      if (!entry) {
        if (event.target === scroller || event.target === spacer) {
          selection = new Set();
          focused = null;
          render();
        }
        return;
      }
      if (event.target.closest('.tree-more')) return;
      const additive = event.ctrlKey || event.metaKey;
      select(entry.path, { additive, range: event.shiftKey });
      if (!additive && !event.shiftKey) openEntry(entry);
    });
    scroller.addEventListener('dblclick', (event) => {
      const entry = rowFromEvent(event);
      if (entry && entry.kind !== 'dir') openEntry(entry, { focus: true });
    });
    scroller.addEventListener('contextmenu', (event) => {
      const entry = rowFromEvent(event);
      if (entry && !selection.has(entry.path)) select(entry.path);
      contextMenu(event, menuFor(entry));
    });
    scroller.addEventListener('keydown', (event) => {
      if (editing) return;
      const visible = rows.filter((r) => r.entry).map((r) => r.entry);
      const index = visible.findIndex((e) => e.path === focused);
      const current = visible[index];
      const mod = event.ctrlKey || event.metaKey;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const next = visible[Math.min(visible.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
        if (next) {
          select(next.path, { range: event.shiftKey });
          scrollToIndex(rows.findIndex((r) => r.entry === next));
        }
      } else if (event.key === 'ArrowRight' && current?.kind === 'dir' && !expanded.has(current.path)) toggle(current);
      else if (event.key === 'ArrowLeft' && current) {
        if (current.kind === 'dir' && expanded.has(current.path)) toggle(current);
        else if (dirname(current.path)) select(dirname(current.path));
      } else if (event.key === 'Enter' && current) openEntry(current, { focus: true });
      else if (event.key === 'F2' && current) startRename(current);
      else if (event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey)) remove();
      else if (mod && event.code === 'KeyC') copyToClipboard(false);
      else if (mod && event.code === 'KeyX') copyToClipboard(true);
      else if (mod && event.code === 'KeyV') paste();
      else if (mod && event.code === 'KeyA') {
        selection = new Set(visible.map((e) => e.path));
        render();
      } else return;
      event.preventDefault();
      event.stopPropagation();
    });

    // Long-press opens the context menu on touch screens.
    let pressTimer = null;
    scroller.addEventListener('touchstart', (event) => {
      const entry = rowFromEvent(event);
      pressTimer = setTimeout(() => {
        if (entry && !selection.has(entry.path)) select(entry.path);
        const touch = event.touches[0];
        contextMenu({ preventDefault() {}, stopPropagation() {}, clientX: touch.clientX, clientY: touch.clientY }, menuFor(entry));
      }, 550);
    }, { passive: true });
    for (const type of ['touchend', 'touchmove', 'touchcancel']) scroller.addEventListener(type, () => clearTimeout(pressTimer), { passive: true });

    // Drag and drop: rows move/copy; desktop files upload.
    let dragPaths = null;
    scroller.addEventListener('dragstart', (event) => {
      const entry = rowFromEvent(event);
      if (!entry) return;
      if (!selection.has(entry.path)) select(entry.path);
      dragPaths = [...selection];
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData('application/x-tendril-paths', JSON.stringify(dragPaths));
      event.dataTransfer.setData('text/plain', dragPaths.join('\n'));
    });
    scroller.addEventListener('dragend', () => {
      dragPaths = null;
      scroller.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
      el.classList.remove('drop-root');
    });
    const dropFolder = (event) => {
      const entry = rowFromEvent(event);
      if (!entry) return '';
      return entry.kind === 'dir' ? entry.path : dirname(entry.path);
    };
    scroller.addEventListener('dragover', (event) => {
      const external = event.dataTransfer.types.includes('Files');
      if (!dragPaths && !external) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = external || event.ctrlKey || event.altKey ? 'copy' : 'move';
      const folder = dropFolder(event);
      scroller.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
      if (folder) scroller.querySelector(`.tree-row[data-path="${CSS.escape(folder)}"]`)?.classList.add('drop-target');
      el.classList.toggle('drop-root', !folder);
    });
    scroller.addEventListener('dragleave', (event) => {
      if (!scroller.contains(event.relatedTarget)) el.classList.remove('drop-root');
    });
    scroller.addEventListener('drop', (event) => {
      event.preventDefault();
      el.classList.remove('drop-root');
      const folder = dropFolder(event);
      if (event.dataTransfer.files?.length && !dragPaths) {
        upload(event.dataTransfer.files, folder);
        return;
      }
      if (dragPaths) move(dragPaths, folder, { copy: event.ctrlKey || event.altKey });
      dragPaths = null;
    });

    load('').then(render);
  }

  /**
   * Row decorations from other features (git colors): `fn(path, isDir)`
   * returns `{ className?, badge?, title? }` or null. One provider.
   */
  function setDecorator(fn) {
    decorate = fn;
    render();
  }

  // Keep the tree in sync with changes made elsewhere.
  app.bus.on('fs:changed', ({ paths } = {}) => refresh(paths || null, { quiet: true }));
  app.bus.on('doc:dirty', render);
  app.bus.on('tab:active', render);
  app.bus.on('settings:changed', (settings, patch) => {
    if (patch?.ui && 'show_hidden_files' in patch.ui) refresh();
  });
  window.addEventListener('focus', () => refresh(null, { quiet: true }));

  return {
    mount,
    refresh,
    reveal,
    setDecorator,
    repaint: () => render(),
    startCreate,
    startRename: () => startRename(),
    remove: () => remove(),
    upload,
    pickAndUpload,
    collapseAll,
    copy: () => copyToClipboard(false),
    cut: () => copyToClipboard(true),
    paste: () => paste(),
    get selection() {
      return [...selection];
    },
  };
}
