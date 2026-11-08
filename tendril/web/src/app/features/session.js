/**
 * Session behaviour:
 *
 * - reopens the workspace's tabs from the last visit (`ui.restore_tabs`);
 * - notices files changed on disk by something else (on focus, and every 30
 *   seconds while the page is visible, quietly): clean documents reload,
 *   dirty ones are flagged as in conflict;
 * - warns before leaving the page with unsaved changes;
 * - shows a banner when the server cannot be reached, offering to download
 *   the unsaved files from the browser's memory;
 * - shows the "stopped" page when the idle countdown ends and the server is
 *   gone (`server:stopped`, from core/activity.js).
 */
import { onConnectionChange } from '../core/api.js';
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { downloadCopies } from '../workbench/documents.js';

export function register(app) {
  // Restore the tabs of both editor groups (workbench/groups.js).
  app.groups.restore({ reopen: app.settings.get('ui.restore_tabs', true) });

  // External changes.
  const check = () => app.documents.checkDisk();
  window.addEventListener('focus', check);
  setInterval(() => {
    if (document.visibilityState === 'visible') check();
  }, 30_000);
  app.bus.on('doc:conflict', (doc) => {
    app.ui.toast.warn(`${doc.name} changed on disk while you have unsaved changes.`, {
      sticky: true,
      actions: [
        { label: 'Reload', run: () => app.documents.reload(doc) },
        { label: 'Keep mine', primary: true },
      ],
    });
  });

  // Leaving with unsaved changes.
  window.addEventListener('beforeunload', (event) => {
    if (!app.leaving && app.documents.dirty().length) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  // Connection loss.
  const banner = h('div.offline-banner', { role: 'alert', hidden: true },
    icon('warning'),
    h('span.offline-text', { text: 'Cannot reach the Tendril server. It may have stopped (inactivity, or stopped on the host).' }),
    h('button.btn.small', { type: 'button', text: 'Retry', onclick: () => app.activity.poll() }),
    h('button.btn.small.primary.offline-save', {
      type: 'button',
      text: 'Download unsaved files',
      onclick: () => downloadCopies(app.documents.unsavedCopies()),
    }));
  document.body.append(banner);
  let failures = 0;
  onConnectionChange((ok) => {
    failures = ok ? 0 : failures + 1;
    const offline = failures > 0;
    banner.hidden = !offline;
    banner.querySelector('.offline-save').hidden = !app.documents.dirty().length;
    document.body.classList.toggle('offline', offline);
  });

  // The idle countdown reached zero and the server no longer answers.
  app.bus.on('server:stopped', ({ timeout }) => {
    const minutes = timeout ? Math.round(timeout / 60) : 0;
    app.showStopped(
      minutes
        ? `It stopped itself after ${minutes} minute${minutes === 1 ? '' : 's'} without activity.`
        : 'It stopped itself after a period without activity.',
    );
  });
}
