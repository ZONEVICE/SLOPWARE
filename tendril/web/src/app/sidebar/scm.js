/**
 * The Source Control view in the sidebar. features/git.js owns the data and
 * the commands; this draws them: the branch and how far it is ahead of or
 * behind its upstream, a commit message box, then the changed files in
 * groups (merge conflicts, staged, everything else), each with buttons to
 * open it, stage or unstage it and discard its changes.
 */
import { h, iconButton } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { fileIcon } from '../core/languages.js';
import { basename, dirname } from '../core/paths.js';

/** What a status letter means, for tooltips. */
const MEANING = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Untracked' };

/** The letter shown for a file and its CSS class (also used by the Explorer). */
export function letterOf(f) {
  if (f.conflict) return ['!', 'git-conflict'];
  if (f.ignored) return [null, 'git-ignored'];
  const letter = f.unstaged === 'U' ? 'U' : f.unstaged || f.staged;
  const cls = { U: 'git-untracked', A: 'git-added', D: 'git-deleted', R: 'git-renamed' }[letter] || 'git-modified';
  return [letter, cls];
}

/** A file's status in words. */
export function describe(f) {
  if (f.conflict) return 'Merge conflict';
  if (f.ignored) return 'Ignored';
  const parts = [];
  if (f.staged) parts.push(`${MEANING[f.staged] || f.staged} (staged)`);
  if (f.unstaged) parts.push(MEANING[f.unstaged] || f.unstaged);
  return parts.join(', ');
}

export function renderScm(el, app, git) {
  el.classList.add('scm');
  const branch = h('div.scm-branch');
  const message = h('textarea.input.scm-message', {
    rows: '2',
    placeholder: 'Message (Ctrl+Enter to commit)',
    spellcheck: 'true',
    'aria-label': 'Commit message',
  });
  const commit = h('button.btn.primary.scm-commit', { type: 'button', onclick: () => git.commit() }, icon('check'), h('span', { text: 'Commit' }));
  const top = h('div.scm-top', {}, branch, message, commit);
  const note = h('div.scm-note');
  const list = h('div.scm-list', { role: 'tree', 'aria-label': 'Changes' });
  el.replaceChildren(top, note, list);
  git.messageBox = message;
  message.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      git.commit();
    }
  });
  const collapsed = new Set();

  function fileRow(f, group) {
    const staged = group === 'staged';
    const [letter, cls] = letterOf(staged ? { ...f, unstaged: null } : f);
    const { icon: iconName, color } = fileIcon(f.path);
    const glyph = icon(iconName, 'scm-icon');
    glyph.style.color = `var(${color})`;
    const actions = h('span.scm-actions', {},
      iconButton('file', 'Open File', (event) => {
        event.stopPropagation();
        app.tabs.open(f.path);
      }),
      group === 'changes'
        ? iconButton('undo', f.unstaged === 'U' ? 'Delete Untracked File' : 'Discard Changes', (event) => {
            event.stopPropagation();
            git.discard([f]);
          })
        : null,
      staged
        ? iconButton('minus', 'Unstage', (event) => {
            event.stopPropagation();
            git.unstage([f.path]);
          })
        : iconButton('plus', group === 'conflicts' ? 'Mark as Resolved (Stage)' : 'Stage', (event) => {
            event.stopPropagation();
            git.stage([f.path]);
          }));
    const row = h('div.scm-row', {
      role: 'treeitem',
      tabindex: '0',
      class: cls,
      'data-path': f.path,
      'data-tip': `${f.path}${f.orig ? ` (from ${f.orig})` : ''} — ${describe(staged ? { ...f, unstaged: null } : f)}`,
      onclick: () => git.openChange(f, staged),
      onkeydown: (event) => {
        if (event.key === 'Enter') git.openChange(f, staged);
      },
    },
    glyph,
    h('span.scm-name', { text: basename(f.path) }),
    h('span.scm-dir', { text: dirname(f.path) }),
    actions,
    h('span.scm-letter', { text: letter || '' }));
    return row;
  }

  function group(id, title, files, buttons) {
    if (!files.length) return null;
    const closed = collapsed.has(id);
    const head = h('div.scm-group', {
      role: 'button',
      tabindex: '0',
      'aria-expanded': String(!closed),
      onclick: () => {
        if (collapsed.has(id)) collapsed.delete(id);
        else collapsed.add(id);
        paint();
      },
    },
    icon(closed ? 'chevron-right' : 'chevron-down', 'scm-twisty'),
    h('span.scm-group-title', { text: title }),
    h('span.scm-count', { text: String(files.length) }),
    h('span.scm-actions', {}, ...buttons.map(([iconName, label, run]) => iconButton(iconName, label, (event) => {
      event.stopPropagation();
      run();
    }))));
    return [head, ...(closed ? [] : files.map((f) => fileRow(f, id)))];
  }

  function paint() {
    const s = git.state;
    const busy = git.busy;
    top.hidden = !s.repo;
    if (!s.available) {
      note.textContent = 'Git is not installed on the host, so there is nothing to show here. Install git there and reload.';
      list.replaceChildren();
      return;
    }
    if (!s.repo) {
      note.textContent = s.error ? `Git: ${s.error}` : 'This folder is not inside a git repository.';
      list.replaceChildren();
      return;
    }
    note.textContent = s.truncated ? `Showing the first ${s.files.length} changes.` : '';
    const name = s.branch || (s.commit ? `${s.commit.slice(0, 8)} (detached)` : 'no commits yet');
    branch.replaceChildren(
      h('button.scm-branch-name', { type: 'button', 'data-tip': 'Checkout branch…', onclick: () => app.commands.run('git.checkout') },
        icon('git-branch'), h('span', { text: name })),
      h('span.scm-sync', { text: `${s.behind ? `↓${s.behind} ` : ''}${s.ahead ? `↑${s.ahead}` : ''}`.trim(), 'data-tip': s.upstream ? `Compared with ${s.upstream}` : 'No upstream branch' }),
      h('span.scm-busy', { text: busy || '' }),
      iconButton('download', 'Pull', () => app.commands.run('git.pull')),
      iconButton('upload', s.upstream ? 'Push' : 'Publish Branch', () => app.commands.run('git.push')),
    );
    const files = git.changes();
    const conflicts = files.filter((f) => f.conflict);
    const staged = files.filter((f) => f.staged && !f.conflict);
    const changes = files.filter((f) => f.unstaged && !f.conflict);
    commit.disabled = !!busy || !files.length;
    const rows = [
      group('conflicts', 'Merge Changes', conflicts, [['plus', 'Stage All', () => git.stage(conflicts.map((f) => f.path))]]),
      group('staged', 'Staged Changes', staged, [['minus', 'Unstage All', () => git.unstage(staged.map((f) => f.path))]]),
      group('changes', 'Changes', changes, [
        ['undo', 'Discard All Changes', () => git.discard(changes)],
        ['plus', 'Stage All Changes', () => git.stage(changes.map((f) => f.path))],
      ]),
    ].flat().filter(Boolean);
    list.replaceChildren(...(rows.length ? rows : [h('div.scm-empty', { text: 'No changes.' })]));
  }

  app.bus.on('git:status', paint);
  app.bus.on('git:busy', paint);
  paint();
}
