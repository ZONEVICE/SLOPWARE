/**
 * One editor group's tab strip and what its content area shows
 * (workbench/groups.js creates one per group).
 *
 * A tab is either a document (text in the group's editor, or a viewer) or a
 * page (Settings, Keyboard Shortcuts, a Markdown preview...) that opens in
 * the editor area and closes like a tab. Pages register a render function:
 *
 *   app.tabs.openPage({ id, title, icon, render(el, app), onShow?, onClose? })
 *
 * Text documents share the group's editor element; every other tab owns a
 * pane that is kept while the tab is open (so a video keeps its position).
 * Tabs show a dot instead of the close button while unsaved, can be dragged
 * to reorder or to the other group, closed with a middle click, and have a
 * context menu.
 *
 * `options` connect it to its group:
 *   strip, content, editorPane, emptyState   the group's elements
 *   editors          the group's editor host (workbench/editorhost.js)
 *   drag             { tab, from } shared by every group, for drag and drop
 *   onActiveTab(tab) the group's active tab changed (null: none left)
 *   openElsewhere(doc)  whether another group also shows `doc`
 *   onEmpty()        the last tab was closed
 *   onPersist()      the tabs changed (remembered per workspace)
 *   onMoveIn(tab, fromTabs, index)  a tab of another group was dropped here
 *   extraMenu(tab)   more context-menu items (split, move to the other group)
 */
import { h, iconButton } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { fileIcon } from '../core/languages.js';
import { dirname } from '../core/paths.js';
import { contextMenu } from '../ui/menu.js';
import { renderViewer } from '../viewers/media.js';

export function createTabs(app, options) {
  const { strip, content, editorPane, emptyState, editors, drag } = options;
  /** @type {{id:string, doc?:object, page?:object, el:HTMLElement, pane?:HTMLElement}[]} */
  const tabs = [];
  let active = null;

  const list = h('div.tabs', { role: 'tablist' });
  strip.append(list);

  function tabTitle(tab) {
    return tab.doc ? tab.doc.name : tab.page.title;
  }

  function renderTab(tab) {
    const el = tab.el;
    el.replaceChildren();
    const doc = tab.doc;
    if (doc) {
      const { icon: iconName, color } = fileIcon(doc.path);
      const glyph = icon(iconName, 'tab-icon');
      glyph.style.color = `var(${color})`;
      el.append(glyph);
    } else {
      el.append(icon(tab.page.icon || 'file', 'tab-icon'));
    }
    el.append(h('span.tab-name', { text: tabTitle(tab) }));
    // Same name twice: add the folder to tell them apart.
    if (doc && tabs.some((t) => t !== tab && t.doc && t.doc.name === doc.name)) {
      el.append(h('span.tab-hint', { text: dirname(doc.path) || '/' }));
    }
    const dirty = doc?.dirty;
    el.classList.toggle('dirty', !!dirty);
    el.classList.toggle('conflict', !!doc?.conflict);
    el.setAttribute('data-tip', doc ? doc.path + (dirty ? ' (unsaved)' : '') : tab.page.tip || tab.page.title);
    const close = iconButton('close', 'Close', (event) => {
      event.stopPropagation();
      api.close(tab);
    }, { class: 'tab-close', tabindex: '-1' });
    el.append(h('span.tab-dirty', { 'aria-label': 'Unsaved changes' }), close);
  }

  function clearDropMarks() {
    document.querySelectorAll('.tab.drop-before, .tab.drop-after, .tabs.drop-end').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-end'));
  }

  /** Puts a dragged tab at `index`: reorders here, or moves it from another group. */
  function dropAt(index) {
    const moving = drag.tab;
    const from = drag.from;
    if (!moving) return;
    if (from === api) {
      const at = tabs.indexOf(moving);
      tabs.splice(at, 1);
      tabs.splice(index > at ? index - 1 : index, 0, moving);
      list.replaceChildren(...tabs.map((t) => t.el));
      persist();
    } else {
      options.onMoveIn?.(moving, from, index);
    }
  }

  function createTabElement(tab) {
    const el = h('div.tab', { role: 'tab', tabindex: '0', draggable: 'true', 'data-id': tab.id });
    el.addEventListener('click', () => api.activate(tab));
    el.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.preventDefault();
        api.close(tab);
      }
    });
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') api.activate(tab);
    });
    el.addEventListener('contextmenu', (event) => contextMenu(event, tabMenu(tab)));
    el.addEventListener('dragstart', (event) => {
      drag.tab = tab;
      drag.from = api;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', tab.doc?.path || tab.id);
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      drag.tab = null;
      drag.from = null;
      el.classList.remove('dragging');
      clearDropMarks();
      document.querySelectorAll('.group-drop').forEach((g) => g.classList.remove('group-drop', 'split-drop'));
    });
    el.addEventListener('dragover', (event) => {
      if (!drag.tab || drag.tab === tab) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = el.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      el.classList.toggle('drop-after', after);
      el.classList.toggle('drop-before', !after);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (event) => {
      if (!drag.tab || drag.tab === tab) return;
      event.preventDefault();
      event.stopPropagation();
      const after = el.classList.contains('drop-after');
      clearDropMarks();
      dropAt(tabs.indexOf(tab) + (after ? 1 : 0));
    });
    return el;
  }

  // Dropping on the empty part of the strip puts the tab last.
  strip.addEventListener('dragover', (event) => {
    if (!drag.tab) return;
    event.preventDefault();
    list.classList.add('drop-end');
  });
  strip.addEventListener('dragleave', (event) => {
    if (!strip.contains(event.relatedTarget)) list.classList.remove('drop-end');
  });
  strip.addEventListener('drop', (event) => {
    if (!drag.tab) return;
    event.preventDefault();
    clearDropMarks();
    dropAt(tabs.length);
  });

  function tabMenu(tab) {
    const index = tabs.indexOf(tab);
    return [
      { label: 'Close', keys: app.commands.shortcut('tabs.close'), run: () => api.close(tab) },
      { label: 'Close Others', disabled: tabs.length < 2, run: () => api.closeMany(tabs.filter((t) => t !== tab)) },
      { label: 'Close to the Right', disabled: index === tabs.length - 1, run: () => api.closeMany(tabs.slice(index + 1)) },
      { label: 'Close Saved', run: () => api.closeMany(tabs.filter((t) => !t.doc?.dirty)) },
      { label: 'Close All', run: () => api.closeMany([...tabs]) },
      ...(options.extraMenu ? [{ separator: true }, ...options.extraMenu(tab)] : []),
      { separator: true },
      ...(tab.doc
        ? [
            { label: 'Copy Path', icon: 'copy', run: () => app.commands.run('file.copyPath', tab.doc.path) },
            { label: 'Copy Relative Path', run: () => app.commands.run('file.copyRelativePath', tab.doc.path) },
            { label: 'Reveal in Explorer', icon: 'files', run: () => app.explorer?.reveal(tab.doc.path) },
            { label: 'Download', icon: 'download', run: () => app.commands.run('file.download', tab.doc.path) },
          ]
        : []),
    ];
  }

  function showContent(tab) {
    for (const t of tabs) if (t.pane) t.pane.hidden = t !== tab;
    const isText = tab?.doc?.kind === 'text';
    editorPane.hidden = !isText;
    emptyState.hidden = !!tab;
  }

  function ensurePane(tab) {
    if (tab.pane) return tab.pane;
    tab.pane = h('div.view-pane', { 'data-tab': tab.id });
    content.append(tab.pane);
    if (tab.doc) renderViewer(app, tab.doc, tab.pane);
    else tab.page.render(tab.pane, app);
    return tab.pane;
  }

  function persist() {
    options.onPersist?.();
  }

  function refreshAll() {
    tabs.forEach(renderTab);
  }

  /** Adds a tab for `doc` at `index` (default: after the active tab). */
  function addDocTab(doc, index) {
    const tab = { id: doc.id, doc };
    tab.el = createTabElement(tab);
    const at = index ?? (active ? tabs.indexOf(active) + 1 : tabs.length);
    tabs.splice(Math.min(Math.max(at, 0), tabs.length), 0, tab);
    list.replaceChildren(...tabs.map((t) => t.el));
    refreshAll();
    return tab;
  }

  /** Takes a tab out of the strip (closing, or moving to another group). */
  async function remove(tab) {
    const index = tabs.indexOf(tab);
    tabs.splice(index, 1);
    tab.el.remove();
    refreshAll();
    if (active === tab) {
      active = null;
      const next = tabs[index] || tabs[index - 1];
      if (next) await api.activate(next);
      else {
        showContent(null);
        options.onActiveTab?.(null);
      }
    }
    persist();
    if (!tabs.length) options.onEmpty?.();
  }

  const api = {
    get active() {
      return active;
    },
    get activeDoc() {
      return active?.doc || null;
    },
    all: () => [...tabs],
    has: (doc) => tabs.some((t) => t.doc === doc),
    /** What to remember: the documents' paths and the active one. */
    state: () => ({ paths: tabs.filter((t) => t.doc).map((t) => t.doc.path), active: active?.doc?.path || null }),

    /** Opens a workspace file in a tab (or focuses it). */
    async open(path, { line, col, focus = true, index } = {}) {
      let tab = tabs.find((t) => t.doc?.path === path);
      if (!tab) {
        let doc;
        try {
          doc = await app.documents.open(path);
        } catch (err) {
          app.ui.toast.error(`Could not open ${path}: ${err.message}`);
          return null;
        }
        tab = tabs.find((t) => t.doc === doc) || addDocTab(doc, index);
      }
      await api.activate(tab, { focus });
      if (line && tab.doc.kind === 'text') editors.exec('goto', line, col || 1);
      return tab;
    },

    /** Opens a page (Settings...) in a tab, reusing it if open here. */
    openPage(page, { index } = {}) {
      let tab = tabs.find((t) => t.page?.id === page.id);
      if (!tab) {
        tab = { id: `page:${page.id}`, page };
        tab.el = createTabElement(tab);
        const at = index ?? tabs.length;
        tabs.splice(Math.min(Math.max(at, 0), tabs.length), 0, tab);
        list.replaceChildren(...tabs.map((t) => t.el));
        renderTab(tab);
      }
      api.activate(tab);
      return tab;
    },

    async activate(tab, { focus = true } = {}) {
      if (!tabs.includes(tab)) return;
      active = tab;
      for (const t of tabs) {
        const on = t === tab;
        t.el.classList.toggle('active', on);
        t.el.setAttribute('aria-selected', String(on));
      }
      tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (tab.doc?.kind === 'text') {
        showContent(tab);
        await editors.show(tab.doc);
        if (active === tab && focus) editors.focus();
      } else {
        ensurePane(tab);
        showContent(tab);
        tab.page?.onShow?.(tab.pane, app);
      }
      persist();
      options.onActiveTab?.(tab);
    },

    /**
     * Closes a tab, asking about unsaved changes unless the document stays
     * open in another group. Resolves false if cancelled.
     */
    async close(tab, { force = false } = {}) {
      if (!tabs.includes(tab)) return true;
      const doc = tab.doc;
      const elsewhere = !!doc && !!options.openElsewhere?.(doc);
      if (doc?.dirty && !force && !elsewhere) {
        await api.activate(tab, { focus: false });
        const choice = await app.ui.dialog.choose({
          title: 'Unsaved changes',
          message: `Save the changes to ${doc.name} before closing?`,
          choices: [
            { id: 'discard', label: "Don't Save", danger: true },
            { id: 'save', label: 'Save', primary: true },
          ],
        });
        if (choice === null) return false;
        if (choice === 'save' && !(await app.documents.save(doc))) return false;
      }
      tab.pane?.querySelectorAll('video, audio').forEach((m) => m.pause());
      tab.pane?.remove();
      tab.page?.onClose?.(app);
      if (doc) {
        editors.close(doc);
        if (!elsewhere) app.documents.close(doc);
      }
      await remove(tab);
      return true;
    },

    async closeMany(list) {
      for (const tab of list) if (!(await api.close(tab))) return false;
      return true;
    },

    /**
     * Takes a page tab out to move it to another group: its pane goes away
     * here (onClose lets it unsubscribe) and is rendered again there.
     */
    async detachPage(tab) {
      if (!tabs.includes(tab) || !tab.page) return null;
      tab.page.onClose?.(app);
      tab.pane?.remove();
      await remove(tab);
      return tab.page;
    },

    /** Activates the next (+1) or previous (-1) tab. */
    cycle(delta) {
      if (tabs.length < 2 || !active) return;
      const index = (tabs.indexOf(active) + delta + tabs.length) % tabs.length;
      api.activate(tabs[index]);
    },

    /** The tab showing `path`, if any. */
    find: (path) => tabs.find((t) => t.doc?.path === path) || null,

    /** The tab of the page `id`, if any. */
    findPage: (id) => tabs.find((t) => t.page?.id === id) || null,

    /** Re-renders a tab's viewer (after a reload). */
    rerender(doc) {
      const tab = tabs.find((t) => t.doc === doc);
      if (!tab) return;
      if (doc.kind === 'text') {
        tab.pane?.remove();
        tab.pane = null;
        if (active === tab) api.activate(tab);
      } else if (tab.pane) {
        tab.pane.replaceChildren();
        renderViewer(app, doc, tab.pane);
      }
      renderTab(tab);
    },

    refresh: refreshAll,
    persist,
  };

  const renderDoc = (doc) => {
    const tab = tabs.find((t) => t.doc === doc);
    if (tab) renderTab(tab);
  };
  const unsubscribe = [
    app.bus.on('doc:dirty', renderDoc),
    app.bus.on('doc:conflict', renderDoc),
    app.bus.on('doc:renamed', () => {
      refreshAll();
      persist();
    }),
    app.bus.on('doc:reloaded', (doc) => api.rerender(doc)),
  ];
  /** Stops listening (the group was closed). */
  api.destroy = () => unsubscribe.forEach((off) => off());

  // Wheel over the strip scrolls it sideways.
  list.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      list.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  }, { passive: false });

  return api;
}
