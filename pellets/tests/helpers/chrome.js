/**
 * Minimal Chrome DevTools Protocol driver.
 *
 * Used by the browser end-to-end test to drive a real headless Chromium. It
 * speaks CDP over a WebSocket using the `ws` package that the application
 * already depends on, so the test suite still adds no dependency of its own.
 *
 * The browser binary is looked up on the host; when none is found the caller
 * skips its tests instead of failing.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import WebSocket from 'ws';

/** Candidate Chromium/Chrome binaries, in preference order. */
const CANDIDATES = [
  process.env.PELLETS_CHROME,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
].filter(Boolean);

/** @returns {string|null} Path to a usable browser, or null. */
export function findChrome() {
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Resolve once `predicate(line)` matches a line of the child's stderr. */
function waitForLine(child, predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for browser output. Got:\n${buffer.slice(-2000)}`));
    }, timeoutMs);

    const onData = (chunk) => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n')) {
        const match = predicate(line);
        if (match) {
          cleanup();
          resolve(match);
          return;
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.stderr.off('data', onData);
    };

    child.stderr.on('data', onData);
  });
}

/**
 * Launch a headless browser.
 * @param {{ ignoreCertificateErrors?: boolean }} [options]
 */
export async function launchBrowser(options = {}) {
  const binary = findChrome();
  if (!binary) throw new Error('No Chromium/Chrome binary found');

  const profile = await mkdtemp(join(tmpdir(), 'pellets-chrome-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--hide-scrollbars',
    '--window-size=1280,900',
  ];
  // The server under test uses a self-signed certificate on purpose.
  if (options.ignoreCertificateErrors) args.push('--ignore-certificate-errors');
  args.push('about:blank');

  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.setEncoding('utf8');

  const endpoint = await waitForLine(child, (line) => {
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(line);
    return match ? match[1] : null;
  });

  // The endpoint URL carries the host and port of the DevTools HTTP API.
  const url = new URL(endpoint);
  const httpBase = `http://${url.host}`;

  return {
    binary,
    child,
    httpBase,
    endpoint,

    /** Open a new page in an isolated browser context (its own cookie jar). */
    async newPage({ isolated = true } = {}) {
      const browser = await connectSession(endpoint);
      let browserContextId;
      if (isolated) {
        const created = await browser.send('Target.createBrowserContext', { disposeOnDetach: false });
        browserContextId = created.browserContextId;
      }
      const target = await browser.send('Target.createTarget', {
        url: 'about:blank',
        ...(browserContextId ? { browserContextId } : {}),
      });

      const list = await fetch(`${httpBase}/json/list`).then((response) => response.json());
      const entry = list.find((item) => item.id === target.targetId);
      if (!entry) throw new Error('Could not find the new target');

      const page = await connectSession(entry.webSocketDebuggerUrl);
      page.browserSocket = browser;
      page.targetId = target.targetId;
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      return page;
    },

    async close() {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Open a CDP session over a WebSocket URL. */
function connectSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
    let sequence = 0;
    const pending = new Map();
    const listeners = new Map();

    socket.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame.id && pending.has(frame.id)) {
        const entry = pending.get(frame.id);
        pending.delete(frame.id);
        if (frame.error) entry.reject(new Error(`${frame.error.message} (${entry.method})`));
        else entry.resolve(frame.result);
        return;
      }
      const set = listeners.get(frame.method);
      if (set) for (const handler of [...set]) handler(frame.params);
    });

    socket.on('error', reject);

    socket.on('open', () =>
      resolve({
        socket,
        /** Send a CDP command. */
        send(method, params = {}) {
          sequence += 1;
          const id = sequence;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej, method });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        /** Subscribe to a CDP event. */
        on(method, handler) {
          let set = listeners.get(method);
          if (!set) {
            set = new Set();
            listeners.set(method, set);
          }
          set.add(handler);
          return () => set.delete(handler);
        },
        close() {
          try {
            socket.close();
          } catch {
            /* ignore */
          }
        },
      }),
    );
  });
}

/**
 * Convenience wrappers around a CDP page session.
 * @param {object} page
 */
export function pageApi(page) {
  const api = {
    page,

    /** Navigate and wait for the load event. */
    async goto(url) {
      const loaded = new Promise((resolve) => {
        const off = page.on('Page.loadEventFired', () => {
          off();
          resolve();
        });
      });
      await page.send('Page.navigate', { url });
      await loaded;
    },

    /**
     * Evaluate a function body in the page and return its JSON value.
     * @param {string} expression Statements ending in a `return`.
     */
    async evaluate(expression) {
      const result = await page.send('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          `Page evaluation failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`,
        );
      }
      return result.result.value;
    },

    /** Poll an expression until it returns a truthy value. */
    async waitFor(expression, { timeout = 10000, interval = 60, label = expression } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const value = await api.evaluate(`return (${expression});`);
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
      throw new Error(`Timed out waiting for: ${label}`);
    },

    /** Type into a field addressed by a CSS selector. */
    async fill(selector, value) {
      return api.evaluate(`
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) throw new Error('No element for ' + ${JSON.stringify(selector)});
        node.focus();
        node.value = ${JSON.stringify(value)};
        node.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      `);
    },

    /** Click an element addressed by a CSS selector. */
    async click(selector) {
      return api.evaluate(`
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) throw new Error('No element for ' + ${JSON.stringify(selector)});
        node.click();
        return true;
      `);
    },

    /** Text content of the first matching element, or null. */
    async text(selector) {
      return api.evaluate(`
        const node = document.querySelector(${JSON.stringify(selector)});
        return node ? node.textContent.trim() : null;
      `);
    },

    /** Current location.pathname. */
    path() {
      return api.evaluate('return window.location.pathname;');
    },

    close() {
      page.close();
      page.browserSocket?.close();
    },
  };
  return api;
}
