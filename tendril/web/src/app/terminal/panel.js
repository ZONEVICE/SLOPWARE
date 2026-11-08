/**
 * The integrated terminal, in the bottom panel.
 *
 * Each terminal is an xterm.js instance connected by WebSocket to a shell
 * the server runs in a pseudo-terminal (see src/http/routes/terminal.rs for
 * the protocol). xterm.js is loaded only when the first terminal opens.
 * Closing a terminal closes its socket, which kills the shell on the server.
 * Hiding the panel keeps the terminals running.
 *
 * On touch screens a row of extra keys (Esc, Tab, Ctrl, arrows, | / ~ -)
 * makes a shell usable from a phone keyboard.
 */
import { getWorkspaceId } from '../core/api.js';
import { h, iconButton, isTouch } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { cssVar, terminalTheme } from '../core/themes.js';

const BASE = '/assets/app/xterm/';
let xterm = null;

function loadXterm() {
  if (!xterm) {
    xterm = (async () => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${BASE}xterm.css`;
      document.head.append(link);
      return import('/assets/app/xterm/xterm.js');
    })();
    xterm.catch(() => {
      xterm = null;
    });
  }
  return xterm;
}

export function createTerminals(app) {
  const panel = app.panel;
  const sessions = [];
  let active = null;
  let counter = 0;
  let creating = false;
  let ctrlPending = false;
  const encoder = new TextEncoder();

  panel.actions.append(
    iconButton('plus', 'New Terminal', () => app.commands.run('terminal.new')),
    iconButton('clear', 'Clear Terminal', () => app.commands.run('terminal.clear')),
    iconButton('trash', 'Kill Terminal', () => app.commands.run('terminal.kill')),
    iconButton('maximize', 'Maximize Panel', () => app.commands.run('terminal.maximize'), { class: 'panel-max' }),
    iconButton('close', 'Hide Panel', () => panel.hide()),
  );

  // Extra keys for touch screens.
  const keys = [
    ['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl', null], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
    ['|', '|'], ['/', '/'], ['~', '~'], ['-', '-'],
  ];
  const keybar = h('div.keybar.terminal-keybar', {}, keys.map(([label, seq]) => {
    const btn = h('button.keybar-key', { type: 'button', text: label });
    btn.addEventListener('pointerdown', (event) => event.preventDefault());
    btn.addEventListener('click', () => {
      if (!active) return;
      if (seq === null) {
        ctrlPending = !ctrlPending;
        btn.classList.toggle('on', ctrlPending);
        return;
      }
      send(active, seq);
      active.term.focus();
    });
    return btn;
  }));
  if (isTouch()) panel.el.append(keybar);

  function send(session, data) {
    if (session.ws?.readyState === WebSocket.OPEN) session.ws.send(encoder.encode(data));
  }

  function renderTabs() {
    panel.tabs.replaceChildren(...sessions.map((s, i) => {
      const tab = h('div.panel-tab', { role: 'tab', class: s === active ? 'active' : '', 'aria-selected': String(s === active) },
        icon('terminal'),
        h('span', { text: `${i + 1}: ${s.title}${s.exited ? ' (exited)' : ''}` }),
        iconButton('close', 'Kill Terminal', (event) => {
          event.stopPropagation();
          kill(s);
        }, { class: 'panel-tab-close' }));
      tab.addEventListener('click', () => activate(s));
      return tab;
    }));
  }

  function activate(session) {
    active = session;
    for (const s of sessions) s.el.hidden = s !== session;
    renderTabs();
    requestAnimationFrame(() => {
      fit(session);
      session.term.focus();
    });
  }

  function fit(session) {
    if (!session || session.el.hidden || !panel.visible) return;
    try {
      session.fit.fit();
    } catch {
      /* not visible yet */
    }
  }

  async function create(path = '') {
    if (!getWorkspaceId()) return null;
    // Showing the panel emits `panel:shown`, whose handler opens a terminal
    // when none exists: the flag stops that from re-entering create().
    creating = true;
    let mod;
    try {
      if (!panel.visible) panel.show();
      mod = await loadXterm();
    } catch (err) {
      creating = false;
      app.ui.toast.error(`Could not load the terminal: ${err.message}`);
      return null;
    }
    const el = h('div.terminal-host');
    panel.el.insertBefore(el, keybar.isConnected ? keybar : null);
    const term = new mod.Terminal({
      fontFamily: cssVar('--font-mono'),
      fontSize: app.settings.get('ui.terminal_font_size', 13),
      theme: terminalTheme(),
      cursorBlink: true,
      scrollback: 3000,
      allowTransparency: false,
    });
    const fitAddon = new mod.FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    const session = { id: ++counter, title: 'shell', el, term, fit: fitAddon, ws: null, exited: false, opened: false };
    sessions.push(session);
    creating = false;
    activate(session);
    fitAddon.fit();

    const url = new URL('/api/term', window.location.href);
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('ws', getWorkspaceId());
    url.searchParams.set('cols', String(term.cols));
    url.searchParams.set('rows', String(term.rows));
    if (path) url.searchParams.set('path', path);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    session.ws = ws;

    ws.addEventListener('open', () => {
      session.opened = true;
      ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
    });
    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data);
          if (message.t === 'hello') {
            session.title = message.shell || 'shell';
            renderTabs();
          } else if (message.t === 'notice') {
            // terminal_shell could not be started; the default shell runs.
            term.write(`\x1b[33m[${message.text}]\x1b[0m\r\n`);
            app.ui.toast.warn(`${message.text}. Check terminal_shell in Settings.`);
          } else if (message.t === 'exit') {
            session.exited = true;
            term.write(`\r\n\x1b[2m[process exited with code ${message.code}]\x1b[0m\r\n`);
            renderTabs();
          }
        } catch {
          /* ignore */
        }
        return;
      }
      term.write(new Uint8Array(event.data));
    });
    ws.addEventListener('close', () => {
      if (!session.opened) {
        app.ui.toast.error('Could not open a terminal: the limit of open terminals was reached or the shell failed to start.');
        kill(session);
        return;
      }
      if (!session.exited) {
        session.exited = true;
        term.write('\r\n\x1b[2m[connection closed]\x1b[0m\r\n');
        renderTabs();
      }
    });

    term.onData((data) => {
      if (ctrlPending && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
        ctrlPending = false;
        keybar.querySelectorAll('.on').forEach((b) => b.classList.remove('on'));
      }
      send(session, data);
    });
    term.onBinary((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(Uint8Array.from(data, (c) => c.charCodeAt(0)));
    });
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols, rows }));
    });
    term.onTitleChange((title) => {
      session.title = title.slice(0, 40) || 'shell';
      renderTabs();
    });
    new ResizeObserver(() => requestAnimationFrame(() => fit(session))).observe(el);
    return session;
  }

  function kill(session = active) {
    if (!session) return;
    try {
      session.ws?.close();
    } catch {
      /* ignore */
    }
    session.term.dispose();
    session.el.remove();
    const index = sessions.indexOf(session);
    sessions.splice(index, 1);
    if (active === session) {
      active = sessions[index] || sessions[index - 1] || null;
      if (active) activate(active);
      else {
        renderTabs();
        panel.hide();
      }
    } else renderTabs();
  }

  app.bus.on('panel:shown', () => {
    if (!sessions.length && !creating) create();
    else requestAnimationFrame(() => {
      fit(active);
      active?.term.focus();
    });
  });
  app.bus.on('panel:resized', () => requestAnimationFrame(() => fit(active)));
  app.bus.on('theme:changed', () => {
    for (const s of sessions) {
      s.term.options.theme = terminalTheme();
      s.term.options.fontFamily = cssVar('--font-mono');
    }
  });
  app.bus.on('settings:changed', (settings) => {
    for (const s of sessions) s.term.options.fontSize = settings.ui?.terminal_font_size || 13;
    requestAnimationFrame(() => fit(active));
  });

  return {
    create,
    kill: () => kill(),
    clear: () => active?.term.clear(),
    focus: () => active?.term.focus(),
    get count() {
      return sessions.length;
    },
    get active() {
      return active;
    },
  };
}
