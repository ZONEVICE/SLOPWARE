/**
 * End-to-end tests in a real browser.
 *
 * Drives headless Chromium over the DevTools Protocol (see
 * `tests/helpers/chrome.js`, which speaks CDP using the `ws` package the
 * application already depends on). This is what proves the GUI itself works:
 * the dark default, the username modal, live messaging between two users, the
 * typing indicator, attachments, and the owner-only room deletion.
 *
 * The whole suite SKIPS itself when no Chromium/Chrome binary is installed, so
 * `npm test` still passes on a machine without one. Point PELLETS_CHROME at a
 * binary to use a specific build.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, sleep } from './helpers/server.js';
import { findChrome, launchBrowser, pageApi } from './helpers/chrome.js';

const chrome = process.env.PELLETS_SKIP_BROWSER_TESTS === '1' ? null : findChrome();
const options = chrome
  ? {}
  : { skip: 'no Chromium/Chrome binary available (set PELLETS_CHROME, or unset PELLETS_SKIP_BROWSER_TESTS)' };

describe('browser end to end', options, () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** @type {Awaited<ReturnType<typeof launchBrowser>>} */
  let browser;
  /** Console errors from any page; asserted to stay empty. */
  const consoleErrors = [];

  before(async () => {
    server = await startTestServer();
    browser = await launchBrowser();
  }, { timeout: 60000 });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  });

  /** Open a page in its own cookie jar and watch it for script errors. */
  async function openPage(label) {
    const page = pageApi(await browser.newPage());
    page.page.on('Runtime.consoleAPICalled', (event) => {
      if (event.type === 'error') {
        consoleErrors.push(`${label}: ${event.args.map((arg) => arg.value || arg.description).join(' ')}`);
      }
    });
    page.page.on('Runtime.exceptionThrown', (event) => {
      consoleErrors.push(`${label}: ${event.exceptionDetails?.exception?.description || event.exceptionDetails?.text}`);
    });
    return page;
  }

  /** Load the app and complete the one setup step: pick a username. */
  async function signIn(page, name) {
    await page.goto(`${server.base}/`);
    await page.waitFor("document.querySelector('input[name=displayName]')", { label: 'username modal' });
    await page.fill('input[name="displayName"]', name);
    await page.click('.modal .btn-primary');
    await page.waitFor("!document.querySelector('.modal')", { label: 'modal closed' });
  }

  /** Create a room from the Home screen and return its path. */
  async function createRoom(page, name, topic = '') {
    await page.click('.page-head .btn-primary, .empty .btn-primary');
    await page.waitFor("document.querySelector('.modal input')", { label: 'create-room modal' });
    await page.fill('.modal .field:nth-child(1) input', name);
    if (topic) await page.fill('.modal .field:nth-child(2) input', topic);
    await page.click('.modal .btn-primary');
    await page.waitFor("window.location.pathname.startsWith('/room/')", { label: 'navigated into the room' });
    return page.path();
  }

  test('the shell loads in dark mode and asks for a username', { timeout: 60000 }, async () => {
    const page = await openPage('shell');
    await page.goto(`${server.base}/`);

    assert.equal(await page.evaluate('return document.title;'), 'Pellets');
    assert.equal(
      await page.evaluate('return document.documentElement.dataset.theme;'),
      'dark',
      'dark mode is the default',
    );

    // The server already created a session from the client metadata.
    const session = await page.evaluate("const r = await fetch('/api/session'); return (await r.json()).session;");
    assert.match(session.id, /^[0-9a-f-]{36}$/);
    assert.equal(session.identified, false);

    await page.waitFor("document.querySelector('.modal-title')", { label: 'username modal' });
    assert.equal(await page.text('.modal-title'), 'Pick a username');

    await page.fill('input[name="displayName"]', 'Alicia');
    await page.click('.modal .btn-primary');
    await page.waitFor("!document.querySelector('.modal')");

    const after = await page.evaluate("const r = await fetch('/api/session'); return (await r.json()).session;");
    assert.equal(after.displayName, 'Alicia');
    assert.equal(typeof after.colorHue, 'number', 'a colour was assigned automatically');
    assert.equal(after.id, session.id, 'the UUID did not change');

    assert.equal(await page.text('.conn-label'), 'Live', 'the WebSocket is connected');
    page.close();
  });

  test('two users chat in real time, with typing and history', { timeout: 90000 }, async () => {
    const alice = await openPage('alice');
    const bruno = await openPage('bruno');
    await signIn(alice, 'Alicia');
    await signIn(bruno, 'Bruno');

    const roomPath = await createRoom(alice, 'General', 'Pruebas end to end');

    // Bruno sees the new room appear on Home without reloading.
    await bruno.waitFor(
      "[...document.querySelectorAll('.room-card-name')].some(n => n.textContent === 'General')",
      { label: 'the room appears on the other Home screen' },
    );

    // Alice writes some history before Bruno arrives.
    await alice.fill('.composer textarea', 'Primer mensaje, antes de que llegue nadie');
    await alice.click('.composer button[type=submit]');
    await alice.waitFor("document.querySelectorAll('.msg').length === 1");

    // Bruno opens the room straight from its URL.
    await bruno.goto(`${server.base}${roomPath}`);
    await bruno.waitFor("document.querySelectorAll('.msg').length === 1", { label: 'history is visible' });
    assert.equal(await bruno.text('.msg-text'), 'Primer mensaje, antes de que llegue nadie');
    assert.equal(await bruno.text('.msg-author'), 'Alicia');

    // Presence is shown on both sides.
    await alice.waitFor("document.querySelectorAll('.member').length === 2", { label: 'two members' });
    assert.deepEqual(
      (await alice.evaluate("return [...document.querySelectorAll('.member-name')].map(n => n.textContent);")).sort(),
      ['Alicia', 'Bruno'],
    );

    // Bruno starts typing; Alice sees the indicator.
    await bruno.evaluate(`
      const field = document.querySelector('.composer textarea');
      field.focus();
      field.value = 'escribiendo…';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await alice.waitFor("document.querySelector('.typing.is-active')", { label: 'typing indicator' });
    assert.match(await alice.text('.typing'), /Bruno is typing/);

    // Bruno sends; the message arrives and the indicator clears.
    await bruno.click('.composer button[type=submit]');
    await alice.waitFor("document.querySelectorAll('.msg').length === 2", { label: 'message delivered' });
    await alice.waitFor("!document.querySelector('.typing.is-active')", { label: 'typing cleared' });
    assert.equal(
      await alice.evaluate("return document.querySelectorAll('.msg-text')[1].textContent;"),
      'escribiendo…',
    );

    // Renaming repaints the messages Bruno already sent.
    await bruno.goto(`${server.base}/settings`);
    await bruno.waitFor("document.querySelector('.card form input.input')");
    await bruno.fill('.card form input.input', 'Bruno Renombrado');
    await bruno.click('.card form button[type=submit]');
    await alice.waitFor(
      "[...document.querySelectorAll('.msg-author')].some(n => n.textContent === 'Bruno Renombrado')",
      { label: 'the rename reaches already-rendered messages' },
    );

    alice.close();
    bruno.close();
  });

  test('attachments render as preview, player and download card', { timeout: 90000 }, async () => {
    const alice = await openPage('files-alice');
    const bruno = await openPage('files-bruno');
    await signIn(alice, 'Alicia');
    await signIn(bruno, 'Bruno');
    const roomPath = await createRoom(alice, 'Archivos');
    await bruno.goto(`${server.base}${roomPath}`);
    await bruno.waitFor("document.querySelector('.composer textarea')");

    // Build a real PNG in the page and attach it together with a binary file.
    await alice.evaluate(`
      const canvas = document.createElement('canvas');
      canvas.width = 120; canvas.height = 80;
      const context = canvas.getContext('2d');
      context.fillStyle = '#5b8cff';
      context.fillRect(0, 0, 120, 80);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'captura.png', { type: 'image/png' }));
      transfer.items.add(new File([new Uint8Array(2048)], 'informe.pdf', { type: 'application/pdf' }));
      const input = document.querySelector('.composer input[type=file]');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `);

    await alice.waitFor("document.querySelectorAll('.pending[data-state=done]').length === 2", {
      label: 'both uploads finished',
      timeout: 20000,
    });
    await alice.fill('.composer textarea', 'Adjuntos');
    await alice.click('.composer button[type=submit]');

    // The chips clear once the message is sent.
    await alice.waitFor("document.querySelectorAll('.pending').length === 0", { label: 'composer reset' });

    await bruno.waitFor("document.querySelector('.media-thumb img')", { label: 'image preview' });
    assert.equal(
      await bruno.evaluate("const i = document.querySelector('.media-thumb img'); return i.complete && i.naturalWidth === 120;"),
      true,
      'the image really loaded from /uploads/',
    );

    // A non-media file is a card showing its name and extension.
    assert.equal(await bruno.text('.file-card .file-name'), 'informe.pdf');
    assert.equal(await bruno.text('.file-ext'), 'PDF');
    assert.equal(
      await bruno.evaluate("const a = document.querySelector('.file-card'); return a.hasAttribute('download') && a.getAttribute('href').includes('download=1');"),
      true,
      'clicking a binary downloads it',
    );

    // Clicking the image opens the enlarged view, Escape closes it.
    await bruno.click('.media-thumb');
    await bruno.waitFor("document.querySelector('.lightbox')", { label: 'lightbox opened' });
    assert.equal(await bruno.text('.lightbox-name'), 'captura.png');
    await bruno.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true;");
    await bruno.waitFor("!document.querySelector('.lightbox')", { label: 'lightbox closed' });

    // A video renders as an inline <video> preview with a play badge, and
    // clicking it opens the browser's own player. The bytes here are not a
    // decodable stream - what is under test is the rendering path, not codecs.
    await alice.evaluate(`
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(4096)], 'clip.mp4', { type: 'video/mp4' }));
      const input = document.querySelector('.composer input[type=file]');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `);
    await alice.waitFor("document.querySelectorAll('.pending[data-state=done]').length === 1", {
      label: 'video uploaded',
      timeout: 20000,
    });
    await alice.click('.composer button[type=submit]');

    await bruno.waitFor("document.querySelector('.media-thumb video')", { label: 'video preview' });
    assert.equal(
      await bruno.evaluate("return document.querySelector('.media-thumb video').getAttribute('preload');"),
      'metadata',
      'the preview only fetches metadata, not the whole file',
    );
    assert.equal(
      await bruno.evaluate("return !!document.querySelector('.media-thumb .media-play');"),
      true,
      'a play badge marks it as a video',
    );

    await bruno.evaluate("document.querySelectorAll('.media-thumb')[1].click(); return true;");
    await bruno.waitFor("document.querySelector('.lightbox video')", { label: 'video player opened' });
    assert.equal(
      await bruno.evaluate("const v = document.querySelector('.lightbox video'); return v.controls && v.autoplay;"),
      true,
      'the enlarged video uses the native browser controls',
    );
    await bruno.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true;");
    await bruno.waitFor("!document.querySelector('.lightbox')");

    alice.close();
    bruno.close();
  });

  test('only the creator sees the delete control, and deletion evicts everyone', { timeout: 90000 }, async () => {
    const alice = await openPage('delete-alice');
    const bruno = await openPage('delete-bruno');
    await signIn(alice, 'Alicia');
    await signIn(bruno, 'Bruno');
    const roomPath = await createRoom(alice, 'Efímera');
    await bruno.goto(`${server.base}${roomPath}`);
    await bruno.waitFor("document.querySelector('.composer textarea')");

    assert.equal(
      await alice.evaluate("return !!document.querySelector('.room-head .btn-danger');"),
      true,
      'the creator sees a delete button',
    );
    assert.equal(
      await bruno.evaluate("return !!document.querySelector('.room-head .btn-danger');"),
      false,
      'everyone else does not',
    );

    await alice.click('.room-head .btn-danger');
    await alice.waitFor("document.querySelector('.modal .btn-danger')", { label: 'confirmation' });
    await alice.click('.modal .btn-danger');

    await bruno.waitFor("window.location.pathname === '/'", { label: 'evicted back to Home' });
    assert.match(await bruno.text('.toast'), /was deleted by its creator/);
    // Other tests in this file leave their own rooms behind, so look for this
    // one specifically rather than for an empty list.
    await bruno.waitFor(
      "![...document.querySelectorAll('.room-card-name')].some(n => n.textContent === 'Efímera')",
      { label: 'the deleted room is gone from the list' },
    );

    alice.close();
    bruno.close();
  });

  test('live user counts on Home follow people in and out', { timeout: 90000 }, async () => {
    const alice = await openPage('count-alice');
    const bruno = await openPage('count-bruno');
    await signIn(alice, 'Alicia');
    await signIn(bruno, 'Bruno');
    const roomPath = await createRoom(alice, 'Ocupación');

    const countOnHome = `
      const card = [...document.querySelectorAll('.room-card')]
        .find(c => c.querySelector('.room-card-name').textContent === 'Ocupación');
      return card ? Number(card.querySelector('.badge span').textContent) : -1;
    `;

    await bruno.waitFor(`(() => { ${countOnHome} })() === 1`, { label: 'Home shows one person' });

    await bruno.goto(`${server.base}${roomPath}`);
    await bruno.waitFor("document.querySelector('.composer textarea')");
    await alice.waitFor("document.querySelectorAll('.member').length === 2");

    // Alice goes back Home; the counter drops to just Bruno.
    await alice.click('a[href="/"]');
    await alice.waitFor("window.location.pathname === '/'");
    await alice.waitFor(`(() => { ${countOnHome} })() === 1`, { label: 'counter drops when Alice leaves' });

    // Bruno leaves too, with a full page load: the room stays, empty.
    await bruno.goto(`${server.base}/`);
    await alice.waitFor(`(() => { ${countOnHome} })() === 0`, { label: 'counter reaches zero' });
    assert.equal(
      await alice.evaluate(
        "return [...document.querySelectorAll('.room-card-name')].some(n => n.textContent === 'Ocupación');",
      ),
      true,
      'an empty room stays open and listed',
    );

    alice.close();
    bruno.close();
  });

  test('the theme can be switched and is remembered', { timeout: 60000 }, async () => {
    const page = await openPage('theme');
    await signIn(page, 'Alicia');
    assert.equal(await page.evaluate('return document.documentElement.dataset.theme;'), 'dark');

    await page.click('.header-actions button');
    assert.equal(await page.evaluate('return document.documentElement.dataset.theme;'), 'light');
    assert.equal(await page.evaluate("return localStorage.getItem('pellets.theme');"), 'light');

    // The preference survives a reload, with no flash of the wrong theme: the
    // inline bootstrap in index.html applies it before any stylesheet loads, so
    // this holds at the load event, before the client has even booted.
    await page.goto(`${server.base}/settings`);
    assert.equal(await page.evaluate('return document.documentElement.dataset.theme;'), 'light');

    // The Settings view itself mounts later, after the async boot, so wait for
    // it rather than assuming it is already there.
    await page.waitFor("document.querySelector('.segmented button:nth-child(2)')", {
      label: 'the theme control rendered',
    });
    assert.equal(
      await page.evaluate("return document.querySelector('.segmented button:nth-child(2)').getAttribute('aria-pressed');"),
      'true',
    );

    page.close();
  });

  test('the layout works at phone width', { timeout: 60000 }, async () => {
    const page = await openPage('mobile');
    await page.page.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 780,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await signIn(page, 'Alicia');
    await createRoom(page, 'Móvil');
    await page.waitFor("document.querySelector('.room-side') && document.querySelector('.composer')", {
      label: 'the room view rendered',
    });
    await sleep(200); // let the layout settle before measuring it

    const layout = await page.evaluate(`
      return {
        horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
        sidebarVisible: getComputedStyle(document.querySelector('.room-side')).display !== 'none',
        backVisible: getComputedStyle(document.querySelector('.room-back')).display !== 'none',
        composerInView: document.querySelector('.composer').getBoundingClientRect().bottom <= window.innerHeight + 1,
      };
    `);

    assert.equal(layout.horizontalScroll, false, 'no horizontal scrolling at 390px');
    assert.equal(layout.sidebarVisible, false, 'the member rail collapses on a phone');
    assert.equal(layout.backVisible, true, 'a back button replaces it');
    assert.equal(layout.composerInView, true, 'the composer stays reachable');

    page.close();
  });

  test('no page logged a script error during the whole run', () => {
    assert.deepEqual(consoleErrors, []);
  });
});

/**
 * The same application over HTTPS.
 *
 * The client picks `ws://` or `wss://` from the page's own protocol, so this is
 * the test that proves the realtime layer follows the server into TLS with no
 * configuration anywhere.
 */
describe('browser end to end over HTTPS', options, () => {
  let server;
  let browser;

  before(async () => {
    server = await startTestServer({ protocol: 'https' });
    // The certificate is self-signed by design; accept it for this run only.
    browser = await launchBrowser({ ignoreCertificateErrors: true });
  }, { timeout: 60000 });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  });

  test('chat works over wss:// with a generated certificate', { timeout: 90000 }, async () => {
    const alice = pageApi(await browser.newPage());
    const bruno = pageApi(await browser.newPage());

    for (const [page, name] of [[alice, 'Alicia'], [bruno, 'Bruno']]) {
      await page.goto(`${server.base}/`);
      await page.waitFor("document.querySelector('input[name=displayName]')", { label: 'username modal' });
      await page.fill('input[name="displayName"]', name);
      await page.click('.modal .btn-primary');
      await page.waitFor("!document.querySelector('.modal')");
    }

    assert.equal(await alice.evaluate('return window.location.protocol;'), 'https:');
    await alice.waitFor("document.querySelector('.conn-pill[data-state=online]')", { label: 'wss connected' });

    await alice.click('.page-head .btn-primary, .empty .btn-primary');
    await alice.waitFor("document.querySelector('.modal input')");
    await alice.fill('.modal .field:nth-child(1) input', 'Segura');
    await alice.click('.modal .btn-primary');
    await alice.waitFor("window.location.pathname.startsWith('/room/')");
    const roomPath = await alice.path();

    await bruno.goto(`${server.base}${roomPath}`);
    await bruno.waitFor("document.querySelector('.composer textarea')");
    await alice.waitFor("document.querySelectorAll('.member').length === 2");

    await bruno.fill('.composer textarea', 'cifrado de extremo a extremo del transporte');
    await bruno.click('.composer button[type=submit]');
    await alice.waitFor("document.querySelectorAll('.msg').length === 1", { label: 'message over wss' });
    assert.equal(await alice.text('.msg-text'), 'cifrado de extremo a extremo del transporte');

    alice.close();
    bruno.close();
  });
});
