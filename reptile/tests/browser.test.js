/**
 * The control panel end to end, in a real headless Chromium.
 *
 * Two instances; a person hosts a directory through the first one's panel
 * (path validated while typing, content tree, one item unchecked, PIN), then
 * syncs it through the second one's panel (picks it from the discovered list,
 * fails the PIN once, gets it right), watches both panels go live, changes the
 * PIN and resumes, flips the scan switch, and stops hosting.
 *
 * Skipped automatically when no Chromium/Chrome is installed, or with
 * REPTILE_SKIP_BROWSER_TESTS=1.
 */
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findBrowser, launchBrowser } from './helpers/browser.js';
import { cleanup, startInstance, tempDir, waitFor, waitForSameTrees, writeTree } from './helpers/instances.js';

const browserPath = findBrowser();

describe('control panel in a browser', { skip: !browserPath && 'no Chromium/Chrome found' }, () => {
  let browser;
  let hostInstance;
  let syncInstance;
  let hostDir;
  let syncDir;

  before(async () => {
    hostDir = await tempDir('reptile-ui-host-');
    syncDir = join(await tempDir('reptile-ui-sync-'), 'copy');
    await writeTree(hostDir, { 'readme.txt': 'hello from the host', 'photos/beach.jpg': 'jpeg bytes', 'private/diary.txt': 'dear diary' });
    // Each instance scans only the other one's port on loopback.
    hostInstance = await startInstance({ discovery: { enabled: false } });
    syncInstance = await startInstance({
      discovery: { enabled: true, hosts: ['127.0.0.1'], ports: [hostInstance.port], sweepIntervalMs: 300, refreshIntervalMs: 300, staleMs: 3000 },
    });
    browser = await launchBrowser({ width: 1280, height: 1000 });
  });

  after(async () => {
    await browser?.close();
    await cleanup();
  });

  test('status bar, hosting, syncing, PIN change, scan switch and stop', async () => {
    // --- The hosting side -----------------------------------------------------
    const hostPage = await browser.newPage(`${hostInstance.base}/`);
    await hostPage.waitFor(`document.querySelector('.choice') !== null`);
    const bar = await hostPage.text('#statusbar');
    assert.ok(bar.includes(hostInstance.app.identity.hostname), 'hostname');
    assert.ok(bar.includes(hostInstance.app.identity.uuid), 'session UUID');
    assert.ok(bar.includes(String(hostInstance.port)), 'port');
    assert.ok(bar.includes(hostInstance.app.identity.address), 'LAN address');
    assert.ok(bar.includes('HTTP'), 'protocol');

    await hostPage.click('a.choice[href="#/host"]');
    await hostPage.waitFor(`document.querySelector('#host-path') !== null`);
    await hostPage.type('#host-path', 'relative/path');
    await hostPage.waitFor(`document.querySelector('.check.error')?.textContent.includes('absolute')`);
    await hostPage.type('#host-path', hostDir);
    await hostPage.waitFor(`document.querySelector('.check.ok')?.textContent.includes('Readable directory')`);
    await hostPage.waitFor(`document.querySelectorAll('.tree-row').length >= 4`);
    assert.match(await hostPage.text('.tree-toolbar .hint'), /5 of 5 items selected/);

    // Uncheck "private": it and its content are excluded.
    await hostPage.evaluate(`[...document.querySelectorAll('.tree-row')].find((row) => row.textContent.includes('private')).querySelector('input').click()`);
    assert.match(await hostPage.text('.tree-toolbar .hint'), /3 of 5 items selected/);

    await hostPage.type('#host-name', 'Holiday');
    await hostPage.evaluate(`(() => { const pin = document.querySelector('.pin-input'); pin.value = '2468'; pin.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await hostPage.waitFor(`!document.querySelector('button[type=submit]').disabled`);
    await hostPage.click('button[type=submit]');
    await hostPage.waitFor(`document.querySelector('.pin-display')?.textContent === '2468'`, { message: 'the hosting panel' });
    assert.match(await hostPage.text('main'), /Holiday/);
    assert.match(await hostPage.text('main'), /Waiting for an instance to connect/);
    // The status bar shows the mode and the connection state on every screen.
    assert.match(await hostPage.text('.connection-chip'), /Hosting “Holiday” · waiting for a connection/);
    assert.deepEqual(hostInstance.app.hosting.status().excluded, ['private']);

    // --- The syncing side -----------------------------------------------------
    const syncPage = await browser.newPage(`${syncInstance.base}/#/sync`);
    await syncPage.waitFor(`[...document.querySelectorAll('button.instance')].some((b) => !b.disabled && b.textContent.includes('Holiday'))`, {
      message: 'the hosting instance in the discovered list',
    });
    await syncPage.evaluate(`[...document.querySelectorAll('button.instance')].find((b) => b.textContent.includes('Holiday')).click()`);
    await syncPage.waitFor(`!document.querySelector('.selected-target').hidden`);
    // Wait for the suggested path, then replace it with a temporary one.
    await syncPage.waitFor(`document.querySelector('#sync-path').value !== ''`);
    await syncPage.type('#sync-path', syncDir);
    await syncPage.waitFor(`document.querySelector('.check.ok')?.textContent.includes('will be created')`);

    const typePin = (pin) =>
      syncPage.evaluate(`(() => { const input = [...document.querySelectorAll('.pin-input')].at(-1); input.value = '${pin}'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await typePin('1111');
    await syncPage.click('button[type=submit]');
    await syncPage.waitFor(`document.querySelector('.check.error:not([hidden])')?.textContent.includes('Wrong PIN')`, { message: 'the wrong-PIN message' });
    assert.equal(syncInstance.app.modes.mode, 'idle');

    await typePin('2468');
    await syncPage.click('button[type=submit]');
    await syncPage.waitFor(`document.querySelector('.connection-line')?.textContent.includes('Live')`, { message: 'the live state', timeoutMs: 20_000 });
    await waitForSameTrees(hostDir, syncDir, { skipA: (path) => path === 'private' || path.startsWith('private/') });
    assert.equal(await readFile(join(syncDir, 'readme.txt'), 'utf8'), 'hello from the host');
    assert.ok(!(await readdir(syncDir)).includes('private'));
    await hostPage.waitFor(`document.querySelector('.connection-line')?.textContent.includes('Connected')`, { message: 'the host panel to show the peer' });
    await hostPage.waitFor(`document.querySelector('.connection-chip')?.textContent.includes('connected')`, { message: 'the host chip' });
    await syncPage.waitFor(`document.querySelector('.connection-chip')?.textContent.includes('Syncing “Holiday” · live')`, { message: 'the peer chip' });

    // --- PIN change while connected -------------------------------------------
    await hostPage.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Change PIN')).click()`);
    await hostPage.evaluate(`(() => { const input = document.querySelector('.tile .pin-input'); input.value = '1357'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await hostPage.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Save PIN').click()`);
    await hostPage.waitFor(`document.querySelector('.pin-display')?.textContent === '1357'`);

    await syncPage.waitFor(`document.querySelector('.connection-line')?.textContent.includes('waiting for the new PIN')`, { message: 'the PIN prompt' });
    assert.match(await syncPage.text('.connection-chip'), /new PIN needed/);
    await syncPage.evaluate(`(() => { const input = [...document.querySelectorAll('.pin-input')].find((i) => i.offsetParent); input.value = '1357'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await syncPage.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Resume').click()`);
    await syncPage.waitFor(`document.querySelector('.connection-line')?.textContent.includes('Live')`, { message: 'live again', timeoutMs: 20_000 });

    // --- The scan switch in the status bar ------------------------------------
    await syncPage.click('.scan-toggle');
    await syncPage.waitFor(`document.querySelector('.scan-toggle').getAttribute('aria-pressed') === 'false'`);
    assert.equal(syncInstance.app.discovery.status().enabled, false);
    await syncPage.click('.scan-toggle');
    await syncPage.waitFor(`document.querySelector('.scan-toggle').getAttribute('aria-pressed') === 'true'`);

    // --- Stop hosting: the other side is told -----------------------------------
    await hostPage.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Stop hosting').click()`);
    await hostPage.waitFor(`document.querySelector('dialog.confirm') !== null`);
    await hostPage.evaluate(`document.querySelector('dialog.confirm .btn.danger').click()`);
    await hostPage.waitFor(`document.querySelector('.choice') !== null`, { message: 'the host back on the start screen' });
    await syncPage.waitFor(`document.querySelector('.notice')?.textContent.includes('stopped hosting')`, { message: 'the notice on the peer' });
    await syncPage.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Back to start').click()`);
    await syncPage.waitFor(`document.querySelector('.choice') !== null`);
    await waitFor(() => syncInstance.app.modes.mode === 'idle');
  });

  test('the control panel works over HTTPS with the self-signed certificate', async () => {
    const secure = await startInstance({ protocol: 'https' });
    const page = await browser.newPage(`${secure.base}/`);
    await page.waitFor(`document.querySelector('.choice') !== null`);
    assert.equal(await page.text('.protocol-badge'), 'HTTPS');
    // The live event stream works over TLS too: a change shows up by itself.
    await secure.app.modes.startHosting({ path: await tempDir(), name: 'Secure share', pin: '1234' });
    await page.waitFor(`document.querySelector('.pin-display')?.textContent === '1234'`, { message: 'the pushed hosting state' });
  });

  test('the layout holds on a phone-sized screen', async () => {
    const overflow = (page) => page.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    const page = await browser.newPage(`${hostInstance.base}/`);
    await page.setViewport(390, 844, true);
    await page.waitFor(`document.querySelector('.choice') !== null`);
    assert.ok((await overflow(page)) <= 1, 'start screen');

    // The busiest screens: the hosting panel (long path, status bar chip) and the forms.
    await hostInstance.app.modes.startHosting({ path: hostDir, name: 'A rather long directory name for a phone', pin: '1234' });
    await page.waitFor(`document.querySelector('.pin-display')?.textContent === '1234'`);
    assert.ok((await overflow(page)) <= 1, 'hosting panel');
    for (const hash of ['#/host', '#/sync']) {
      await page.evaluate(`location.hash = '${hash}'`);
      await page.waitFor(`document.querySelector('.setup') !== null`);
      assert.ok((await overflow(page)) <= 1, hash);
    }
    await hostInstance.app.modes.stopHosting();
  });
});
