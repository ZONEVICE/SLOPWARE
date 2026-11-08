/**
 * The workbench's entry point: builds the `app` object every feature
 * receives, shows the folder picker or the workbench, and wires the global
 * keyboard handler.
 *
 * `app` holds the shared services:
 *   api, bus, commands, menus, toolbar, statusbar, settings, workspace,
 *   documents, tabs, editors, explorer, sidebar, panel, terminals,
 *   activity, ui { toast, dialog }
 *
 * Load order: settings -> workspace (picker if needed) -> layout ->
 * documents/editors/tabs -> explorer view -> features (features/index.js).
 * The default editor (CodeMirror) is loaded in the background right away so
 * the first file opens instantly.
 */
import { startActivity } from './core/activity.js';
import { api, onUnauthorized, setWorkspaceId } from './core/api.js';
import { createBus } from './core/bus.js';
import { createCommands } from './core/commands.js';
import { h } from './core/dom.js';
import { installIcons } from './core/icons.js';
import { createSettings } from './core/settings.js';
import { sessionStore } from './core/store.js';
import { followSystemTheme, currentTheme } from './core/themes.js';
import { FEATURES } from './features/index.js';
import { showPicker } from './pages/picker.js';
import { renderWelcome } from './pages/welcome.js';
import { createExplorer } from './sidebar/explorer.js';
import { dialog, dialogOpen } from './ui/dialog.js';
import { closeMenus, menuIsOpen } from './ui/menu.js';
import { createMenuBar, createMenus } from './ui/menubar.js';
import { createStatusBar } from './ui/statusbar.js';
import { createToasts } from './ui/toast.js';
import { createToolbar } from './ui/toolbar.js';
import { installTooltips } from './ui/tooltip.js';
import { createDocuments, downloadCopies } from './workbench/documents.js';
import { createGroups } from './workbench/groups.js';
import { createWorkbench } from './workbench/workbench.js';

const root = document.getElementById('app');

async function main() {
  installIcons();
  installTooltips();
  const bus = createBus();
  const app = { api, bus, ui: { toast: createToasts(), dialog }, leaving: false };
  app.settings = createSettings(bus);
  followSystemTheme(() => bus.emit('theme:changed', currentTheme()));
  onUnauthorized(() => {
    app.leaving = true;
    window.location.reload();
  });

  try {
    await app.settings.load();
  } catch (err) {
    showFatal(`Could not load the settings: ${err.message}`);
    return;
  }

  app.showStopped = (message) => showStopped(message, app.documents?.unsavedCopies() ?? []);
  app.leaveWorkspace = () => {
    app.leaving = true;
    sessionStore.remove('workspace');
    window.location.reload();
  };

  // A workspace id survives reloads of this browser tab.
  let workspace = null;
  const savedId = sessionStore.get('workspace');
  if (savedId) {
    setWorkspaceId(savedId);
    try {
      workspace = await api.get('/api/workspace', { quiet: true });
    } catch {
      setWorkspaceId(null);
      sessionStore.remove('workspace');
    }
  }
  if (!workspace) {
    workspace = await showPicker(root, {
      onLogout: async () => {
        await api.post('/api/auth/logout', {}).catch(() => {});
        window.location.reload();
      },
    });
    sessionStore.set('workspace', workspace.id);
    setWorkspaceId(workspace.id);
  }
  app.workspace = workspace;
  document.title = `${workspace.name} — Tendril`;
  startWorkbench(app);
}

function startWorkbench(app) {
  const layout = createWorkbench(app, root);
  app.sidebar = layout.sidebar;
  app.panel = layout.panel;
  app.commands = createCommands(app);
  app.menus = createMenus(app);
  createMenuBar(app, layout.menuHost);
  app.toolbar = createToolbar(app, layout.toolHost);
  app.statusbar = createStatusBar(app, root);
  app.documents = createDocuments(app);
  app.groups = createGroups(app, layout.groupsHost);
  app.editors = app.groups.editors;
  app.tabs = app.groups.tabs;
  app.explorer = createExplorer(app);
  app.activity = startActivity(app.bus);

  layout.sidebar.addView({
    id: 'explorer',
    title: 'Explorer',
    icon: 'files',
    keys: 'view.explorer',
    render: (el) => app.explorer.mount(el),
    actions: [
      { icon: 'new-file', title: 'New File', command: 'file.newFile' },
      { icon: 'new-folder', title: 'New Folder', command: 'file.newFolder' },
      { icon: 'refresh', title: 'Refresh', command: 'explorer.refresh' },
      { icon: 'collapse-all', title: 'Collapse All', command: 'explorer.collapse' },
    ],
  });
  app.commands.register({ id: 'explorer.refresh', title: 'Refresh Explorer', category: 'View', icon: 'refresh', run: () => app.explorer.refresh() });
  app.commands.register({ id: 'explorer.collapse', title: 'Collapse Folders in Explorer', category: 'View', icon: 'collapse-all', run: () => app.explorer.collapseAll() });

  for (const feature of FEATURES) {
    try {
      feature.register(app);
    } catch (err) {
      console.error('[feature] registration failed', err);
    }
  }
  app.sidebar.show('explorer', { reveal: false });

  app.groups.setEmptyRenderer((el) => renderWelcome(app, el));
  app.bus.on('theme:changed', () => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--topbar-bg').trim());
  });

  // Global shortcuts run in the capture phase, before any editor sees them.
  window.addEventListener('keydown', (event) => {
    if (dialogOpen() || document.querySelector('.quickpick')) return;
    if (menuIsOpen() && event.key === 'Escape') {
      closeMenus();
      return;
    }
    app.commands.handleKey(event);
  }, true);

  // Warm up the default editor so the first file opens instantly.
  app.editors.ensure().catch((err) => app.ui.toast.error(`The editor could not be loaded: ${err.message}`));
  window.__tendril = app; // handy for debugging from the browser console
}

/**
 * Replaces the page once the server is gone. `copies` are the unsaved files
 * (taken before the editor goes away), offered as downloads.
 */
function showStopped(message, copies = []) {
  const plural = copies.length === 1 ? '' : 's';
  document.body.replaceChildren(
    h('main.stopped-page', {},
      h('div.stopped-card', {},
        h('h1', { text: 'Tendril has stopped' }),
        h('p', { text: message }),
        copies.length ? h('p', { text: `${copies.length} unsaved file${plural} still live in this page: download them before reloading.` }) : null,
        h('p.muted', { text: 'Start it again on the host, then reload this page.' }),
        h('div.stopped-actions', {},
          copies.length ? h('button.btn.primary', { type: 'button', text: `Download ${copies.length} unsaved file${plural}`, onclick: () => downloadCopies(copies) }) : null,
          h('button.btn', { type: 'button', text: 'Reload', onclick: () => window.location.reload() })))),
  );
}

function showFatal(message) {
  root.className = 'fatal-page';
  root.replaceChildren(h('div.stopped-card', {}, h('h1', { text: 'Something went wrong' }), h('p', { text: message }),
    h('button.btn.primary', { type: 'button', text: 'Reload', onclick: () => window.location.reload() })));
}

main().catch((err) => {
  console.error(err);
  showFatal(err.message || String(err));
});
