/**
 * A minimal Chrome DevTools Protocol driver for headless Chromium, shared by
 * the browser end-to-end test and the screenshot tool. Node.js built-ins only
 * (Node 22+ for the global WebSocket).
 *
 * The browser binary comes from TENDRIL_CHROME or the usual Linux paths;
 * `findChrome()` returns null when none is installed so callers can skip.
 * Certificate errors are ignored (Tendril's certificate is self-signed).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CANDIDATES = [
  process.env.TENDRIL_CHROME,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** Path of a usable Chromium-family browser, or null. */
export function findChrome() {
  return CANDIDATES.find((path) => path && existsSync(path)) || null;
}

/** Browsers not closed yet, as synchronous kill-and-remove functions. */
const running = new Set();
let exitHooked = false;

/**
 * A test that times out, a crash or Ctrl+C must not leave Chromium running
 * (orphaned, it would live on) or its profile in the temp folder, so every
 * browser still open when the process exits is killed and its profile removed.
 */
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const stop of running) stop();
  });
  // Signals skip 'exit' handlers unless the process exits by itself.
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
}

/** Starts headless Chromium and connects to it. */
export async function launchBrowser() {
  const binary = findChrome();
  if (!binary) throw new Error('No Chromium found (set TENDRIL_CHROME).');
  const profile = mkdtempSync(join(tmpdir(), 'tendril-chrome-'));
  // stdio must not be a pipe nobody reads: Chromium logs a lot and would
  // block once the pipe buffer is full.
  const child = spawn(binary, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--ignore-certificate-errors',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ], { stdio: 'ignore' });
  const stop = () => {
    child.kill('SIGKILL');
    // Synchronous on purpose ('exit' handlers cannot await): give Chromium
    // and its helper processes a moment to die before deleting what they
    // may still be writing.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best effort: a temp dir */
    }
  };
  running.add(stop);
  hookExit();
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150 && !existsSync(portFile); i += 1) await sleep(100);
  if (!existsSync(portFile)) {
    running.delete(stop);
    stop();
    throw new Error(`${binary} did not open its DevTools port within 15 s.`);
  }
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const cdp = await connect(`ws://127.0.0.1:${port}${path}`);
  return {
    cdp,
    async close() {
      running.delete(stop);
      cdp.close();
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, sleep(3000)]);
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Chromium may still be flushing its profile; it is a temp dir */
      }
    },
  };
}

function connect(endpoint) {
  const ws = new WebSocket(endpoint);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`));
      else resolve(msg.result);
    } else {
      for (const fn of listeners) fn(msg);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
    });
  return new Promise((resolve) =>
    ws.addEventListener('open', () => resolve({ send, on: (fn) => listeners.push(fn), close: () => ws.close() })),
  );
}

/** Windows virtual key codes for the keys the tests press. */
const KEYS = {
  Enter: [13, 'Enter', '\r'], Escape: [27, 'Escape'], Delete: [46, 'Delete'], Backspace: [8, 'Backspace'],
  Tab: [9, 'Tab'], F1: [112, 'F1'], F2: [113, 'F2'], F3: [114, 'F3'], ArrowUp: [38, 'ArrowUp'],
  ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
  End: [35, 'End'], Home: [36, 'Home'], '`': [192, 'Backquote', '`'], ',': [188, 'Comma', ','],
  '.': [190, 'Period', '.'], '/': [191, 'Slash', '/'],
};

/** Opens a new tab and returns helpers bound to it. */
export async function openPage(browser) {
  const { cdp } = browser;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  const errors = [];
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  });

  const page = {
    send,
    errors,
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      }
      return result.result.value;
    },
    async navigate(url) {
      await send('Page.navigate', { url });
      for (let i = 0; i < 100; i += 1) {
        await sleep(100);
        if ((await page.evaluate('document.readyState').catch(() => '')) === 'complete') break;
      }
    },
    /** Polls a JS expression until it is truthy. */
    async waitFor(expression, timeout = 8000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await page.evaluate(expression).catch(() => false)) return true;
        await sleep(100);
      }
      throw new Error(`timed out waiting for: ${expression}`);
    },
    async setViewport(width, height, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    },
    async screenshot(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(data, 'base64'));
    },
    /** Clicks the centre of the first element matching `selector`. */
    async click(selector) {
      const box = await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!box) throw new Error(`nothing matches ${selector}`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
    },
    /** Types text into the focused element. */
    async type(text) {
      await send('Input.insertText', { text });
    },
    /** Presses a key with modifiers, e.g. "Ctrl+S", "Enter", "F2", "Alt+N". */
    async key(spec) {
      const parts = spec.split('+');
      const name = parts.pop();
      const modifiers = parts.reduce((m, p) => m | { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 }[p], 0);
      let code;
      let key;
      let vk;
      let text;
      if (KEYS[name]) {
        [vk, code, text] = KEYS[name];
        key = text && text !== '\r' ? text : code;
      } else {
        key = name.toLowerCase();
        code = /\d/.test(name) ? `Digit${name}` : `Key${name.toUpperCase()}`;
        vk = name.toUpperCase().charCodeAt(0);
      }
      const base = { modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      if (text && !modifiers) await send('Input.dispatchKeyEvent', { type: 'char', ...base, text });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
  };
  return page;
}
