#!/usr/bin/env node
/**
 * Visual check: captures Tendril's screens in every theme, at desktop
 * (1366x768) and phone (390x844) sizes, with headless Chromium. Look at the
 * PNGs (or a montage of them) after any change to styles or layout.
 *
 *   node tests/browser/shoot.mjs --url https://127.0.0.1:6060 --password secret \
 *        --workspace /path/to/folder --out /tmp/shots \
 *        [--themes dark,light] [--sizes desktop,mobile] [--screens login,editor]
 *
 * Screens: login, picker, editor (plus the drawer on phones), menu, palette,
 * terminal, search, image, video, audio, pdf, settings, monaco, split (a
 * Markdown preview beside README.md), scm and diff (the workspace must be a
 * git repository with changes). The workspace should contain src/main.rs,
 * web/app.js, README.md, assets/sunset.png, assets/clip.webm,
 * assets/tone.wav and docs/hello.pdf (missing files only give empty
 * viewers). JavaScript errors seen by the page are listed at the end.
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launchBrowser, openPage, sleep } from './cdp.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return pairs;
  }, []),
);
const URL_BASE = args.url || 'https://127.0.0.1:6060';
const PASSWORD = args.password || '';
const WORKSPACE = args.workspace || '';
const OUT = args.out || join(tmpdir(), 'tendril-shots');
const THEMES = (args.themes || 'dark,light,kirby,gorbino,oled,dos,nuclear,ambar,eyeburned').split(',');
const SIZES = { desktop: [1366, 768, false], mobile: [390, 844, true] };
const SIZE_NAMES = (args.sizes || 'desktop,mobile').split(',');
const SCREENS = (args.screens || 'login,picker,editor,terminal,image,settings').split(',');

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  const page = await openPage(browser);
  const app = 'window.__tendril';
  const shot = async (name) => {
    await sleep(350);
    const file = join(OUT, `${name}.png`);
    await page.screenshot(file);
    console.log(`  ${file}`);
  };
  const login = () =>
    page.evaluate(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(PASSWORD)} }) }).then((r) => r.status)`);

  await page.navigate(URL_BASE);
  for (const sizeName of SIZE_NAMES) {
    const [width, height, mobile] = SIZES[sizeName];
    await page.setViewport(width, height, mobile);
    for (const theme of THEMES) {
      console.log(`${sizeName} / ${theme}`);
      const prefix = `${sizeName}-${theme}`;
      const setTheme = `localStorage.setItem('tendril.theme', JSON.stringify(${JSON.stringify(theme)}))`;

      if (SCREENS.includes('login')) {
        await page.send('Network.clearBrowserCookies').catch(() => {});
        await page.navigate(URL_BASE);
        await page.evaluate(setTheme);
        await page.navigate(URL_BASE);
        await shot(`${prefix}-login`);
      }
      await page.navigate(URL_BASE);
      await page.evaluate(setTheme);
      await login();
      if (SCREENS.includes('picker')) {
        await page.evaluate('sessionStorage.clear()');
        await page.navigate(URL_BASE);
        await page.waitFor(`!!document.querySelector('.picker-item')`).catch(() => {});
        await shot(`${prefix}-picker`);
      }
      const ws = await page.evaluate(`fetch('/api/workspace/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: ${JSON.stringify(WORKSPACE)} }) }).then((r) => r.json()).then((j) => j.id)`);
      await page.evaluate(`sessionStorage.setItem('tendril.workspace', JSON.stringify(${JSON.stringify(ws)})); localStorage.removeItem('tendril.tabs:' + ${JSON.stringify(WORKSPACE)})`);
      await page.navigate(URL_BASE);
      await page.waitFor(`!!window.__tendril && !!document.querySelector('.tree-row')`);

      if (SCREENS.includes('editor')) {
        await page.evaluate(`${app}.tabs.open('src/main.rs')`);
        await page.waitFor(`!!document.querySelector('.cm-content .cm-line')`).catch(() => {});
        await page.evaluate(`${app}.tabs.open('web/app.js')`);
        await page.evaluate(`${app}.explorer.reveal('src/main.rs')`);
        await page.evaluate(`${app}.tabs.open('src/main.rs')`);
        if (mobile) await page.evaluate(`${app}.sidebar.hideDrawer()`);
        await shot(`${prefix}-editor`);
        if (mobile) {
          await page.evaluate(`${app}.sidebar.reveal()`);
          await shot(`${prefix}-drawer`);
          await page.evaluate(`${app}.sidebar.hideDrawer()`);
        }
      }
      if (SCREENS.includes('menu') && !mobile) {
        await page.evaluate(`document.querySelector('.menubar-item[data-menu="file"]').click()`);
        await shot(`${prefix}-menu`);
        await page.key('Escape');
      }
      if (SCREENS.includes('palette')) {
        await page.evaluate(`${app}.commands.run('quickopen.commands')`);
        await shot(`${prefix}-palette`);
        await page.key('Escape');
      }
      if (SCREENS.includes('terminal')) {
        await page.evaluate(`${app}.commands.run('terminal.toggle')`);
        await page.waitFor(`!!document.querySelector('.xterm-rows')`).catch(() => {});
        await sleep(800);
        await page.evaluate(`(() => { const s = ${app}.terminals.active; if (s && s.ws) s.ws.send(new TextEncoder().encode('echo hello from tendril && ls\\r')); })()`);
        await sleep(700);
        await shot(`${prefix}-terminal`);
        await page.evaluate(`${app}.terminals.kill(); ${app}.panel.hide()`);
      }
      if (SCREENS.includes('search')) {
        await page.evaluate(`${app}.commands.run('search.inFiles')`);
        await page.evaluate(`(() => { const i = document.querySelector('.search-input'); i.value = 'word'; i.dispatchEvent(new Event('input')); })()`);
        await sleep(900);
        await shot(`${prefix}-search`);
        await page.evaluate(`${app}.sidebar.show('explorer', { reveal: false })`);
      }
      for (const [screen, path] of [['image', 'assets/sunset.png'], ['video', 'assets/clip.webm'], ['audio', 'assets/tone.wav'], ['pdf', 'docs/hello.pdf']]) {
        if (!SCREENS.includes(screen)) continue;
        await page.evaluate(`${app}.tabs.open(${JSON.stringify(path)})`);
        await sleep(900);
        await shot(`${prefix}-${screen}`);
      }
      if (SCREENS.includes('split')) {
        // A Markdown file beside its preview (the workspace needs a README.md);
        // phones have no split, so there the preview opens as a tab.
        await page.evaluate(`${app}.tabs.open('README.md')`);
        await page.waitFor(`!!document.querySelector('.cm-content .cm-line')`).catch(() => {});
        await page.evaluate(`${app}.commands.run(${mobile ? "'markdown.preview'" : "'markdown.previewSide'"})`);
        await page.waitFor(`!!document.querySelector('.markdown-body')`, 15000).catch(() => {});
        await sleep(700);
        await shot(`${prefix}-split`);
        await page.evaluate(`${app}.groups.join()`);
      }
      if (SCREENS.includes('scm')) {
        // Source Control (the workspace needs to be a git repository with changes).
        await page.evaluate(`${app}.commands.run('view.scm')`);
        await page.evaluate(`${app}.git?.refresh()`);
        await sleep(900);
        await shot(`${prefix}-scm`);
        const modified = await page.evaluate(`!!document.querySelector('.scm-row.git-modified')`);
        if (modified && SCREENS.includes('diff')) {
          await page.evaluate(`document.querySelector('.scm-row.git-modified').click()`);
          if (mobile) await page.evaluate(`${app}.sidebar.hideDrawer()`);
          await page.waitFor(`!!document.querySelector('.diff-page .cm-editor')`, 15000).catch(() => {});
          await sleep(700);
          await shot(`${prefix}-diff`);
          await page.evaluate(`${app}.tabs.close(${app}.tabs.active)`);
        }
        await page.evaluate(`${app}.sidebar.show('explorer', { reveal: false })`);
        if (mobile) await page.evaluate(`${app}.sidebar.hideDrawer()`);
      }
      if (SCREENS.includes('settings')) {
        await page.evaluate(`${app}.commands.run('settings.open')`);
        await page.waitFor(`!!document.querySelector('.settings-section')`).catch(() => {});
        await shot(`${prefix}-settings`);
      }
      if (SCREENS.includes('monaco')) {
        await page.evaluate(`${app}.tabs.open('src/main.rs')`);
        await page.evaluate(`${app}.commands.run('editor.use.monaco')`);
        await page.waitFor(`!!document.querySelector('.monaco-editor .view-lines')`, 20000).catch(() => {});
        await sleep(1200);
        await shot(`${prefix}-monaco`);
        await page.evaluate(`${app}.commands.run('editor.use.codemirror')`);
        await page.waitFor(`!!document.querySelector('.cm-content')`).catch(() => {});
      }
    }
  }
  if (page.errors.length) {
    console.log('\nPage errors:');
    for (const error of [...new Set(page.errors)]) console.log(`  ${error}`);
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
