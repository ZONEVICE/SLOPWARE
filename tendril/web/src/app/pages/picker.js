/**
 * The folder picker shown after login (and by File > Open Folder): browse
 * the host's directory tree from its root and choose the workspace. Only
 * folders are listed, never files; nothing is ever written into the chosen
 * folder.
 */
import { api } from '../core/api.js';
import { h, iconButton } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { naturalCompare } from '../core/paths.js';
import { store } from '../core/store.js';

/**
 * Renders the picker into `root`. Resolves when a folder was opened, with
 * the server's `{ id, root, name }`.
 */
export function showPicker(root, { onCancel, onLogout } = {}) {
  return new Promise((resolve) => {
    root.className = 'picker-page';
    root.replaceChildren();
    let listing = null;
    let showHidden = store.get('pickerHidden', false);
    let filter = '';
    let selected = 0;

    const crumbs = h('nav.picker-crumbs', { 'aria-label': 'Path' });
    const pathInput = h('input.input.picker-path', { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Folder path' });
    const filterInput = h('input.input.picker-filter', { type: 'search', placeholder: 'Filter folders', spellcheck: 'false', 'aria-label': 'Filter folders' });
    const list = h('div.picker-list', { role: 'listbox', tabindex: '-1' });
    const status = h('div.picker-status');
    const openButton = h('button.btn.primary.picker-open', { type: 'button' }, icon('folder-open'), h('span', { text: 'Open this folder' }));
    const hiddenToggle = h('label.check', {}, h('input', { type: 'checkbox', checked: showHidden }), h('span', { text: 'Show hidden' }));
    const roots = h('div.picker-roots');
    const recent = h('div.picker-recent');

    hiddenToggle.querySelector('input').addEventListener('change', (event) => {
      showHidden = event.target.checked;
      store.set('pickerHidden', showHidden);
      renderList();
    });

    async function go(path) {
      status.textContent = 'Loading…';
      try {
        listing = await api.get('/api/picker/list', { query: { path } });
        filter = '';
        filterInput.value = '';
        selected = 0;
        pathInput.value = listing.path;
        store.set('pickerLast', listing.path);
        renderCrumbs();
        renderList();
        status.textContent = '';
        openButton.querySelector('span').textContent = `Open ${listing.crumbs[listing.crumbs.length - 1][0]}`;
        return true;
      } catch (err) {
        status.textContent = err.message;
        return false;
      }
    }

    function renderCrumbs() {
      crumbs.replaceChildren(...listing.crumbs.flatMap(([name, path], i) => [
        i > 0 ? icon('chevron-right', 'crumb-sep') : null,
        h('button.crumb', { type: 'button', text: name, onclick: () => go(path) }),
      ]));
      crumbs.scrollLeft = crumbs.scrollWidth;
    }

    function visibleDirs() {
      if (!listing) return [];
      const q = filter.toLowerCase();
      return listing.dirs
        .filter((d) => (showHidden || !d.hidden) && (!q || d.name.toLowerCase().includes(q)))
        .sort((a, b) => naturalCompare(a.name, b.name));
    }

    function renderList() {
      const dirs = visibleDirs();
      list.replaceChildren();
      if (listing?.parent) {
        list.append(h('button.picker-item.parent', { type: 'button', onclick: () => go(listing.parent) }, icon('arrow-up'), h('span', { text: '..' })));
      }
      if (!dirs.length) list.append(h('div.picker-empty', { text: filter ? 'No folder matches.' : 'No subfolders.' }));
      dirs.forEach((dir, i) => {
        const item = h('button.picker-item', { type: 'button', role: 'option', class: i === selected ? 'selected' : '', 'data-tip': dir.path },
          icon('folder'), h('span.picker-name', { text: dir.name }));
        item.addEventListener('click', () => go(dir.path));
        list.append(item);
      });
      if (listing?.truncated) list.append(h('div.picker-empty', { text: 'Only the first 5000 folders are shown.' }));
    }

    async function open(path) {
      openButton.disabled = true;
      status.textContent = 'Opening…';
      try {
        const workspace = await api.post('/api/workspace/open', { path });
        resolve(workspace);
      } catch (err) {
        status.textContent = err.message;
        openButton.disabled = false;
      }
    }

    filterInput.addEventListener('input', () => {
      filter = filterInput.value;
      selected = 0;
      renderList();
    });
    filterInput.addEventListener('keydown', (event) => {
      const dirs = visibleDirs();
      if (event.key === 'ArrowDown') selected = Math.min(dirs.length - 1, selected + 1);
      else if (event.key === 'ArrowUp') selected = Math.max(0, selected - 1);
      else if (event.key === 'Enter' && dirs[selected]) {
        go(dirs[selected].path);
        return;
      } else if (event.key === 'Backspace' && !filterInput.value && listing?.parent) {
        go(listing.parent);
        return;
      } else return;
      event.preventDefault();
      renderList();
      list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    });
    pathInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') go(pathInput.value.trim());
    });
    openButton.addEventListener('click', () => listing && open(listing.path));

    const card = h('main.picker-card', {},
      h('header.picker-header', {},
        icon('logo', 'picker-logo'),
        h('div', {},
          h('h1', { text: 'Open a folder' }),
          h('p', { text: 'Choose the workspace to edit. Tendril never writes its own files into it.' })),
        h('span.picker-spacer'),
        onCancel ? iconButton('close', 'Back to the editor', onCancel) : null,
        iconButton('logout', 'Log out', onLogout),
      ),
      recent,
      h('div.picker-toolbar', {}, roots, h('div.picker-path-row', {}, pathInput, h('button.btn', { type: 'button', text: 'Go', onclick: () => go(pathInput.value.trim()) }))),
      crumbs,
      h('div.picker-filter-row', {}, filterInput, hiddenToggle),
      list,
      h('footer.picker-footer', {}, status, h('span.picker-spacer'), openButton),
    );
    root.append(card);

    api.get('/api/picker/roots').then((info) => {
      const buttons = [];
      if (info.home) buttons.push(h('button.btn.small', { type: 'button', onclick: () => go(info.home) }, icon('home'), 'Home'));
      for (const r of info.roots) buttons.push(h('button.btn.small', { type: 'button', onclick: () => go(r) }, icon('drive'), r));
      roots.replaceChildren(...buttons);
      if (info.recent.length) {
        recent.replaceChildren(
          h('div.picker-section-title', { text: 'Recent' }),
          h('div.picker-recent-list', {}, info.recent.slice(0, 6).map((r) =>
            h('button.picker-recent-item', { type: 'button', 'data-tip': r.path, onclick: () => open(r.path) },
              icon('folder'), h('span.picker-recent-name', { text: r.path.split(/[\\/]/).filter(Boolean).pop() || r.path }),
              h('span.picker-recent-path', { text: r.path })))),
        );
      }
      const start = store.get('pickerLast', null) || info.home || info.roots[0];
      go(start).then((ok) => {
        if (!ok && start !== (info.home || info.roots[0])) go(info.home || info.roots[0]);
      });
    }).catch((err) => {
      status.textContent = err.message;
    });
    requestAnimationFrame(() => filterInput.focus());
  });
}
