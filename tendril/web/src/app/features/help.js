/** Help menu: welcome, shortcuts, about. */
import { api } from '../core/api.js';
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { renderWelcome } from '../pages/welcome.js';

export function register(app) {
  const c = (def) => app.commands.register({ category: 'Help', ...def });
  c({
    id: 'help.welcome',
    title: 'Welcome',
    icon: 'logo',
    run: () => app.tabs.openPage({ id: 'welcome', title: 'Welcome', icon: 'logo', render: (el) => renderWelcome(app, el) }),
  });
  c({
    id: 'help.about',
    title: 'About Tendril',
    icon: 'info',
    run: async () => {
      let info = {};
      try {
        info = await api.get('/api/system/info', { quiet: true });
      } catch {
        /* show what we have */
      }
      await app.ui.dialog.alert({
        title: 'About Tendril',
        body: h('div.about', {},
          icon('logo', 'about-logo'),
          h('p', {}, h('strong', { text: `Tendril ${info.version || ''}` }), ' — a lightweight web code editor served by a single binary.'),
          h('p.muted', { text: `${(info.scheme || '').toUpperCase()} on ${info.addr || '?'} · ${info.os || ''}/${info.arch || ''} · editor: ${app.editors.kind || '—'}` }),
          h('p.muted', { text: 'Built with CodeMirror 6, Monaco Editor and xterm.js (MIT licensed), served by Rust (axum, tokio, rustls, rcgen, portable-pty).' }),
          h('p.muted', { text: 'Generated with Claude Code. Licensed under the MIT licence.' }),
        ),
      });
    },
  });
  app.menus.add('help', { command: 'help.welcome', group: '1', order: 1 });
  app.menus.add('help', { command: 'quickopen.commands', group: '1', order: 2 });
  app.menus.add('help', { command: 'shortcuts.open', group: '1', order: 3 });
  app.menus.add('help', { command: 'help.about', group: '2', order: 1 });
}
