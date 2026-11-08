/**
 * The Settings tab: an editor for ~/.tendril/settings.json, plus the
 * browser-only preferences (theme) and the process controls.
 *
 * Data-driven: SECTIONS lists every row. A row with `key` edits that dotted
 * path of settings.json and saves on change; other row types (`theme`,
 * `password`, `info`, `stop`, `logout`) render special controls. Adding a
 * setting is one row here (plus the field in src/config/settings.rs).
 */
import { api } from '../core/api.js';
import { debounce, h } from '../core/dom.js';
import { bytes, dateTime, duration } from '../core/format.js';
import { icon } from '../core/icons.js';
import { THEMES, currentTheme } from '../core/themes.js';

export const SECTIONS = [
  {
    id: 'appearance',
    title: 'Appearance',
    rows: [
      { type: 'theme', label: 'Theme', desc: 'Saved in this browser. The first time, your system decides between Dark and Light.' },
      { key: 'ui.sidebar_side', label: 'Sidebar position', type: 'select', options: [['left', 'Left'], ['right', 'Right']] },
      { key: 'ui.show_hidden_files', label: 'Show hidden files', type: 'toggle', desc: 'Names starting with a dot, and files marked hidden on Windows.' },
    ],
  },
  {
    id: 'editor',
    title: 'Editor',
    rows: [
      { key: 'default_editor', label: 'Editor engine', type: 'select', options: [['codemirror', 'CodeMirror 6'], ['monaco', 'Monaco']], desc: 'CodeMirror is light and works best on touch screens; Monaco is the VS Code engine, heavier, with IntelliSense for JavaScript, TypeScript, JSON, CSS and HTML.' },
      { key: 'editor.font_size', label: 'Font size', type: 'number', min: 6, max: 72 },
      { key: 'editor.font_family', label: 'Font family', type: 'text', placeholder: 'Theme default (monospace)' },
      { key: 'editor.tab_size', label: 'Tab size', type: 'number', min: 1, max: 16 },
      { key: 'editor.insert_spaces', label: 'Insert spaces when pressing Tab', type: 'toggle' },
      { key: 'editor.detect_indentation', label: 'Detect indentation from each file', type: 'toggle' },
      { key: 'editor.word_wrap', label: 'Word wrap', type: 'toggle' },
      { key: 'editor.minimap', label: 'Minimap', type: 'toggle' },
      { key: 'editor.line_numbers', label: 'Line numbers', type: 'toggle' },
      { key: 'editor.render_whitespace', label: 'Show whitespace', type: 'toggle' },
      { key: 'editor.highlight_active_line', label: 'Highlight the current line', type: 'toggle' },
      { key: 'editor.auto_close_brackets', label: 'Close brackets and quotes automatically', type: 'toggle' },
      { key: 'editor.cursor_blink', label: 'Blinking cursor', type: 'toggle' },
      { key: 'editor.auto_save', label: 'Auto save', type: 'select', options: [['off', 'Off'], ['delay', 'After a delay'], ['focus', 'When the editor loses focus']] },
      { key: 'editor.auto_save_delay_ms', label: 'Auto save delay (ms)', type: 'number', min: 100, max: 600000 },
      { key: 'editor.trim_trailing_whitespace', label: 'Trim trailing whitespace on save', type: 'toggle' },
      { key: 'editor.insert_final_newline', label: 'Insert a final newline on save', type: 'toggle' },
    ],
  },
  {
    id: 'terminal',
    title: 'Terminal',
    rows: [
      { key: 'ui.terminal_font_size', label: 'Font size', type: 'number', min: 6, max: 72 },
      { key: 'terminal_shell', label: 'Shell', type: 'text', placeholder: 'Default ($SHELL, PowerShell or cmd.exe)', desc: 'A program and its arguments, e.g. "pwsh -NoLogo" or "bash -l". Put a path with spaces in double quotes. A shell that cannot start falls back to the default.' },
      { key: 'max_terminals', label: 'Terminals open at once (whole server)', type: 'number', min: 0, max: 64 },
    ],
  },
  {
    id: 'files',
    title: 'Files',
    rows: [
      { key: 'ui.confirm_delete', label: 'Ask before deleting', type: 'toggle' },
      { key: 'ui.restore_tabs', label: 'Reopen the tabs of a folder', type: 'toggle' },
      { key: 'max_editor_file_mb', label: 'Largest file the editor opens (MB)', type: 'number', min: 1, max: 512 },
      { key: 'max_upload_mb', label: 'Largest upload (MB)', type: 'number', min: 1, max: 1048576 },
      { key: 'search_exclude', label: 'Folders skipped by search', type: 'list', desc: 'Folder names, one per line.' },
    ],
  },
  {
    id: 'security',
    title: 'Security and session',
    rows: [
      {
        key: 'idle_timeout_minutes',
        label: 'Stop after inactivity (minutes)',
        type: 'number',
        min: 1,
        max: 1000000000,
        desc: 'Tendril closes itself after this long without activity. It cannot be turned off; a huge value effectively disables it, at your own risk.',
      },
      { type: 'password', label: 'Password' },
      { key: 'allowed_hosts', label: 'Allowed host names', type: 'list', desc: 'One per line, optionally with :port. Empty allows any. Recommended in HTTP mode against DNS rebinding.' },
      { key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, restart: true },
      { key: 'bind', label: 'Listen address', type: 'text', restart: true, desc: '0.0.0.0 accepts LAN, VPN and Internet clients; 127.0.0.1 only this machine.' },
    ],
  },
  {
    id: 'logs',
    title: 'Logs',
    rows: [
      { key: 'log_retention_days', label: 'Keep logs for (days)', type: 'number', min: 1, max: 36500 },
      { key: 'log_max_total_mb', label: 'Maximum size of all logs (MB)', type: 'number', min: 1, max: 1048576 },
    ],
  },
  { id: 'about', title: 'About this server', rows: [{ type: 'info' }] },
  { id: 'danger', title: 'Stop or leave', rows: [{ type: 'logout' }, { type: 'stop' }] },
];

function getPath(object, path) {
  return path.split('.').reduce((o, k) => o?.[k], object);
}

/** Opens (or focuses) the Settings tab. */
export function openSettings(app, sectionId) {
  const tab = app.tabs.openPage({
    id: 'settings',
    title: 'Settings',
    icon: 'settings',
    render: (el) => renderSettings(app, el),
    onShow: (el) => el.querySelector('[data-refresh-info]')?.click(),
  });
  if (sectionId) requestAnimationFrame(() => tab.pane?.querySelector(`#settings-${sectionId}`)?.scrollIntoView({ block: 'start' }));
  return tab;
}

function renderSettings(app, el) {
  el.classList.add('settings-page');
  const nav = h('nav.settings-nav', { 'aria-label': 'Settings sections' });
  const body = h('div.settings-body');
  const saved = h('div.settings-saved', { 'aria-live': 'polite' });
  const search = h('input.input.settings-search', { type: 'search', placeholder: 'Search settings', spellcheck: 'false' });
  body.append(h('div.settings-top', {}, h('h1', { text: 'Settings' }), saved), search,
    h('p.settings-file', { text: `Stored in ${app.settings.meta.path || '~/.tendril/settings.json'}` }));

  let savedTimer = null;
  const flash = (text, error = false) => {
    saved.textContent = text;
    saved.classList.toggle('error', error);
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (saved.textContent = ''), 2500);
  };

  async function save(key, value, errorEl) {
    try {
      await app.settings.set(key, value);
      errorEl.textContent = '';
      flash('Saved');
    } catch (err) {
      errorEl.textContent = err.message;
      flash('Not saved', true);
    }
  }

  for (const section of SECTIONS) {
    nav.append(h('a.settings-nav-item', { href: `#settings-${section.id}`, text: section.title, onclick: (event) => {
      event.preventDefault();
      body.querySelector(`#settings-${section.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } }));
    const block = h('section.settings-section', { id: `settings-${section.id}` }, h('h2', { text: section.title }));
    for (const row of section.rows) block.append(renderRow(app, row, save, flash));
    body.append(block);
  }

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    body.querySelectorAll('.setting').forEach((row) => {
      row.hidden = !!q && !row.textContent.toLowerCase().includes(q);
    });
    body.querySelectorAll('.settings-section').forEach((section) => {
      section.hidden = !!q && ![...section.querySelectorAll('.setting')].some((r) => !r.hidden);
    });
  });

  el.append(nav, body);
}

function renderRow(app, row, save, flash) {
  const error = h('div.setting-error');
  const label = h('div.setting-label', {}, h('span', { text: row.label || '' }), row.restart ? h('span.badge', { text: 'applies at next start' }) : null);
  const desc = row.desc ? h('div.setting-desc', { text: row.desc }) : null;
  const wrap = (control, extraClass = '') => h('div.setting', { class: extraClass }, h('div.setting-text', {}, label, desc), h('div.setting-control', {}, control), error);

  switch (row.type) {
    case 'toggle': {
      const input = h('input', { type: 'checkbox', role: 'switch', checked: !!getPath(app.settings.all, row.key) });
      input.addEventListener('change', () => save(row.key, input.checked, error));
      return wrap(h('label.switch', {}, input, h('span.switch-track', { 'aria-hidden': 'true' })), 'setting-toggle');
    }
    case 'select': {
      const current = getPath(app.settings.all, row.key);
      const select = h('select.input', {}, row.options.map(([value, text]) => h('option', { value, text, selected: value === current })));
      select.addEventListener('change', () => save(row.key, select.value, error));
      return wrap(select);
    }
    case 'number': {
      const input = h('input.input', { type: 'number', min: row.min, max: row.max, value: getPath(app.settings.all, row.key) });
      const commit = debounce(() => {
        const value = Number(input.value);
        if (!Number.isFinite(value) || input.value === '') return;
        save(row.key, value, error);
      }, 600);
      input.addEventListener('input', commit);
      return wrap(input);
    }
    case 'text': {
      const input = h('input.input', { type: 'text', value: getPath(app.settings.all, row.key) || '', placeholder: row.placeholder || '', spellcheck: 'false' });
      const commit = debounce(() => save(row.key, input.value.trim(), error), 700);
      input.addEventListener('input', commit);
      return wrap(input);
    }
    case 'list': {
      const area = h('textarea.input', { rows: 4, spellcheck: 'false', value: (getPath(app.settings.all, row.key) || []).join('\n') });
      area.value = (getPath(app.settings.all, row.key) || []).join('\n');
      const commit = debounce(() => save(row.key, area.value.split('\n').map((s) => s.trim()).filter(Boolean), error), 800);
      area.addEventListener('input', commit);
      return wrap(area);
    }
    case 'theme':
      return wrap(themeGrid(app), 'setting-wide');
    case 'password':
      return passwordRow(app, wrap, error, flash);
    case 'info':
      return infoBlock(app);
    case 'logout':
      return wrap(h('button.btn', { type: 'button', onclick: () => app.commands.run('app.logout') }, icon('logout'), 'Log out'), '');
    case 'stop':
      return h('div.setting.danger-zone', {},
        h('div.setting-text', {}, h('div.setting-label', { text: 'Stop Tendril' }),
          h('div.setting-desc', { text: 'Ends the server process on the host: every browser is disconnected and every terminal is closed. Unsaved changes are lost.' })),
        h('div.setting-control', {}, h('button.btn.danger', { type: 'button', onclick: () => app.commands.run('app.stop') }, icon('power'), 'Stop Tendril…')));
    default:
      return h('div');
  }
}

function themeGrid(app) {
  const grid = h('div.theme-grid', { role: 'radiogroup', 'aria-label': 'Theme' });
  const render = () => {
    const active = currentTheme().id;
    grid.replaceChildren(...THEMES.map((theme) => {
      const card = h('button.theme-card', { type: 'button', role: 'radio', 'aria-checked': String(theme.id === active), class: theme.id === active ? 'active' : '' },
        h('span.theme-preview', {}, theme.swatch.map((color) => h('span', { style: { background: color } }))),
        h('span.theme-name', { text: theme.name }));
      card.addEventListener('click', () => app.commands.run('theme.set', theme.id));
      return card;
    }));
  };
  render();
  app.bus.on('theme:changed', render);
  return grid;
}

function passwordRow(app, wrap, error, flash) {
  const meta = app.settings.meta;
  const source = { cli: 'set with --password (settings cannot change it for this run)', settings: 'from settings.json', random: 'random, generated for this run' }[meta.password_source] || '';
  const input = h('input.input', { type: 'password', placeholder: 'New password', autocomplete: 'new-password', disabled: meta.password_from_cli });
  const setBtn = h('button.btn', { type: 'button', text: 'Set', disabled: meta.password_from_cli });
  const clearBtn = h('button.btn', { type: 'button', text: 'Clear', disabled: !app.settings.all.password_set });
  setBtn.addEventListener('click', async () => {
    if (input.value.length < 4) {
      error.textContent = 'Use at least 4 characters.';
      return;
    }
    try {
      await app.settings.patch({ password: input.value });
      input.value = '';
      error.textContent = '';
      clearBtn.disabled = false;
      flash('Password saved to settings.json');
    } catch (err) {
      error.textContent = err.message;
    }
  });
  clearBtn.addEventListener('click', async () => {
    await app.settings.patch({ password: null });
    clearBtn.disabled = true;
    flash('Password removed from settings.json (the current one stays valid until restart)');
  });
  const row = wrap(h('div.password-row', {}, input, setBtn, clearBtn));
  row.querySelector('.setting-text').append(h('div.setting-desc', {
    text: `Current password: ${source}. It is stored in plain text in settings.json; anyone who can read that file can log in.`,
  }));
  return row;
}

function infoBlock(app) {
  const grid = h('dl.info-grid');
  const refresh = async () => {
    try {
      const info = await api.get('/api/system/info', { quiet: true });
      const rows = [
        ['Version', info.version],
        ['Mode', info.scheme.toUpperCase()],
        ['Listening on', info.addr],
        ['Process', `PID ${info.pid} · ${info.os}/${info.arch}`],
        ['Running for', duration(info.uptime_secs)],
        ['Started', dateTime(info.started)],
        ['Memory (resident)', info.memory_bytes ? bytes(info.memory_bytes) : 'unknown'],
        ['Sessions', String(info.sessions)],
        ['Terminals', String(info.terminals)],
        ['Blocked addresses', info.blocked_ips.length ? info.blocked_ips.join(', ') : 'none'],
        ['Data folder', info.data_dir],
        ['Settings file', info.settings_file],
        ['Logs', info.logs_dir],
        ['Certificate SHA-256', info.fingerprint || '— (plain HTTP)'],
      ];
      grid.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
    } catch (err) {
      grid.replaceChildren(h('dd', { text: err.message }));
    }
  };
  refresh();
  return h('div.setting.setting-wide', {}, grid,
    h('div.setting-control', {}, h('button.btn.small', { type: 'button', 'data-refresh-info': '1', onclick: refresh }, icon('refresh'), 'Refresh')));
}
