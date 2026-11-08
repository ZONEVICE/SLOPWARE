/**
 * End-to-end test of the workbench in a real headless Chromium against a
 * real Tendril binary: what a person does, through the UI, checked on disk.
 *
 *   cargo build && node --test tests/browser/
 *
 * Uses target/debug/tendril (or TENDRIL_BIN) and Chromium (or
 * TENDRIL_CHROME); skips itself when either is missing. The server runs in
 * plain HTTP on a free port with a temporary home directory, so the user's
 * ~/.tendril is never touched.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findChrome, launchBrowser, openPage, sleep } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let hasGit = false;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
  hasGit = true;
} catch {
  /* the git test is skipped */
}
const BIN = process.env.TENDRIL_BIN || join(ROOT, 'target', 'debug', process.platform === 'win32' ? 'tendril.exe' : 'tendril');
const PASSWORD = 'e2e-Secret-42';
const skip = !findChrome() ? 'no Chromium found' : !existsSync(BIN) ? `${BIN} is missing: run cargo build first` : false;

let server;
let serverLog = '';
let browser;
let page;
let base;
let home;
let workspace;

const app = 'window.__tendril';
const activeTab = `document.querySelector('.tab.active')`;
const isDirty = `${activeTab}?.classList.contains('dirty')`;
const file = (rel) => join(workspace, rel);

before(async () => {
  if (skip) return;
  home = mkdtempSync(join(tmpdir(), 'tendril-e2e-home-'));
  workspace = mkdtempSync(join(tmpdir(), 'tendril-e2e-ws-'));
  mkdirSync(join(workspace, 'src'));
  writeFileSync(join(workspace, 'src', 'main.rs'), 'fn main() {\n    println!("hi");\n}\n');
  writeFileSync(join(workspace, 'README.md'), '# e2e\n');

  server = spawn(BIN, ['http', '--password', PASSWORD, '--port', '0', '--bind', '127.0.0.1'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // If this process dies before `after` runs (timeout, Ctrl+C), the server
  // must not live on until its idle timeout.
  process.on('exit', () => server?.kill());
  server.stderr.on('data', (chunk) => {
    serverLog += chunk;
  });
  base = await new Promise((resolvePort, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}${serverLog}`)), 20000);
    server.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /Listening\s+127\.0\.0\.1:(\d+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolvePort(`http://127.0.0.1:${match[1]}/`);
      }
    });
    server.once('exit', (code) => reject(new Error(`server exited (${code}):\n${out}${serverLog}`)));
  });
  browser = await launchBrowser();
  page = await openPage(browser);
  await page.setViewport(1366, 768);
});

after(async () => {
  if (skip) return;
  await browser?.close();
  server?.kill();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

test('a wrong password is refused, the right one lets you in', { skip }, async () => {
  await page.navigate(base);
  await page.waitFor(`!!document.getElementById('password')`);
  await page.click('#password');
  await page.type('not-the-password');
  await page.key('Enter');
  await page.waitFor(`document.getElementById('message').textContent.includes('2 attempts left')`);
  await page.evaluate(`document.getElementById('password').value = ''`);
  await page.click('#password');
  await page.type(PASSWORD);
  await page.key('Enter');
  await page.waitFor(`!!document.querySelector('.picker-card')`);
});

test('the folder picker opens the workspace', { skip }, async () => {
  await page.waitFor(`!!document.querySelector('.picker-path')`);
  await page.evaluate(`(() => { const i = document.querySelector('.picker-path'); i.value = ${JSON.stringify(workspace)}; i.focus(); })()`);
  await page.key('Enter');
  await page.waitFor(`document.querySelector('.picker-open span').textContent.includes(${JSON.stringify(basename(workspace))})`);
  await page.click('.picker-open');
  await page.waitFor(`!!${app} && !!document.querySelector('.tree-row[data-path="src"]')`);
  await page.waitFor(`!!document.querySelector('.tree-row[data-path="README.md"]')`);
});

test('a new file is created, edited and saved', { skip }, async () => {
  await page.key('Alt+N');
  await page.waitFor(`!!document.querySelector('.tree-input')`);
  await page.type('hello.txt');
  await page.key('Enter');
  await page.waitFor(`${activeTab}?.querySelector('.tab-name')?.textContent === 'hello.txt'`);
  assert.ok(existsSync(file('hello.txt')));
  await page.waitFor(`!!document.querySelector('.cm-content')`);
  await page.click('.cm-content');
  await page.type('Hello from the browser\n');
  await page.waitFor(isDirty);
  await page.key('Ctrl+S');
  await page.waitFor(`!${isDirty}`);
  assert.equal(readFileSync(file('hello.txt'), 'utf8'), 'Hello from the browser\n');
});

test('the tree renames and deletes', { skip }, async () => {
  await page.click('.tree-row[data-path="hello.txt"]');
  await page.evaluate(`document.querySelector('.tree-scroll').focus()`);
  await page.key('F2');
  await page.waitFor(`!!document.querySelector('.tree-input')`);
  await page.evaluate(`document.querySelector('.tree-input').select()`);
  await page.type('renamed.txt');
  await page.key('Enter');
  await page.waitFor(`!!document.querySelector('.tree-row[data-path="renamed.txt"]')`);
  assert.ok(existsSync(file('renamed.txt')));
  assert.ok(!existsSync(file('hello.txt')));
  await page.waitFor(`[...document.querySelectorAll('.tab-name')].some((t) => t.textContent === 'renamed.txt')`);

  writeFileSync(file('trash-me.txt'), 'bye');
  await page.evaluate(`${app}.explorer.refresh()`);
  await page.waitFor(`!!document.querySelector('.tree-row[data-path="trash-me.txt"]')`);
  await page.click('.tree-row[data-path="trash-me.txt"]');
  await page.evaluate(`document.querySelector('.tree-scroll').focus()`);
  await page.key('Delete');
  await page.waitFor(`!!document.querySelector('.dialog .btn.danger')`);
  await page.click('.dialog .btn.danger');
  await page.waitFor(`!document.querySelector('.tree-row[data-path="trash-me.txt"]')`);
  assert.ok(!existsSync(file('trash-me.txt')));
});

test('clean files follow the disk; dirty ones ask before overwriting', { skip }, async () => {
  await page.evaluate(`${app}.tabs.open('renamed.txt')`);
  writeFileSync(file('renamed.txt'), 'Changed outside\n');
  await page.evaluate(`${app}.documents.checkDisk()`);
  await page.waitFor(`document.querySelector('.cm-content').textContent.includes('Changed outside')`);

  await page.click('.cm-content');
  await page.key('Ctrl+End');
  await page.type('plus the browser');
  await page.waitFor(isDirty);
  writeFileSync(file('renamed.txt'), 'Changed outside, twice\n');
  await page.key('Ctrl+S');
  await page.waitFor(`[...document.querySelectorAll('.dialog .btn')].some((b) => b.textContent === 'Overwrite')`);
  await page.evaluate(`[...document.querySelectorAll('.dialog .btn')].find((b) => b.textContent === 'Overwrite').click()`);
  await page.waitFor(`!${isDirty}`);
  assert.match(readFileSync(file('renamed.txt'), 'utf8'), /plus the browser/);
});

test('switching to Monaco and back keeps unsaved changes', { skip }, async () => {
  await page.evaluate(`${app}.tabs.open('src/main.rs')`);
  await page.click('.cm-content');
  await page.key('Ctrl+End');
  await page.type('// UNSAVED-MARK');
  await page.waitFor(isDirty);
  await page.evaluate(`${app}.commands.run('editor.use.monaco')`);
  await page.waitFor(`!!document.querySelector('.monaco-editor .view-lines')`, 30000);
  await page.waitFor(`document.querySelector('.monaco-editor .view-lines').textContent.includes('UNSAVED-MARK')`);
  assert.equal(await page.evaluate(isDirty), true);
  await page.evaluate(`${app}.commands.run('editor.use.codemirror')`);
  await page.waitFor(`document.querySelector('.cm-content')?.textContent.includes('UNSAVED-MARK')`);
  await page.key('Ctrl+S');
  await page.waitFor(`!${isDirty}`);
  assert.match(readFileSync(file('src/main.rs'), 'utf8'), /UNSAVED-MARK/);
});

test('the editor splits in two groups that show the same file', { skip }, async () => {
  const first = '.groups > .group:first-child';
  const second = '.groups > .group:last-child';
  await page.evaluate(`${app}.tabs.open('README.md')`);
  await page.waitFor(`${activeTab}?.querySelector('.tab-name')?.textContent === 'README.md'`);
  await page.evaluate(`${app}.commands.run('view.splitEditor')`);
  await page.waitFor(`document.querySelectorAll('.group').length === 2 && document.querySelectorAll('.group .cm-content').length === 2`);
  // Typed in the second group, seen in the first (CodeMirror replays edits).
  await page.click(`${second} .cm-content`);
  await page.key('Ctrl+End');
  await page.type('SPLIT-CM-42');
  await page.waitFor(`document.querySelector('${first} .cm-content').textContent.includes('SPLIT-CM-42')`);
  // Monaco: both editors show one model.
  await page.evaluate(`${app}.commands.run('editor.use.monaco')`);
  await page.waitFor(`document.querySelectorAll('.group .monaco-editor .view-lines').length === 2`, 30000);
  await page.click(`${first} .monaco-editor .view-lines`);
  await page.key('Ctrl+End');
  await page.type('SPLIT-MONACO-42');
  await page.waitFor(`document.querySelector('${second} .monaco-editor .view-lines').textContent.includes('SPLIT-MONACO-42')`);
  await page.evaluate(`${app}.commands.run('editor.use.codemirror')`);
  await page.waitFor(`document.querySelectorAll('.group .cm-content').length === 2`, 15000);
  // Saved once, from either side; closing one side keeps the edits.
  await page.key('Ctrl+S');
  await page.waitFor(`!document.querySelector('.tab.dirty')`);
  assert.match(readFileSync(file('README.md'), 'utf8'), /SPLIT-CM-42[\s\S]*SPLIT-MONACO-42|SPLIT-MONACO-42[\s\S]*SPLIT-CM-42/);
  await page.evaluate(`${app}.groups.join()`);
  await page.waitFor(`document.querySelectorAll('.group').length === 1`);
  assert.match(await page.evaluate(`document.querySelector('.cm-content').textContent`), /SPLIT-MONACO-42/);
});

test('the Markdown preview renders beside the editor, safely and live', { skip }, async () => {
  mkdirSync(file('docs'), { recursive: true });
  writeFileSync(file('docs/guide.md'), [
    '# Guide Title',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '- [x] done',
    '- [ ] todo',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    '<img src="x.png" onerror="window.__pwned = 1">',
    '<script>window.__pwned = 2</script>',
    '',
    '[evil](javascript:window.__pwned=3) [readme](../README.md)',
    '',
    '![logo](img/logo.png)',
    '',
  ].join('\n'));
  await page.evaluate(`${app}.tabs.open('docs/guide.md')`);
  await page.waitFor(`${activeTab}?.querySelector('.tab-name')?.textContent === 'guide.md'`);
  await page.evaluate(`${app}.commands.run('markdown.previewSide')`);
  const body = `document.querySelector('.groups > .group:last-child .markdown-body')`;
  await page.waitFor(`!!${body}?.querySelector('h1#guide-title')`, 15000);
  await page.waitFor(`!!${body}.querySelector('pre code .tok-keyword')`, 15000);
  const report = await page.evaluate(`(() => {
    const b = ${body};
    return {
      scripts: b.querySelectorAll('script').length,
      handlers: b.querySelectorAll('[onerror]').length,
      evilHref: [...b.querySelectorAll('a')].find((a) => a.textContent === 'evil')?.getAttribute('href') ?? null,
      cells: b.querySelectorAll('table td').length,
      checkboxes: b.querySelectorAll('input[type=checkbox][tabindex="-1"]').length,
      image: b.querySelector('img[alt=logo]')?.getAttribute('src') || '',
      pwned: window.__pwned ?? null,
      focus: document.activeElement?.closest('.group') === document.querySelector('.groups > .group:first-child'),
    };
  })()`);
  assert.deepEqual(
    { ...report, image: report.image.includes('/api/fs/raw') && report.image.includes('docs%2Fimg%2Flogo.png') },
    { scripts: 0, handlers: 0, evilHref: null, cells: 2, checkboxes: 2, image: true, pwned: null, focus: true },
  );
  // Live: typing in the editor updates the preview.
  await page.click('.groups > .group:first-child .cm-content');
  await page.key('Ctrl+End');
  await page.type('\n## Added Live\n');
  await page.waitFor(`!!${body}.querySelector('h2#added-live')`, 5000);
  // A relative link opens the workspace file.
  await page.evaluate(`[...${body}.querySelectorAll('a')].find((a) => a.textContent === 'readme').click()`);
  await page.waitFor(`[...document.querySelectorAll('.tab.active .tab-name')].some((t) => t.textContent === 'README.md')`);
  await page.evaluate(`${app}.groups.join()`);
  await page.waitFor(`document.querySelectorAll('.group').length === 1`);
  await page.evaluate(`${app}.tabs.open('docs/guide.md')`);
  await page.key('Ctrl+S');
  await page.waitFor(`!document.querySelector('.tab.dirty')`);
});

test('git: the Source Control view stages, commits and shows changes', { skip: skip || (!hasGit && 'git is not installed') }, async () => {
  const run = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
  run('init', '--quiet', '--initial-branch=main');
  run('config', 'user.name', 'Tendril E2E');
  run('config', 'user.email', 'e2e@example.invalid');
  run('config', 'commit.gpgsign', 'false');
  await page.evaluate(`${app}.commands.run('view.scm')`);
  await page.evaluate(`${app}.git.refresh()`);
  await page.waitFor(`!!document.querySelector('.scm-row[data-path="README.md"]')`, 10000);
  // The Explorer shows it too, and the status bar the branch.
  await page.waitFor(`document.querySelector('.tree-row[data-path="README.md"]')?.classList.contains('git-untracked')`);
  await page.waitFor(`document.querySelector('.status-item[data-id="git"]')?.textContent.includes('main')`);
  // Stage one file from its row, then commit it.
  await page.evaluate(`document.querySelector('.scm-row[data-path="README.md"] [aria-label="Stage"]').click()`);
  await page.waitFor(`[...document.querySelectorAll('.scm-group-title')].some((g) => g.textContent === 'Staged Changes')`);
  await page.evaluate(`(() => { const m = document.querySelector('.scm-message'); m.value = 'Add the README'; })()`);
  await page.evaluate(`document.querySelector('.scm-commit').click()`);
  await page.waitFor(`!document.querySelector('.scm-row[data-path="README.md"]')`, 10000);
  assert.match(execFileSync('git', ['log', '--oneline'], { cwd: workspace }).toString(), /Add the README/);
  // A change on disk shows as modified, and its diff opens.
  writeFileSync(file('README.md'), `${readFileSync(file('README.md'), 'utf8')}DIFF-LINE\n`);
  await page.evaluate(`${app}.git.refresh()`);
  await page.waitFor(`document.querySelector('.scm-row[data-path="README.md"]')?.classList.contains('git-modified')`);
  await page.evaluate(`document.querySelector('.scm-row[data-path="README.md"]').click()`);
  await page.waitFor(`!!document.querySelector('.diff-page .cm-mergeView') && document.querySelector('.diff-page').textContent.includes('DIFF-LINE')`, 15000);
  await page.evaluate(`${app}.tabs.close(${app}.tabs.active)`);
  await page.evaluate(`${app}.commands.run('view.explorer')`);
});

test('the terminal runs commands in the workspace', { skip }, async () => {
  await page.key('Ctrl+`');
  await page.waitFor(`!!document.querySelector('.xterm-rows')`, 15000);
  await page.waitFor(`!!${app}.terminals.active?.opened`, 15000);
  await sleep(300);
  await page.evaluate(`document.querySelector('.terminal-host:not([hidden]) .xterm-helper-textarea').focus()`);
  // `;` (not `&&`) and `$((20+22))` both work in bash and in Windows
  // PowerShell 5.1. `ls` runs first so its listing is already on screen by the
  // time the "e2e-42" sentinel (printed last) is awaited, even with
  // PowerShell's slower output.
  await page.type('ls; echo e2e-$((20+22))');
  await page.key('Enter');
  await page.waitFor(`document.querySelector('.terminal-host:not([hidden]) .xterm-rows').textContent.includes('e2e-42')`, 10000);
  const text = await page.evaluate(`document.querySelector('.terminal-host:not([hidden]) .xterm-rows').textContent`);
  assert.match(text, /renamed\.txt/);
  await page.evaluate(`${app}.commands.run('terminal.kill')`);
});

test('settings are saved to ~/.tendril/settings.json', { skip }, async () => {
  await page.key('Ctrl+,');
  await page.waitFor(`!!document.querySelector('.settings-section')`);
  await page.evaluate(`[...document.querySelectorAll('.setting')].find((r) => r.textContent.startsWith('Word wrap')).querySelector('input').click()`);
  const settingsFile = join(home, '.tendril', 'settings.json');
  let saved = null;
  for (let i = 0; i < 50 && !saved?.editor?.word_wrap; i += 1) {
    await sleep(100);
    saved = JSON.parse(readFileSync(settingsFile, 'utf8'));
  }
  assert.equal(saved.editor.word_wrap, true);
  assert.equal(saved.password ?? null, null, 'the password must not be written by the UI unless set there');
});

test('a second click on an open menu closes it', { skip }, async () => {
  const menuOpen = `!!document.querySelector('body > .menu')`;
  await page.click('.menubar-item[data-menu="file"]');
  await page.waitFor(menuOpen);
  // The press itself used to close the menu and the click reopened it.
  await page.click('.menubar-item[data-menu="file"]');
  await page.waitFor(`!${menuOpen}`);
  await sleep(200);
  assert.equal(await page.evaluate(menuOpen), false, 'the menu opened again');
});

test('logging out returns to the login page, with no page errors on the way', { skip }, async () => {
  await page.evaluate(`${app}.commands.run('app.logout')`);
  await page.waitFor(`!!document.getElementById('password')`, 10000);
  assert.deepEqual(page.errors, [], 'JavaScript errors were reported by the page');
});

// Over a minute long (the shortest idle timeout is one minute), so opt-in:
// TENDRIL_E2E_SLOW=1 node --test tests/browser/*.test.mjs
test('when the server stops for inactivity, the page says so and keeps unsaved work', { skip: skip || (!process.env.TENDRIL_E2E_SLOW && 'slow: set TENDRIL_E2E_SLOW=1'), timeout: 180_000 }, async () => {
  await page.navigate(base);
  await page.waitFor(`!!document.getElementById('password')`);
  await page.click('#password');
  await page.type(PASSWORD);
  await page.key('Enter');
  await page.waitFor(`!!document.querySelector('.picker-path')`);
  await page.evaluate(`(() => { const i = document.querySelector('.picker-path'); i.value = ${JSON.stringify(workspace)}; i.focus(); })()`);
  await page.key('Enter');
  await page.waitFor(`document.querySelector('.picker-open span').textContent.includes(${JSON.stringify(basename(workspace))})`);
  await page.click('.picker-open');
  await page.waitFor(`!!${app} && !!document.querySelector('.tree-row[data-path="README.md"]')`);
  await page.evaluate(`${app}.tabs.open('README.md')`);
  await page.waitFor(`!!document.querySelector('.cm-content')`);
  await page.click('.cm-content');
  await page.type('unsaved line\n');
  await page.waitFor(isDirty);
  await page.evaluate(`${app}.settings.set('idle_timeout_minutes', 1)`);
  // No interaction from here on: the countdown runs out, the server stops
  // on time, and the page notices.
  await page.waitFor(`document.querySelector('.status-item[data-id="idle"]')?.textContent?.includes(':')`, 70_000);
  await page.waitFor(`!!document.querySelector('.stopped-page')`, 90_000);
  const text = await page.evaluate(`document.querySelector('.stopped-page').textContent`);
  assert.match(text, /stopped itself after 1 minute without activity/);
  assert.match(text, /Download 1 unsaved file/);
  assert.deepEqual(page.errors, [], 'JavaScript errors were reported by the page');
});
