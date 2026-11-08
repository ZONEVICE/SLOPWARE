/**
 * Git with the host's own `git` (src/services/git.rs through /api/git/*):
 * a Source Control view (sidebar/scm.js), the branch in the status bar, git
 * colors in the Explorer, diffs (viewers/diff.js), and commands to stage,
 * discard, commit, switch and create branches, fetch, pull and push. When
 * the host has no git or the folder is not a repository, the view says so
 * and everything else stays out of the way.
 *
 * The status is fetched quietly (it never counts as activity): when the
 * workbench opens, after saves and file operations, when the window gets
 * the focus, after every git command, and every 15 seconds while the page
 * is visible. Each new status is announced as `git:status`; `git:busy`
 * tells when a command starts and ends.
 */
import { api } from '../core/api.js';
import { h, isNarrow } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { languageFor } from '../core/languages.js';
import { basename, dirname } from '../core/paths.js';
import { quickPick } from '../ui/quickpick.js';
import { describe, letterOf, renderScm } from '../sidebar/scm.js';

const POLL_EVERY = 15_000;

/** The status store: last answer, indexes for the Explorer, and command runner. */
function createGit(app) {
  let state = { available: false, repo: false, files: [] };
  let inflight = null;
  let again = false;
  let busy = null;
  const byPath = new Map(); // path -> file status
  const folders = new Map(); // folder -> 'changed' | 'conflict'
  let ignoredDirs = []; // "target/" ...

  function index() {
    byPath.clear();
    folders.clear();
    ignoredDirs = [];
    for (const f of state.files || []) {
      if (f.ignored && f.path.endsWith('/')) {
        ignoredDirs.push(f.path);
        continue;
      }
      byPath.set(f.path, f);
      if (f.ignored) continue;
      for (let dir = dirname(f.path); dir; dir = dirname(dir)) {
        if (folders.get(dir) !== 'conflict') folders.set(dir, f.conflict ? 'conflict' : 'changed');
      }
    }
  }

  async function refresh() {
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        state = await api.get('/api/git/status', { quiet: true });
      } catch (err) {
        if (err.status === 0) return; // offline: keep showing the last status
        state = { available: true, repo: false, error: err.message, files: [] };
      }
      index();
      app.bus.emit('git:status', state);
    })();
    try {
      await inflight;
    } finally {
      inflight = null;
    }
    if (again) {
      again = false;
      await refresh();
    }
  }

  const isIgnored = (path) => ignoredDirs.some((dir) => `${path}/`.startsWith(dir) || path.startsWith(dir));

  return {
    get state() {
      return state;
    },
    get busy() {
      return busy;
    },
    refresh,
    file: (path) => (path ? byPath.get(path) || null : null),
    folder: (path) => folders.get(path) || null,
    isIgnored,
    /** Changed files, without ignored ones. */
    changes: () => (state.files || []).filter((f) => !f.ignored),

    /**
     * Runs a git request (`busyText` shows while it runs), reports its error,
     * then refreshes everything that may have changed on disk.
     */
    async run(request, { busyText = 'Working…', touchesFiles = false } = {}) {
      if (busy) {
        app.ui.toast.info(`Git is busy: ${busy}`);
        return null;
      }
      busy = busyText;
      app.bus.emit('git:busy', busy);
      try {
        return (await request()) ?? true;
      } catch (err) {
        app.ui.toast.error(err.message, { timeout: 12000 });
        return null;
      } finally {
        busy = null;
        app.bus.emit('git:busy', null);
        if (touchesFiles) {
          app.bus.emit('fs:changed', {});
          app.documents.checkDisk();
        }
        await refresh();
      }
    },
  };
}

/** A diff tab (see workbench/tabs.js pages): `staged` compares HEAD with the index. */
function diffPage(app, git, path, staged) {
  let pane = null;
  let body = null;
  let free = null;
  let unsubscribe = [];
  const where = staged ? 'Index' : 'Working Tree';

  async function gitText(ref) {
    const response = await api.raw('GET', '/api/git/show', { query: { path, ref } });
    return response.headers.get('x-tendril-exists') === '0' ? '' : response.text();
  }

  async function workingText() {
    try {
      return await api.get('/api/fs/read', { query: { path } });
    } catch (err) {
      if (err.status === 404) return ''; // deleted
      throw err;
    }
  }

  async function load() {
    if (!pane) return;
    try {
      const [original, modified] = staged ? await Promise.all([gitText('HEAD'), gitText('INDEX')]) : await Promise.all([gitText('INDEX'), workingText()]);
      const { renderDiff } = await import('../viewers/diff.js');
      free?.();
      free = await renderDiff(body, { original, modified, languageId: languageFor(path).id, narrow: isNarrow() });
    } catch (err) {
      free?.();
      free = null;
      body.replaceChildren(h('p.diff-message', { text: `Cannot show the changes: ${err.message}` }));
    }
  }

  return {
    id: `diff:${staged ? 'index' : 'tree'}:${path}`,
    title: `${basename(path)} (${where})`,
    tip: `${path}: ${staged ? 'last commit ↔ staged' : 'staged ↔ working tree'}`,
    icon: 'diff',
    render(el) {
      pane = el;
      el.classList.add('diff-page');
      body = h('div.diff-body');
      el.replaceChildren(
        h('div.diff-header', {},
          h('span.diff-title', {}, icon('diff'), h('span', { text: `${path} — ${staged ? 'HEAD ↔ Index' : 'Index ↔ Working Tree'}` })),
          h('button.btn.small', { type: 'button', onclick: () => app.tabs.open(path) }, icon('file'), h('span', { text: 'Open File' })),
          h('button.btn.small', { type: 'button', onclick: load }, icon('refresh'), h('span', { text: 'Refresh' }))),
        body,
      );
      unsubscribe = [app.bus.on('doc:saved', (doc) => doc?.path === path && load())];
      load();
    },
    onClose() {
      unsubscribe.forEach((off) => off());
      free?.();
      free = null;
      pane = null;
    },
  };
}

export function register(app) {
  const git = createGit(app);
  app.git = git;
  const repo = () => git.state.repo;
  const c = (def) => app.commands.register({ category: 'Git', when: repo, ...def });

  // ------------------------------------------------------------ actions
  const post = (path, json = {}) => api.post(path, json);

  async function stage(paths) {
    if (paths.length) await git.run(() => post('/api/git/stage', { paths }), { busyText: 'Staging…' });
  }
  async function unstage(paths) {
    if (paths.length) await git.run(() => post('/api/git/unstage', { paths }), { busyText: 'Unstaging…' });
  }

  /** Discards changes: tracked files go back to the index, untracked ones are deleted. */
  async function discard(files) {
    const untracked = files.filter((f) => f.unstaged === 'U').map((f) => f.path);
    const tracked = files.filter((f) => f.unstaged && f.unstaged !== 'U').map((f) => f.path);
    if (!untracked.length && !tracked.length) return;
    const what = [
      tracked.length ? `discard the changes in ${tracked.length} file${tracked.length === 1 ? '' : 's'}` : '',
      untracked.length ? `delete ${untracked.length} untracked file${untracked.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' and ');
    const names = [...tracked, ...untracked];
    const ok = await app.ui.dialog.confirm({
      title: 'Discard changes',
      message: `This will ${what}${names.length === 1 ? ` (${names[0]})` : ''}. It cannot be undone.`,
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    await git.run(async () => {
      if (tracked.length) await post('/api/git/discard', { paths: tracked });
      if (untracked.length) {
        const result = await post('/api/fs/delete', { paths: untracked });
        for (const failure of result.errors || []) app.ui.toast.error(`Could not delete ${failure.path}: ${failure.message}`);
      }
    }, { busyText: 'Discarding…', touchesFiles: true });
  }

  /** Commits what is staged; with nothing staged, offers to stage everything first. */
  async function commit(message) {
    let text = message ?? git.messageBox?.value ?? '';
    if (!text.trim()) {
      text = await app.ui.dialog.prompt({ title: 'Commit', message: 'Commit message', placeholder: 'What changed and why' });
      if (!text?.trim()) return false;
    }
    const changes = git.changes();
    if (!changes.some((f) => f.staged)) {
      if (!changes.length) {
        app.ui.toast.info('There are no changes to commit.');
        return false;
      }
      const all = await app.ui.dialog.confirm({
        title: 'Nothing staged',
        message: `There are no staged changes. Stage all ${changes.length} changed file${changes.length === 1 ? '' : 's'} and commit them?`,
        confirmLabel: 'Stage All and Commit',
      });
      if (!all) return false;
      if (!(await git.run(() => post('/api/git/stage', { paths: changes.filter((f) => !f.conflict).map((f) => f.path) }), { busyText: 'Staging…' }))) return false;
    }
    const result = await git.run(() => post('/api/git/commit', { message: text }), { busyText: 'Committing…' });
    if (!result) return false;
    if (git.messageBox) git.messageBox.value = '';
    app.ui.toast.success(`Committed: ${result.summary || text.split('\n')[0]}`);
    return true;
  }

  function checkout() {
    quickPick({
      placeholder: 'Switch to a branch, or create one',
      items: async () => {
        const list = await api.get('/api/git/branches');
        return [
          { label: 'Create new branch…', icon: 'plus', create: true },
          ...list.local.map((branch) => ({ label: branch, icon: 'git-branch', description: branch === list.current ? 'current' : '', branch })),
          ...list.remote.map((branch) => ({ label: branch, icon: 'git-branch', description: 'remote', branch, remote: true })),
        ];
      },
      onAccept: async (item) => {
        if (item.create) return createBranch();
        if (item.branch === git.state.branch) return null;
        return git.run(() => post('/api/git/checkout', { branch: item.branch, remote: !!item.remote }), {
          busyText: `Switching to ${item.branch}…`,
          touchesFiles: true,
        });
      },
    });
  }

  async function createBranch() {
    const name = await app.ui.dialog.prompt({
      title: 'Create branch',
      message: `A new branch from ${git.state.branch || 'the current commit'}; Tendril switches to it.`,
      placeholder: 'feature/my-change',
      confirmLabel: 'Create',
      validate: (value) => (!value.trim() ? 'Enter a name' : /\s/.test(value.trim()) ? 'Branch names cannot contain spaces' : null),
    });
    if (!name?.trim()) return;
    await git.run(() => post('/api/git/branch', { name: name.trim() }), { busyText: 'Creating branch…' });
  }

  const remote = (op, busyText, touchesFiles = false) => async () => {
    const ok = await git.run(() => post(`/api/git/${op}`), { busyText, touchesFiles });
    if (ok) app.ui.toast.success(`${op[0].toUpperCase()}${op.slice(1)} done.`);
  };

  function openDiff(path, staged) {
    app.tabs.openPage(diffPage(app, git, path, staged));
  }

  /** What a click on a changed file opens. */
  function openChange(f, staged) {
    if (!staged && f.unstaged === 'U') return app.tabs.open(f.path);
    return openDiff(f.path, staged);
  }

  git.stage = stage;
  git.unstage = unstage;
  git.discard = discard;
  git.commit = commit;
  git.openChange = openChange;
  git.messageBox = null; // the Source Control view's message box, when shown

  // ----------------------------------------------------------- commands
  app.commands.register({
    id: 'view.scm',
    title: 'Source Control',
    category: 'View',
    icon: 'source-control',
    keys: 'Mod+Shift+G',
    run: () => app.sidebar.show('scm'),
  });
  c({ id: 'git.refresh', title: 'Refresh', icon: 'refresh', when: () => git.state.available, run: () => git.refresh() });
  c({ id: 'git.commit', title: 'Commit', icon: 'check', run: () => commit() });
  c({ id: 'git.stageAll', title: 'Stage All Changes', icon: 'plus', run: () => stage(git.changes().filter((f) => f.unstaged && !f.conflict).map((f) => f.path)) });
  c({ id: 'git.unstageAll', title: 'Unstage All Changes', icon: 'minus', run: () => unstage(git.changes().filter((f) => f.staged).map((f) => f.path)) });
  c({ id: 'git.discardAll', title: 'Discard All Changes…', icon: 'undo', danger: true, run: () => discard(git.changes().filter((f) => f.unstaged)) });
  c({ id: 'git.checkout', title: 'Checkout Branch…', icon: 'git-branch', run: checkout });
  c({ id: 'git.createBranch', title: 'Create Branch…', icon: 'plus', run: createBranch });
  c({ id: 'git.fetch', title: 'Fetch', icon: 'refresh', run: remote('fetch', 'Fetching…') });
  c({ id: 'git.pull', title: 'Pull', icon: 'download', run: remote('pull', 'Pulling…', true) });
  c({ id: 'git.push', title: 'Push', icon: 'upload', run: remote('push', 'Pushing…') });
  c({
    id: 'git.openChanges',
    title: 'Open Changes',
    icon: 'diff',
    when: () => repo() && !!git.file(app.tabs.activeDoc?.path),
    run: () => {
      const f = git.file(app.tabs.activeDoc.path);
      return openChange(f, !f.unstaged && !!f.staged);
    },
  });
  c({
    id: 'git.more',
    title: 'More Git Actions…',
    icon: 'more',
    run: () => quickPick({
      placeholder: 'Git',
      items: ['git.pull', 'git.push', 'git.fetch', 'git.checkout', 'git.createBranch', 'git.stageAll', 'git.unstageAll', 'git.discardAll', 'git.refresh']
        .filter((id) => app.commands.enabled(id))
        .map((id) => ({ label: app.commands.get(id).title, icon: app.commands.get(id).icon, id })),
      onAccept: (item) => app.commands.run(item.id),
    }),
  });

  app.menus.add('view', { command: 'view.scm', group: '2_views', order: 2.5 });
  const tools = ['git.commit', 'git.pull', 'git.push', 'git.fetch', 'git.checkout', 'git.createBranch', 'git.openChanges'];
  tools.forEach((command, order) => app.menus.add('tools', { command, group: '6_git', order }));

  // --------------------------------------------------- Source Control view
  app.sidebar.addView({
    id: 'scm',
    title: 'Source Control',
    icon: 'source-control',
    keys: 'view.scm',
    render: (el) => renderScm(el, app, git),
    onShow: () => git.refresh(),
    actions: [
      { icon: 'check', title: 'Commit', command: 'git.commit' },
      { icon: 'refresh', title: 'Refresh', command: 'git.refresh' },
      { icon: 'more', title: 'More Git Actions…', command: 'git.more' },
    ],
  });

  // ------------------------------------------------------ status bar
  const item = app.statusbar.add({ id: 'git', side: 'left', order: 2, tip: 'Checkout branch…', onClick: () => app.commands.run('git.checkout') });
  item.hidden = true;
  const paintItem = () => {
    const s = git.state;
    item.hidden = !s.repo;
    if (!s.repo) return;
    const name = s.branch || (s.commit ? `${s.commit.slice(0, 8)} (detached)` : 'no commits yet');
    const sync = `${s.behind ? ` ↓${s.behind}` : ''}${s.ahead ? ` ↑${s.ahead}` : ''}`;
    item.replaceChildren(icon('git-branch'), h('span', { text: `${name}${sync}${git.busy ? ' …' : ''}` }));
    item.setAttribute('data-tip', s.upstream ? `${name} ↔ ${s.upstream}. Checkout branch…` : 'Checkout branch…');
  };

  // ------------------------------------------------- Explorer colors
  app.explorer.setDecorator((path, isDir) => {
    if (!git.state.repo) return null;
    if (isDir) {
      if (git.isIgnored(path)) return { className: 'git-ignored' };
      const folder = git.folder(path);
      return folder ? { className: folder === 'conflict' ? 'git-folder-conflict' : 'git-folder-changed' } : null;
    }
    const f = git.file(path);
    if (!f) return git.isIgnored(path) ? { className: 'git-ignored' } : null;
    const [letter, className] = letterOf(f);
    return { className, badge: letter, title: describe(f) };
  });

  // ---------------------------------------------------------- updates
  app.bus.on('git:status', () => {
    paintItem();
    app.explorer.repaint();
    const count = git.changes().length;
    app.sidebar.setBadge('scm', git.state.repo && count ? (count > 999 ? '999+' : count) : null);
  });
  app.bus.on('git:busy', paintItem);
  let soon = null;
  const later = () => {
    clearTimeout(soon);
    soon = setTimeout(() => git.refresh(), 400);
  };
  app.bus.on('doc:saved', later);
  app.bus.on('fs:changed', later);
  window.addEventListener('focus', later);
  setInterval(() => {
    if (document.visibilityState === 'visible') git.refresh();
  }, POLL_EVERY);
  git.refresh();
}
