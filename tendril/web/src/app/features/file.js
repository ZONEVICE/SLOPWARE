/**
 * File menu: new, open folder, save / save as / save all, revert, upload,
 * download, paths, closing editors, logging out and stopping the server.
 */
import { api } from '../core/api.js';
import { downloadUrl } from '../core/dom.js';
import { sessionStore } from '../core/store.js';

const activeText = (app) => app.tabs.activeDoc?.kind === 'text';

async function copyText(app, text) {
  try {
    await navigator.clipboard.writeText(text);
    app.ui.toast.info(`Copied: ${text}`);
  } catch {
    await app.ui.dialog.prompt({ title: 'Copy this text', value: text, confirmLabel: 'Close' });
  }
}

export function absolutePath(app, rel) {
  const root = app.workspace.root;
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  if (!rel) return root;
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`;
}

export function register(app) {
  const { commands, menus, toolbar } = app;
  const c = (def) => commands.register({ category: 'File', ...def });

  c({ id: 'file.newFile', title: 'New File…', icon: 'new-file', keys: 'Alt+N', run: () => app.explorer.startCreate('file') });
  c({ id: 'file.newFolder', title: 'New Folder…', icon: 'new-folder', keys: 'Alt+Shift+N', run: () => app.explorer.startCreate('dir') });
  c({
    id: 'workspace.open',
    title: 'Open Folder…',
    icon: 'folder-open',
    keys: 'Alt+O',
    run: async () => {
      if (app.documents.dirty().length) {
        const ok = await app.ui.dialog.confirm({
          title: 'Unsaved changes',
          message: 'Opening another folder closes this one. Unsaved changes will be lost.',
          confirmLabel: 'Open Another Folder',
          danger: true,
        });
        if (!ok) return;
      }
      app.leaveWorkspace();
    },
  });
  c({ id: 'file.save', title: 'Save', icon: 'save', keys: 'Mod+S', when: activeText, run: () => app.documents.save(app.tabs.activeDoc) });
  c({
    id: 'file.saveAs',
    title: 'Save As…',
    keys: 'Mod+Shift+S',
    when: activeText,
    run: async () => {
      const doc = app.tabs.activeDoc;
      const path = await app.ui.dialog.prompt({
        title: 'Save As',
        message: 'Path inside the workspace:',
        value: doc.path,
        confirmLabel: 'Save',
        validate: (v) => (!v.trim() ? 'Enter a path' : /(^|\/)\.\.(\/|$)/.test(v) ? 'Paths cannot contain ..' : null),
      });
      if (path) await app.documents.saveAs(doc, path.trim().replace(/^\/+/, ''));
    },
  });
  c({
    id: 'file.saveAll',
    title: 'Save All',
    icon: 'save-all',
    keys: 'Mod+Alt+S',
    when: () => app.documents.dirty().length > 0,
    run: async () => {
      for (const doc of app.documents.dirty()) await app.documents.save(doc);
    },
  });
  c({
    id: 'file.revert',
    title: 'Revert File',
    icon: 'refresh',
    when: activeText,
    run: async () => {
      const doc = app.tabs.activeDoc;
      if (doc.dirty) {
        const ok = await app.ui.dialog.confirm({ title: 'Revert file?', message: `Discard the changes to ${doc.name} and reload it from disk?`, confirmLabel: 'Revert', danger: true });
        if (!ok) return;
      }
      await app.documents.reload(doc);
    },
  });
  c({ id: 'file.upload', title: 'Upload Files…', icon: 'upload', run: () => app.explorer.pickAndUpload() });
  c({
    id: 'file.download',
    title: 'Download',
    icon: 'download',
    when: () => !!app.tabs.activeDoc,
    run: (_app, path = app.tabs.activeDoc?.path) => {
      if (path) downloadUrl(api.fileUrl(path, { download: true }));
    },
  });
  c({ id: 'file.copyPath', title: 'Copy Path', run: (_app, path = app.tabs.activeDoc?.path || '') => copyText(app, absolutePath(app, path)) });
  c({ id: 'file.copyRelativePath', title: 'Copy Relative Path', run: (_app, path = app.tabs.activeDoc?.path || '') => copyText(app, path) });
  c({ id: 'file.reveal', title: 'Reveal in Explorer', icon: 'files', when: () => !!app.tabs.activeDoc, run: () => app.explorer.reveal(app.tabs.activeDoc.path) });
  c({ id: 'tabs.close', title: 'Close Editor', icon: 'close', keys: 'Alt+W', when: () => !!app.tabs.active, run: () => app.tabs.close(app.tabs.active) });
  c({ id: 'tabs.closeAll', title: 'Close All Editors', when: () => app.tabs.all().length > 0, run: () => app.tabs.closeMany(app.tabs.all()) });
  // Alt+PageDown / Alt+PageUp too: the bracket keys move around on non-US layouts.
  c({ id: 'tabs.next', title: 'Next Editor', keys: ['Alt+]', 'Alt+PageDown'], run: () => app.tabs.cycle(1) });
  c({ id: 'tabs.previous', title: 'Previous Editor', keys: ['Alt+[', 'Alt+PageUp'], run: () => app.tabs.cycle(-1) });
  c({
    id: 'app.logout',
    title: 'Log Out',
    icon: 'logout',
    run: async () => {
      if (app.documents.dirty().length) {
        const ok = await app.ui.dialog.confirm({ title: 'Log out?', message: 'Unsaved changes will be lost.', confirmLabel: 'Log Out', danger: true });
        if (!ok) return;
      }
      app.leaving = true;
      try {
        await api.post('/api/auth/logout', {});
      } finally {
        sessionStore.remove('workspace');
        window.location.reload();
      }
    },
  });
  c({
    id: 'app.stop',
    title: 'Stop Tendril…',
    icon: 'power',
    danger: true,
    run: async () => {
      const dirty = app.documents.dirty().length;
      const ok = await app.ui.dialog.confirm({
        title: 'Stop Tendril?',
        message: `This ends the server process on the host. Every browser is disconnected and every terminal is closed.${dirty ? ` ${dirty} file(s) have unsaved changes that will be lost.` : ''}`,
        confirmLabel: 'Stop Tendril',
        danger: true,
      });
      if (!ok) return;
      app.leaving = true;
      await api.post('/api/system/shutdown', {});
      app.showStopped('Tendril was stopped from the Settings tab.');
    },
  });

  const add = (command, group, order) => menus.add('file', { command, group, order });
  add('file.newFile', '1_new', 1);
  add('file.newFolder', '1_new', 2);
  add('quickopen.files', '2_open', 1);
  add('workspace.open', '2_open', 2);
  add('file.save', '3_save', 1);
  add('file.saveAs', '3_save', 2);
  add('file.saveAll', '3_save', 3);
  add('file.revert', '3_save', 4);
  add('file.upload', '4_transfer', 1);
  add('file.download', '4_transfer', 2);
  add('file.copyPath', '5_path', 1);
  add('file.copyRelativePath', '5_path', 2);
  add('file.reveal', '5_path', 3);
  add('tabs.close', '6_close', 1);
  add('tabs.closeAll', '6_close', 2);
  add('app.logout', '9_exit', 1);
  add('app.stop', '9_exit', 2);

  toolbar.add({ command: 'file.newFile', group: '1', order: 1, priority: 3 });
  toolbar.add({ command: 'file.newFolder', group: '1', order: 2, priority: 4 });
  toolbar.add({ command: 'file.save', group: '1', order: 3, priority: 1 });
  toolbar.add({ command: 'file.saveAll', group: '1', order: 4, priority: 4 });
}
