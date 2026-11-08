/**
 * The Search view: "Find in Files" over the whole workspace.
 *
 * Literal text, optionally case-sensitive and whole-word, optionally limited
 * to paths containing a filter. The server walks the workspace (skipping the
 * folders in `search_exclude`, binaries and files over 1 MiB) and returns one
 * entry per matching line; clicking one opens the file at that position.
 */
import { api } from '../core/api.js';
import { debounce, h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { fileIcon } from '../core/languages.js';
import { basename, dirname } from '../core/paths.js';

export function createSearchView(app) {
  let input;
  let includeInput;
  let results;
  let summary;
  let caseBtn;
  let wordBtn;
  const state = { case: false, word: false };
  let generation = 0;

  async function run() {
    const query = input.value;
    const mine = ++generation;
    if (!query) {
      results.replaceChildren();
      summary.textContent = '';
      return;
    }
    summary.textContent = 'Searching…';
    let result;
    try {
      result = await api.post('/api/fs/grep', {
        query,
        case_sensitive: state.case,
        whole_word: state.word,
        include: includeInput.value.trim(),
      });
    } catch (err) {
      if (mine === generation) summary.textContent = err.message;
      return;
    }
    if (mine !== generation) return;
    const files = result.results.length;
    summary.textContent = result.total
      ? `${result.total} result${result.total > 1 ? 's' : ''} in ${files} file${files > 1 ? 's' : ''}${result.truncated ? ' (stopped early: too many results)' : ''}`
      : `No results in ${result.files_searched} file${result.files_searched === 1 ? '' : 's'}`;
    results.replaceChildren(...result.results.map(renderFile));
  }

  function renderFile(file) {
    const { icon: iconName, color } = fileIcon(file.path);
    const glyph = icon(iconName, 'search-file-icon');
    glyph.style.color = `var(${color})`;
    const lines = h('div.search-lines', {}, file.matches.map((m) => renderMatch(file.path, m)));
    const header = h('button.search-file', { type: 'button', 'data-tip': file.path },
      icon('chevron-down', 'search-twisty'), glyph,
      h('span.search-file-name', { text: basename(file.path) }),
      h('span.search-file-dir', { text: dirname(file.path) }),
      h('span.search-count', { text: String(file.matches.length) }));
    header.addEventListener('click', () => {
      const collapsed = lines.hidden = !lines.hidden;
      header.classList.toggle('collapsed', collapsed);
    });
    return h('div.search-group', {}, header, lines);
  }

  function renderMatch(path, match) {
    const start = match.col - match.offset;
    const chars = [...match.text];
    const before = chars.slice(0, start).join('').replace(/^\s+/, '');
    const hit = chars.slice(start, start + match.len).join('');
    const after = chars.slice(start + match.len).join('');
    const row = h('button.search-match', { type: 'button', 'data-tip': `${path}:${match.line}` },
      h('span.search-line-no', { text: String(match.line) }),
      h('span.search-preview', {}, before, h('mark', { text: hit }), after));
    row.addEventListener('click', () => app.tabs.open(path, { line: match.line, col: match.col + 1 }));
    return row;
  }

  function toggleButton(label, tip, key) {
    const btn = h('button.toggle-btn', { type: 'button', 'aria-pressed': 'false', 'data-tip': tip, text: label });
    btn.addEventListener('click', () => {
      state[key] = !state[key];
      btn.setAttribute('aria-pressed', String(state[key]));
      run();
    });
    return btn;
  }

  return {
    render(container) {
      const debounced = debounce(run, 350);
      input = h('input.input.search-input', { type: 'search', placeholder: 'Search', spellcheck: 'false', 'aria-label': 'Search text' });
      input.addEventListener('input', debounced);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') debounced.flush();
      });
      caseBtn = toggleButton('Aa', 'Match case', 'case');
      wordBtn = toggleButton('ab', 'Match whole word', 'word');
      wordBtn.classList.add('underline');
      includeInput = h('input.input.search-include', { type: 'text', placeholder: 'Files to include (path contains…)', spellcheck: 'false' });
      includeInput.addEventListener('input', debounced);
      summary = h('div.search-summary');
      results = h('div.search-results');
      container.append(
        h('div.search-form', {}, h('div.search-row', {}, input, caseBtn, wordBtn), includeInput),
        summary,
        results,
      );
    },
    focus(text) {
      if (text) input.value = text;
      input.focus();
      input.select();
      if (text) run();
    },
  };
}
