/**
 * A minimal headless Chromium driver for the end-to-end tests.
 *
 * It speaks the Chrome DevTools Protocol over `--remote-debugging-pipe`:
 * Chromium reads commands from file descriptor 3 and writes answers to file
 * descriptor 4, as NUL-terminated JSON. No WebSocket is involved, so the test
 * suite adds no dependency (chokidar stays the only one).
 *
 * When no Chromium or Chrome binary is installed, `findBrowser()` returns null
 * and the browser tests skip themselves.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.REPTILE_CHROME,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
].filter(Boolean);

/** Path of a usable browser, or null. */
export function findBrowser() {
  if (process.env.REPTILE_SKIP_BROWSER_TESTS === '1') return null;
  return CANDIDATES.find((candidate) => existsSync(candidate)) || null;
}

/**
 * Launch a headless browser.
 * @param {{ width?: number, height?: number }} [options]
 */
export async function launchBrowser({ width = 1280, height = 900 } = {}) {
  const binary = findBrowser();
  if (!binary) throw new Error('No Chromium/Chrome binary found');
  const profile = await mkdtemp(join(tmpdir(), 'reptile-chrome-'));
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--ignore-certificate-errors',
      '--hide-scrollbars',
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
  );
  child.stderr.resume();

  const commands = child.stdio[3];
  const answers = child.stdio[4];
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  let buffer = Buffer.alloc(0);

  answers.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let end = buffer.indexOf(0);
    while (end !== -1) {
      const raw = buffer.subarray(0, end).toString('utf8');
      buffer = buffer.subarray(end + 1);
      end = buffer.indexOf(0);
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of listeners) listener(message);
      }
    }
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      commands.write(`${JSON.stringify(message)}\0`);
    });

  const waitForEvent = (method, sessionId, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const listener = (message) => {
        if (message.method === method && (!sessionId || message.sessionId === sessionId)) {
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(message.params);
        }
      };
      listeners.add(listener);
    });

  // Wait until the browser answers at all.
  await send('Browser.getVersion');

  return {
    /**
     * Open a new tab.
     * @param {string} url
     */
    async newPage(url) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      await send('Page.enable', {}, sessionId);
      await send('Runtime.enable', {}, sessionId);
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
      const page = createPage({ send, sessionId, targetId, waitForEvent });
      if (url) await page.goto(url);
      return page;
    },

    async close() {
      try {
        await Promise.race([send('Browser.close'), new Promise((resolve) => setTimeout(resolve, 2000))]);
      } catch {
        /* already gone */
      }
      child.kill('SIGKILL');
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function createPage({ send, sessionId, targetId, waitForEvent }) {
  const page = {
    targetId,

    async goto(url) {
      const loaded = waitForEvent('Page.loadEventFired', sessionId);
      await send('Page.navigate', { url }, sessionId);
      await loaded;
    },

    /** Evaluate an expression in the page and return its (JSON) value. */
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) {
        throw new Error(`Page error: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      }
      return result.result.value;
    },

    /** Poll until `expression` is truthy. */
    async waitFor(expression, { timeoutMs = 15000, intervalMs = 100, message } = {}) {
      const started = Date.now();
      let last;
      while (Date.now() - started < timeoutMs) {
        try {
          last = await page.evaluate(expression);
          if (last) return last;
        } catch (error) {
          last = error.message;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      throw new Error(message || `Timed out waiting for: ${expression} (last: ${JSON.stringify(last)})`);
    },

    /** Click the first element matching a CSS selector. */
    click(selector) {
      return page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no element ${selector.replace(/'/g, '')}'); el.click(); return true; })()`);
    },

    /** Set an input's value as if typed, firing an input event. */
    type(selector, value) {
      return page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('no element');
        el.focus();
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    },

    /** Text content of the first element matching a selector. */
    text(selector) {
      return page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    },

    /** Save a PNG screenshot. */
    async screenshot(path, { fullPage = false } = {}) {
      const params = { format: 'png' };
      if (fullPage) {
        const { cssContentSize } = await send('Page.getLayoutMetrics', {}, sessionId);
        params.clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
        params.captureBeyondViewport = true;
      }
      const { data } = await send('Page.captureScreenshot', params, sessionId);
      await writeFile(path, Buffer.from(data, 'base64'));
    },

    /** Emulate the operating system's light or dark preference. */
    emulateColorScheme(scheme) {
      return send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId);
    },

    /** Resize the viewport (e.g. to check the phone layout). */
    setViewport(width, height, mobile = false) {
      return send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }, sessionId);
    },
  };
  return page;
}
