/**
 * The start screen: which directory should become the album?
 *
 * The path is checked while it is typed (exists, is a directory, can be
 * read), directories are suggested as completions, and the places a person
 * usually keeps photos are offered as shortcuts. With `dir` on the command
 * line this screen is skipped entirely.
 */
import { api } from '../core/api.js';
import { debounce, h, svg } from '../core/dom.js';
import { icon } from '../core/icons.js';

/** The logo's eye, drawn inline so its pupil can follow the pointer and blink. */
function eye() {
  const almond = 'M5 32C13 20.5 22.5 15.5 32 15.5S51 20.5 59 32C51 43.5 41.5 48.5 32 48.5S13 43.5 5 32Z';
  const pupil = svg(
    'g',
    { class: 'pupil-group' },
    svg('circle', { cx: 32, cy: 32, r: 14.5, fill: 'url(#start-iris)' }),
    svg('ellipse', { cx: 32, cy: 32, rx: 3.4, ry: 11.5, fill: '#140e24' }),
    svg('circle', { cx: 37, cy: 26, r: 2.7, fill: '#fff', 'fill-opacity': 0.92 }),
  );
  const el = svg(
    'svg',
    { viewBox: '0 0 64 64', class: 'eye', 'aria-hidden': 'true' },
    svg(
      'defs',
      {},
      svg('linearGradient', { id: 'start-bg', x1: 0, y1: 0, x2: 0.4, y2: 1 },
        svg('stop', { offset: 0, 'stop-color': '#2d2254' }), svg('stop', { offset: 1, 'stop-color': '#0f0b1e' })),
      svg('radialGradient', { id: 'start-iris', cx: 0.5, cy: 0.42, r: 0.62 },
        svg('stop', { offset: 0, 'stop-color': '#ffe7a1' }), svg('stop', { offset: 0.5, 'stop-color': '#f6a93b' }),
        svg('stop', { offset: 1, 'stop-color': '#b9531b' })),
      svg('clipPath', { id: 'start-lids' }, svg('path', { d: almond })),
    ),
    svg('rect', { width: 64, height: 64, rx: 15, fill: 'url(#start-bg)' }),
    svg(
      'g',
      { class: 'lid' },
      svg('path', { d: almond, fill: '#f4f0ff' }),
      svg('g', { 'clip-path': 'url(#start-lids)' }, pupil),
      svg('path', { d: almond, fill: 'none', stroke: '#140e24', 'stroke-width': 2.2, 'stroke-linejoin': 'round' }),
    ),
  );
  const follow = (event) => {
    if (!el.isConnected) {
      window.removeEventListener('pointermove', follow);
      return;
    }
    const rect = el.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, distance / 300);
    pupil.setAttribute('transform', `translate(${((dx / distance) * 6 * reach).toFixed(2)} ${((dy / distance) * 3.5 * reach).toFixed(2)})`);
  };
  window.addEventListener('pointermove', follow);
  return el;
}

/**
 * @param {{ app: object, album: object, shortcuts: object[], onOpened: (status) => void }} options
 */
export function createStartScreen({ app, album, shortcuts, onOpened }) {
  const input = h('input', {
    id: 'album-path',
    class: 'input',
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: shortcuts[1]?.path || shortcuts[0]?.path || '/home/you/Pictures',
    'aria-describedby': 'path-status',
    'aria-autocomplete': 'list',
    'aria-controls': 'path-suggestions',
  });
  const submit = h('button', { type: 'submit', class: 'btn primary' }, icon('eye', { size: 18 }), 'Open');
  const status = h('div', { id: 'path-status', class: 'path-status', role: 'status' });
  const suggestions = h('div', { id: 'path-suggestions', class: 'suggestions', role: 'listbox', hidden: true });
  let checkToken = 0;
  let suggestToken = 0;
  let selected = -1;
  let busy = false;

  const setStatus = (kind, text, spinning = false) => {
    status.className = `path-status ${kind}`;
    status.replaceChildren(
      spinning ? h('span', { class: 'spinner' }) : kind === 'ok' ? icon('check', { size: 16 }) : kind === 'bad' ? icon('alert', { size: 16 }) : null,
      h('span', { text }),
    );
  };

  const check = debounce(async () => {
    const value = input.value.trim();
    const token = ++checkToken;
    if (!value) {
      setStatus('', 'Type the absolute path of a directory, or pick a place below.');
      return;
    }
    setStatus('', 'Checking…', true);
    try {
      const result = await api.checkPath(value);
      if (token !== checkToken) return;
      if (result.ok) setStatus('ok', `Readable directory: ${result.path}`);
      else setStatus('bad', result.message);
    } catch (error) {
      if (token === checkToken) setStatus('bad', error.message);
    }
  }, 220);

  const hideSuggestions = () => {
    suggestions.hidden = true;
    selected = -1;
    input.setAttribute('aria-expanded', 'false');
  };

  const choose = (path) => {
    input.value = path.endsWith('/') || path.endsWith('\\') ? path : `${path}${path.includes('\\') && !path.includes('/') ? '\\' : '/'}`;
    hideSuggestions();
    input.focus();
    check();
    suggest();
  };

  const suggest = debounce(async () => {
    const value = input.value;
    const token = ++suggestToken;
    if (!value.trim() || (!value.startsWith('/') && !value.startsWith('~') && !/^[a-zA-Z]:[\\/]/.test(value))) {
      hideSuggestions();
      return;
    }
    try {
      const { suggestions: found } = await api.suggest(value);
      if (token !== suggestToken || document.activeElement !== input) return;
      const exact = found.length === 1 && `${found[0]}/` === value;
      if (!found.length || exact) {
        hideSuggestions();
        return;
      }
      selected = -1;
      suggestions.replaceChildren(
        ...found.map((path, index) =>
          h(
            'button',
            {
              type: 'button',
              role: 'option',
              id: `suggestion-${index}`,
              'aria-selected': 'false',
              onMousedown: (event) => event.preventDefault(),
              onClick: () => choose(path),
            },
            icon('folder', { size: 16 }),
            h('span', { text: path }),
          ),
        ),
      );
      suggestions.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    } catch {
      hideSuggestions();
    }
  }, 120);

  const highlight = (next) => {
    const options = [...suggestions.children];
    if (!options.length) return;
    selected = (next + options.length) % options.length;
    options.forEach((option, index) => option.setAttribute('aria-selected', String(index === selected)));
    options[selected].scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', options[selected].id);
  };

  input.addEventListener('input', () => {
    check();
    suggest();
  });
  input.addEventListener('blur', () => setTimeout(hideSuggestions, 120));
  input.addEventListener('keydown', (event) => {
    if (suggestions.hidden) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlight(selected + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlight(selected - 1);
    } else if ((event.key === 'Tab' && !event.shiftKey) || (event.key === 'Enter' && selected >= 0)) {
      const options = [...suggestions.children];
      const option = options[selected >= 0 ? selected : 0];
      if (option) {
        event.preventDefault();
        choose(option.textContent);
      }
    } else if (event.key === 'Escape') {
      hideSuggestions();
    }
  });

  const open = async (path) => {
    if (busy) return;
    const value = (path ?? input.value).trim();
    if (!value) {
      setStatus('bad', 'Type the absolute path of a directory first.');
      input.focus();
      return;
    }
    busy = true;
    submit.disabled = true;
    setStatus('', `Opening ${value}…`, true);
    try {
      const status = await api.open(value);
      onOpened(status);
    } catch (error) {
      if (error.code === 'album_open') {
        // Someone else opened an album a moment ago: show it.
        const state = await api.state().catch(() => null);
        if (state) onOpened(state.album);
        return;
      }
      setStatus('bad', error.message);
      input.focus();
    } finally {
      busy = false;
      submit.disabled = false;
    }
  };

  const form = h(
    'form',
    {
      class: 'open-form',
      onSubmit: (event) => {
        event.preventDefault();
        hideSuggestions();
        open();
      },
    },
    h('label', { for: 'album-path', text: 'Absolute path of a directory' }),
    h('div', { class: 'path-row' }, input, submit, suggestions),
    status,
  );

  const place = (entry, glyph) =>
    h(
      'button',
      {
        type: 'button',
        class: 'chip link',
        title: entry.path,
        onClick: () => {
          input.value = entry.path;
          check();
          open(entry.path);
        },
      },
      icon(glyph, { size: 15 }),
      h('span', { text: entry.label || entry.name || entry.path }),
    );

  const glyphFor = (label) =>
    ({ Home: 'home', Pictures: 'image', Videos: 'video', Downloads: 'download', Desktop: 'grid' })[label] || 'folder';

  const notice = album.notice
    ? h('div', { class: 'notice', role: 'alert' }, icon('alert', { size: 18 }), h('div', {}, h('div', { text: album.notice.message }), h('div', { class: 'mono muted', text: album.notice.path })))
    : null;

  const recent = (album.recent || []).length
    ? h('section', { class: 'places' }, h('h2', { text: 'Opened recently' }), h('div', { class: 'row' }, album.recent.map((entry) => place({ label: entry.path, path: entry.path }, 'clock'))))
    : null;

  const el = h(
    'div',
    { class: 'start' },
    h(
      'div',
      { class: 'start-card' },
      h(
        'div',
        { class: 'start-hero' },
        eye(),
        h('h1', { text: 'Open an album' }),
        h('p', { text: 'Lurker shows every image and video inside a directory, including all of its subfolders, in one grid.' }),
      ),
      notice,
      form,
      shortcuts.length
        ? h('section', { class: 'places' }, h('h2', { text: 'Places on this computer' }), h('div', { class: 'row' }, shortcuts.map((entry) => place(entry, glyphFor(entry.label)))))
        : null,
      recent,
      h('p', {
        class: 'start-note',
        text: 'One album per Lurker. Everyone connected sees the same album; to look at another directory at the same time, start another Lurker.',
      }),
      h(
        'div',
        { class: 'start-footer' },
        h('span', { text: `Lurker ${app.version}` }),
        h('span', { text: app.hostname }),
        h('span', { text: `${app.protocol.toUpperCase()} · port ${app.port}` }),
        app.auth ? h('span', { text: 'Password protected' }) : null,
      ),
    ),
  );

  setStatus('', 'Type the absolute path of a directory, or pick a place below.');
  requestAnimationFrame(() => input.focus());
  return el;
}
