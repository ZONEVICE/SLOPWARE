/**
 * Editor groups: the editor area split in up to two side-by-side groups
 * (like VS Code's editor groups), each with its own tab strip, content area
 * and editor (workbench/tabs.js + workbench/editorhost.js). One group is
 * active: the one last pressed, focused or opened into.
 *
 * `app.tabs` and `app.editors` are facades over the groups, so features work
 * as with a single editor: what concerns "the current file" goes to the
 * active group; what concerns a document (its text, saved state, language,
 * closing it) goes to every group that shows it.
 *
 * - The same document can be open in both groups (Split Editor): CodeMirror
 *   views replay each other's edits; Monaco editors share the model.
 * - Phones and narrow windows have no split: the commands are unavailable,
 *   and narrowing a split window merges the second group into the first.
 * - A group that loses its last tab closes, as in VS Code.
 * - Each group's tabs are remembered per workspace (`tabs:<root>`).
 *
 * Extension points: `addAction({ command, icon, title, when(tab) })` puts a
 * button at the right of every tab strip (Split Editor, Markdown preview);
 * `openPageBeside(page)` opens a page in the other group (previews).
 */
import { h, iconButton, isNarrow } from '../core/dom.js';
import { store } from '../core/store.js';
import { createEditorHost } from './editorhost.js';
import { createTabs } from './tabs.js';

export const MAX_GROUPS = 2;

const clampRatio = (value) => Math.min(0.8, Math.max(0.2, Number(value) || 0.5));

export function createGroups(app, host) {
  const groups = [];
  const actions = [];
  const drag = { tab: null, from: null };
  let active = null;
  let restoring = false;
  let closing = false;
  // Nothing is remembered until the last visit's tabs are back (restore()),
  // or the empty start would overwrite them.
  let loaded = false;
  let renderEmpty = null;
  let ratio = clampRatio(store.get('groupSplit', 0.5));
  host.style.setProperty('--group-split', String(ratio));

  // ------------------------------------------------------------ divider
  const divider = h('div.splitter.group-divider', { role: 'separator', 'aria-orientation': 'vertical', tabindex: '-1' });
  divider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    divider.classList.add('dragging');
    document.body.classList.add('resizing-x');
    const rect = host.getBoundingClientRect();
    const move = (e) => {
      ratio = clampRatio((e.clientX - rect.left) / rect.width);
      host.style.setProperty('--group-split', String(ratio));
    };
    const up = () => {
      divider.classList.remove('dragging');
      document.body.classList.remove('resizing-x');
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
      divider.removeEventListener('pointercancel', up);
      store.set('groupSplit', ratio);
      layout();
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
    divider.addEventListener('pointercancel', up);
  });
  divider.addEventListener('dblclick', () => {
    ratio = 0.5;
    host.style.setProperty('--group-split', '0.5');
    store.set('groupSplit', ratio);
    layout();
  });

  // ------------------------------------------------------------- groups
  const groupOf = (tabsApi) => groups.find((g) => g.tabs === tabsApi) || null;
  const groupOfTab = (tab) => groups.find((g) => g.tabs.all().includes(tab)) || null;
  const otherThan = (group) => groups.find((g) => g !== group) || null;
  /** The active group first: it wins when both have something to say. */
  const ordered = () => [active, ...groups.filter((g) => g !== active)].filter(Boolean);

  function layout() {
    for (const g of groups) g.editors.layout();
  }

  function renderActions(group) {
    const tab = group.tabs.active;
    group.actions.replaceChildren(
      ...actions
        .filter((a) => !a.when || a.when(tab, group))
        .map((a) => iconButton(a.icon, a.title || app.commands.get(a.command)?.title || '', () => {
          setActive(group);
          app.commands.run(a.command);
        }, { 'data-keys': app.commands.shortcut(a.command) || null })),
    );
  }

  function makeGroup() {
    const strip = h('div.tabstrip');
    const editorPane = h('div.editor-pane', { hidden: true });
    const emptyState = h('div.empty-state');
    const content = h('div.content', {}, editorPane, emptyState);
    const el = h('div.group', {}, strip, content);
    const group = { el, strip, content, editorPane, emptyState, actions: h('div.group-actions') };

    group.editors = createEditorHost(app, editorPane, {
      isActive: () => active === group,
      onFocus: () => setActive(group),
      onLocalChanges: (doc, changes) => {
        for (const g of groups) if (g !== group) g.editors.applyRemoteChanges(doc, changes);
      },
      liveText: (doc) => {
        for (const g of groups) {
          if (g === group) continue;
          const text = g.editors.liveText(doc);
          if (text !== null) return text;
        }
        return null;
      },
    });
    group.tabs = createTabs(app, {
      strip,
      content,
      editorPane,
      emptyState,
      editors: group.editors,
      drag,
      onActiveTab: (tab) => {
        renderActions(group);
        if (active === group) app.bus.emit('tab:active', tab);
      },
      openElsewhere: (doc) => groups.some((g) => g !== group && g.tabs.has(doc)),
      onEmpty: () => {
        if (groups.length > 1 && !restoring && !closing) closeGroup(group);
      },
      onPersist: persist,
      onMoveIn: (tab, fromTabs, index) => moveTab(tab, groupOf(fromTabs), group, index),
      extraMenu: (tab) => tabMenu(group, tab),
    });
    strip.append(group.actions);
    renderActions(group);
    if (renderEmpty) renderEmpty(emptyState);

    // Any press or focus inside a group makes it the active one.
    el.addEventListener('pointerdown', () => setActive(group), true);
    el.addEventListener('focusin', () => setActive(group));

    // Dropping a tab on the editor area: into this group, or (one group,
    // right half) into a new group on the right.
    const dropKind = (event) => {
      if (!drag.tab) return null;
      const from = groupOf(drag.from);
      if (from && from !== group) return 'into';
      if (groups.length < MAX_GROUPS && !isNarrow()) {
        const rect = content.getBoundingClientRect();
        if (event.clientX > rect.left + rect.width / 2) return 'split';
      }
      return null;
    };
    content.addEventListener('dragover', (event) => {
      const kind = dropKind(event);
      content.classList.toggle('group-drop', kind === 'into');
      content.classList.toggle('split-drop', kind === 'split');
      if (kind) event.preventDefault();
    });
    content.addEventListener('dragleave', (event) => {
      if (!content.contains(event.relatedTarget)) content.classList.remove('group-drop', 'split-drop');
    });
    content.addEventListener('drop', (event) => {
      const kind = dropKind(event);
      content.classList.remove('group-drop', 'split-drop');
      if (!kind) return;
      event.preventDefault();
      const from = groupOf(drag.from);
      const tab = drag.tab;
      if (kind === 'into') moveTab(tab, from, group);
      else moveTab(tab, from, addGroup());
    });
    return group;
  }

  function addGroup() {
    if (groups.length >= MAX_GROUPS) return otherThan(active) || groups[0];
    const group = makeGroup();
    groups.push(group);
    host.append(divider, group.el);
    host.classList.add('split');
    layout();
    return group;
  }

  /** Closes a group; its tabs move to the other one. */
  async function closeGroup(group) {
    if (groups.length < 2 || closing || !groups.includes(group)) return;
    closing = true;
    try {
      const target = otherThan(group);
      for (const tab of group.tabs.all()) {
        if (tab.doc) {
          if (!target.tabs.has(tab.doc)) await target.tabs.open(tab.doc.path, { focus: false });
        } else if (tab.page) {
          const page = await group.tabs.detachPage(tab);
          if (page) target.tabs.openPage(page);
        }
      }
      // Every document is open in the target now: no prompts, nothing closed.
      for (const tab of group.tabs.all()) await group.tabs.close(tab, { force: true });
      group.tabs.destroy();
      group.editors.destroy();
      group.el.remove();
      divider.remove();
      groups.splice(groups.indexOf(group), 1);
      host.classList.remove('split');
      active = null;
      setActive(target);
    } finally {
      closing = false;
    }
    persist();
    layout();
  }

  function setActive(group) {
    if (!group || active === group || !groups.includes(group)) return;
    active = group;
    for (const g of groups) g.el.classList.toggle('active', g === group);
    app.bus.emit('tab:active', group.tabs.active);
    const cursor = group.tabs.activeDoc?.kind === 'text' ? group.editors.cursor() : null;
    if (cursor) app.bus.emit('editor:cursor', cursor);
    persist();
  }

  /** Moves a tab to another group (or a new one), keeping its document. */
  async function moveTab(tab, from, to, index) {
    if (!tab || !from || !to || from === to) return;
    setActive(to);
    if (tab.doc) {
      const existing = to.tabs.find(tab.doc.path);
      if (existing) await to.tabs.activate(existing);
      else await to.tabs.open(tab.doc.path, { index, focus: true });
      await from.tabs.close(tab);
    } else if (tab.page) {
      const page = await from.tabs.detachPage(tab);
      if (page) to.tabs.openPage(page, { index });
    }
  }

  function tabMenu(group, tab) {
    if (isNarrow()) return [];
    const other = otherThan(group);
    return [
      tab.doc ? { label: other ? 'Open in Other Group' : 'Split Right', icon: 'split', run: () => openInOther(group, tab) } : null,
      { label: other ? 'Move to Other Group' : 'Move to New Group on the Right', run: () => moveTab(tab, group, other || addGroup()) },
    ].filter(Boolean);
  }

  async function openInOther(group, tab) {
    const target = otherThan(group) || addGroup();
    setActive(target);
    await target.tabs.open(tab.doc.path, { focus: true });
  }

  // ------------------------------------------------------- persistence
  function persist() {
    if (!app.workspace || restoring || !loaded) return;
    store.set(`tabs:${app.workspace.root}`, {
      groups: groups.map((g) => g.tabs.state()),
      activeGroup: Math.max(0, groups.indexOf(active)),
    });
  }

  /**
   * Reopens the tabs of the last visit (both groups, or one on phones) when
   * `reopen`, then starts remembering the tabs.
   */
  async function restore({ reopen = true } = {}) {
    const saved = reopen && app.workspace && store.get(`tabs:${app.workspace.root}`);
    if (!saved) {
      loaded = true;
      return;
    }
    // Older format: one list of paths.
    let list = saved.groups || [{ paths: saved.paths || [], active: saved.active || null }];
    if (isNarrow() && list.length > 1) {
      list = [{ paths: [...new Set(list.flatMap((g) => g.paths || []))], active: list[saved.activeGroup || 0]?.active || null }];
    }
    restoring = true;
    try {
      for (let i = 0; i < Math.min(list.length, MAX_GROUPS); i += 1) {
        const paths = (list[i].paths || []).slice(0, 20);
        if (!paths.length) continue;
        const group = i === 0 ? groups[0] : addGroup();
        active = null;
        setActive(group);
        for (const path of paths) await group.tabs.open(path, { focus: false }).catch(() => null);
        const tab = list[i].active && group.tabs.find(list[i].active);
        if (tab) await group.tabs.activate(tab, { focus: false });
      }
    } finally {
      restoring = false;
    }
    // A group whose files no longer exist stays empty: drop it.
    for (const group of [...groups]) if (groups.length > 1 && !group.tabs.all().length) await closeGroup(group);
    setActive(groups[Math.min(saved.activeGroup || 0, groups.length - 1)]);
    loaded = true;
    persist();
  }

  // Narrowing a split window merges the groups.
  window.matchMedia('(max-width: 767px)').addEventListener('change', (event) => {
    if (event.matches && groups.length > 1) closeGroup(groups[1]);
  });

  // ----------------------------------------------------------- facades
  const editors = {
    get kind() {
      return (active || groups[0]).editors.kind;
    },
    get ready() {
      return !!active?.editors.ready;
    },
    options: () => groups[0].editors.options(),
    async switchTo(kind) {
      for (const g of [...groups]) await g.editors.switchTo(kind);
    },
    ensure: () => active.editors.ensure(),
    show: (doc) => active.editors.show(doc),
    getText(doc) {
      for (const g of ordered()) {
        const text = g.editors.liveText(doc);
        if (text !== null) return text;
      }
      return doc.text;
    },
    replaceText(doc, text, opts) {
      doc.text = text;
      for (const g of groups) g.editors.replaceText(doc, text, opts);
    },
    markSaved: (doc) => groups.forEach((g) => g.editors.markSaved(doc)),
    close: (doc) => groups.forEach((g) => g.editors.close(doc)),
    exec: (command, ...args) => active.editors.exec(command, ...args),
    focus: () => active.editors.focus(),
    layout,
    cursor: () => active.editors.cursor(),
    setLanguage: (doc) => groups.forEach((g) => g.editors.setLanguage(doc)),
    setDocOptions: (doc) => groups.forEach((g) => g.editors.setDocOptions(doc)),
    applyOptions: () => groups.forEach((g) => g.editors.applyOptions()),
    applyTheme: () => groups.forEach((g) => g.editors.applyTheme()),
    supports: (command) => active.editors.supports(command),
  };

  const tabs = {
    get active() {
      return active?.tabs.active || null;
    },
    get activeDoc() {
      return active?.tabs.activeDoc || null;
    },
    all: () => groups.flatMap((g) => g.tabs.all()),
    open: (path, opts) => active.tabs.open(path, opts),
    /** Pages are single: an open one is shown where it is. */
    openPage(page) {
      for (const g of groups) {
        const tab = g.tabs.findPage(page.id);
        if (tab) {
          setActive(g);
          g.tabs.activate(tab);
          return tab;
        }
      }
      return active.tabs.openPage(page);
    },
    activate(tab, opts) {
      const g = groupOfTab(tab);
      if (!g) return Promise.resolve();
      setActive(g);
      return g.tabs.activate(tab, opts);
    },
    close(tab, opts) {
      const g = groupOfTab(tab);
      return g ? g.tabs.close(tab, opts) : Promise.resolve(true);
    },
    async closeMany(list) {
      for (const tab of list) if (!(await tabs.close(tab))) return false;
      return true;
    },
    cycle: (delta) => active.tabs.cycle(delta),
    find: (path) => active.tabs.find(path) || groups.map((g) => g.tabs.find(path)).find(Boolean) || null,
    refresh: () => groups.forEach((g) => g.tabs.refresh()),
    persist,
  };

  // The first group always exists.
  const first = makeGroup();
  groups.push(first);
  host.append(first.el);
  setActive(first);

  return {
    tabs,
    editors,
    get active() {
      return active;
    },
    get count() {
      return groups.length;
    },
    all: () => [...groups],

    /** Shows `doc`'s current editor in the other group too (creating it). */
    async split() {
      if (isNarrow()) return null;
      const from = active;
      const tab = from.tabs.active;
      if (!tab?.doc) return null;
      await openInOther(from, tab);
      return active;
    },

    /** Moves the active tab to the other group (creating it). */
    async moveActive() {
      const tab = active.tabs.active;
      if (!tab || isNarrow()) return;
      await moveTab(tab, active, otherThan(active) || addGroup());
    },

    focusOther() {
      const other = otherThan(active);
      if (!other) return;
      setActive(other);
      if (other.tabs.activeDoc?.kind === 'text') other.editors.focus();
      else other.tabs.active?.el.focus();
    },

    /** Merges the groups back into one. */
    join: () => (groups.length > 1 ? closeGroup(groups[1]) : Promise.resolve()),

    /**
     * Opens a page in the other group (a new one if needed; on phones, in
     * the current group), keeping the focus where it was.
     */
    openPageBeside(page) {
      if (isNarrow()) return tabs.openPage(page);
      for (const g of groups) {
        const tab = g.tabs.findPage(page.id);
        if (tab) {
          g.tabs.activate(tab);
          return tab;
        }
      }
      const from = active;
      const target = otherThan(from) || addGroup();
      const tab = target.tabs.openPage(page);
      setActive(from);
      if (from.tabs.activeDoc?.kind === 'text') from.editors.focus();
      return tab;
    },

    /** Adds a button to every tab strip (see the module comment). */
    addAction(action) {
      actions.push(action);
      groups.forEach(renderActions);
    },

    /** Re-evaluates the strip buttons (after something their `when` reads changed). */
    refreshActions: () => groups.forEach(renderActions),

    /** How an empty group's area is drawn (the welcome screen). */
    setEmptyRenderer(fn) {
      renderEmpty = fn;
      for (const g of groups) fn(g.emptyState);
    },

    restore,
  };
}
