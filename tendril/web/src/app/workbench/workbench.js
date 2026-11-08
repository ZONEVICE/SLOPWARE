/**
 * The workbench layout:
 *
 *   ┌ topbar: [menu] logo  File Edit ... Help            toolbar ┐
 *   │ sidebar │ tabs                    ┆ tabs (when split)      │
 *   │ (views) │ editor / viewer / page  ┆ editor / viewer / page │
 *   │         ├──────────────────────────────────────────────────┤
 *   │         │ panel (terminal), closed by default              │
 *   └ status bar ─────────────────────────────────────────────────┘
 *
 * The editor area holds the editor groups (workbench/groups.js): one, or
 * two side by side.
 *
 * The sidebar can sit on the left or the right (`ui.sidebar_side`) and
 * holds views registered with `app.sidebar.addView(...)` (Explorer, Search).
 * On phones it becomes a drawer over the editor. Sizes are remembered per
 * browser; positions and visibility of the panel per session.
 */
import { h, iconButton, isNarrow } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { store } from '../core/store.js';
import { createSplitter } from '../ui/splitter.js';

export function createWorkbench(app, root) {
  root.className = 'workbench';
  root.replaceChildren();

  const brand = h('div.brand', { 'data-tip': 'Tendril' }, icon('logo', 'brand-logo'), h('span.brand-name', { text: 'Tendril' }));
  const menuHost = h('div.menu-host', {}, brand);
  const toolHost = h('div.tool-host');
  const topbar = h('header.topbar', {}, menuHost, h('div.topbar-spacer'), toolHost);

  const viewTabs = h('div.view-tabs', { role: 'tablist' });
  const viewActions = h('div.view-actions');
  const viewTitle = h('div.view-title');
  const sidebarHeader = h('div.sidebar-header', {}, viewTabs, viewTitle, viewActions);
  const sidebarBody = h('div.sidebar-body');
  const sidebar = h('aside.sidebar', { 'aria-label': 'Sidebar' }, sidebarHeader, sidebarBody);

  const groupsHost = h('div.groups');

  const panelTabs = h('div.panel-tabs', { role: 'tablist' });
  const panelActions = h('div.panel-actions');
  const panelHeader = h('div.panel-header', {}, h('span.panel-title', { text: 'Terminal' }), panelTabs, h('span.panel-spacer'), panelActions);
  const panelBody = h('div.panel-body');
  const panel = h('section.panel', { 'aria-label': 'Terminal panel' }, panelHeader, panelBody);

  const center = h('section.center', {}, groupsHost);
  const backdrop = h('div.drawer-backdrop', { onclick: () => sidebarApi.hideDrawer() });
  const main = h('div.main', {}, sidebar, center, backdrop);
  root.append(topbar, main);

  const sideSplitter = createSplitter({
    root,
    variable: '--sidebar-width',
    axis: 'x',
    min: 170,
    max: () => Math.max(220, window.innerWidth * 0.6),
    initial: 260,
    direction: () => (sidebarApi.side === 'right' ? -1 : 1),
    key: 'sidebarWidth',
    onResize: () => app.editors?.layout(),
  });
  const panelSplitter = createSplitter({
    root,
    variable: '--panel-height',
    axis: 'y',
    min: 90,
    max: () => Math.max(140, window.innerHeight - 160),
    initial: 260,
    direction: () => -1,
    key: 'panelHeight',
    onResize: () => app.bus.emit('panel:resized'),
  });
  sidebar.after(sideSplitter.handle);
  center.append(panelSplitter.handle, panel);

  // ------------------------------------------------------------- sidebar
  const views = new Map();
  let currentView = null;

  const sidebarApi = {
    side: 'left',
    get visible() {
      return isNarrow() ? root.classList.contains('drawer-open') : !root.classList.contains('sidebar-hidden');
    },
    get current() {
      return currentView;
    },
    addView(view) {
      const button = h('button.view-tab', {
        type: 'button',
        role: 'tab',
        'aria-label': view.title,
        'data-tip': view.title,
        'data-keys': view.keys ? app.commands.shortcut(view.keys) : null,
        onclick: () => sidebarApi.show(view.id),
      }, icon(view.icon));
      const el = h('div.view', { 'data-view': view.id, hidden: true });
      sidebarBody.append(el);
      viewTabs.append(button);
      views.set(view.id, { ...view, el, button, rendered: false });
      if (!currentView) sidebarApi.show(view.id, { reveal: false });
    },
    /** A small count on a view's tab (`null` hides it), e.g. git changes. */
    setBadge(id, text) {
      const view = views.get(id);
      if (!view) return;
      if (text === null || text === undefined || text === '') view.button.removeAttribute('data-badge');
      else view.button.setAttribute('data-badge', String(text));
    },
    /** Shows a view (and the sidebar). */
    show(id, { reveal = true } = {}) {
      const view = views.get(id);
      if (!view) return;
      if (!view.rendered) {
        view.render(view.el, app);
        view.rendered = true;
      }
      currentView = id;
      for (const v of views.values()) {
        v.el.hidden = v.id !== id;
        v.button.classList.toggle('active', v.id === id);
        v.button.setAttribute('aria-selected', String(v.id === id));
      }
      viewTitle.textContent = view.title;
      viewActions.replaceChildren(...(view.actions || []).map((a) => iconButton(a.icon, a.title, () => app.commands.run(a.command, ...(a.args || [])))));
      if (reveal) sidebarApi.reveal();
      view.onShow?.(view.el, app);
      app.bus.emit('sidebar:view', id);
    },
    reveal() {
      if (isNarrow()) root.classList.add('drawer-open');
      else root.classList.remove('sidebar-hidden');
      store.set('sidebarHidden', false);
      app.editors?.layout();
    },
    hide() {
      if (isNarrow()) root.classList.remove('drawer-open');
      else root.classList.add('sidebar-hidden');
      store.set('sidebarHidden', true);
      app.editors?.layout();
    },
    toggle() {
      if (sidebarApi.visible) sidebarApi.hide();
      else sidebarApi.reveal();
    },
    hideDrawer() {
      root.classList.remove('drawer-open');
    },
    setSide(side) {
      sidebarApi.side = side === 'right' ? 'right' : 'left';
      root.classList.toggle('sidebar-right', sidebarApi.side === 'right');
      app.editors?.layout();
    },
  };

  // --------------------------------------------------------------- panel
  const panelApi = {
    el: panelBody,
    header: panelHeader,
    tabs: panelTabs,
    actions: panelActions,
    get visible() {
      return root.classList.contains('panel-open');
    },
    show() {
      root.classList.add('panel-open');
      app.bus.emit('panel:shown');
      app.editors?.layout();
    },
    hide() {
      root.classList.remove('panel-open', 'panel-maximized');
      app.bus.emit('panel:hidden');
      app.editors?.layout();
    },
    toggle() {
      if (panelApi.visible) panelApi.hide();
      else panelApi.show();
    },
    toggleMaximize() {
      root.classList.toggle('panel-maximized');
      app.bus.emit('panel:resized');
    },
    get maximized() {
      return root.classList.contains('panel-maximized');
    },
  };

  if (store.get('sidebarHidden', false) && !isNarrow()) root.classList.add('sidebar-hidden');
  window.addEventListener('resize', () => {
    if (!isNarrow()) root.classList.remove('drawer-open');
  });

  return {
    root,
    topbar,
    menuHost,
    toolHost,
    groupsHost,
    sidebar: sidebarApi,
    panel: panelApi,
  };
}
