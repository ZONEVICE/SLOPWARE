/**
 * Test server helper.
 *
 * Boots a complete Pellets instance on an ephemeral port, in an isolated
 * uploads directory, and hands back the pieces a test needs: the base URL, a
 * cookie-aware HTTP client and a WebSocket client with frame waiting.
 *
 * Nothing here touches the application's real `uploads/` or `cert/` directories.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import WebSocket from 'ws';
import { createApp } from '../../src/app.js';
import { createConfig } from '../../src/config.js';
import { createLogger } from '../../src/lib/logger.js';

/**
 * Start an isolated server.
 * @param {{ protocol?: 'http'|'https', fingerprint?: boolean, overrides?: object }} [options]
 */
export async function startTestServer(options = {}) {
  const uploadsDir = await mkdtemp(join(tmpdir(), 'pellets-uploads-'));
  const certDir = await mkdtemp(join(tmpdir(), 'pellets-cert-'));

  // Identical clients must stay distinct in tests unless a test asks otherwise.
  const previousFingerprint = process.env.PELLETS_FINGERPRINT;
  process.env.PELLETS_FINGERPRINT = options.fingerprint ? '1' : '0';

  const config = createConfig([], {
    protocol: options.protocol || 'http',
    port: 0,
    host: '127.0.0.1',
    logLevel: process.env.PELLETS_TEST_LOG || 'silent',
    uploadsDir,
    certDir,
    ...(options.overrides || {}),
  });

  const app = await createApp({ config, logger: createLogger('test', { level: config.logLevel }) });
  const { port } = await app.listen();

  const base = `${config.protocol}://127.0.0.1:${port}`;
  const wsBase = `${config.protocol === 'https' ? 'wss' : 'ws'}://127.0.0.1:${port}`;

  // A self-signed certificate is expected over HTTPS; trust this one explicitly.
  const tlsOptions = config.protocol === 'https' ? { ca: app.tls.cert, rejectUnauthorized: false } : {};

  return {
    app,
    config,
    port,
    base,
    wsBase,
    uploadsDir,
    certDir,
    tls: app.tls,

    /** Create a cookie-scoped HTTP client that behaves like one browser. */
    client(userAgent = 'pellets-test/1.0') {
      return createClient({ base, wsBase, userAgent, tlsOptions });
    },

    async stop() {
      await app.close();
      if (previousFingerprint === undefined) delete process.env.PELLETS_FINGERPRINT;
      else process.env.PELLETS_FINGERPRINT = previousFingerprint;
      await rm(uploadsDir, { recursive: true, force: true }).catch(() => {});
      await rm(certDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Perform an HTTP(S) request with `node:http`/`node:https`.
 *
 * Built on the core modules rather than `fetch` for one reason: `fetch` offers
 * no way to trust a specific certificate, and the HTTPS tests run against a
 * self-signed one generated seconds earlier. The returned object mimics the
 * small slice of the `Response` API the tests use.
 *
 * @param {string} url
 * @param {object} init Method, headers, body, plus TLS options.
 * @returns {Promise<object>}
 */
function rawRequest(url, init = {}) {
  const target = new URL(url);
  const isTls = target.protocol === 'https:';
  const send = isTls ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: init.method || 'GET',
        headers: init.headers || {},
        ...(isTls ? { ca: init.ca, rejectUnauthorized: init.rejectUnauthorized !== false } : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const setCookie = res.headers['set-cookie'] || [];
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: {
              get: (name) => {
                const value = res.headers[String(name).toLowerCase()];
                return value === undefined ? null : Array.isArray(value) ? value.join(', ') : String(value);
              },
              getSetCookie: () => [...setCookie],
              raw: res.headers,
            },
            text: async () => buffer.toString('utf8'),
            json: async () => JSON.parse(buffer.toString('utf8') || 'null'),
            arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
            buffer,
          });
        });
      },
    );

    req.on('error', reject);
    writeBody(req, init.body).catch(reject);
  });
}

/** Write a string, Buffer or web ReadableStream body and end the request. */
async function writeBody(req, body) {
  if (body === undefined || body === null) {
    req.end();
    return;
  }
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    req.end(Buffer.isBuffer(body) ? body : Buffer.from(body));
    return;
  }
  if (typeof body.getReader === 'function') {
    // A web ReadableStream, used to send a chunked body with no Content-Length.
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      req.write(Buffer.from(value));
    }
    req.end();
    return;
  }
  req.end(String(body));
}

/**
 * One simulated browser: keeps its cookie, sends a stable User-Agent and can
 * open WebSocket connections that inherit both.
 */
function createClient({ base, wsBase, userAgent, tlsOptions }) {
  /** @type {Map<string,string>} */
  const cookies = new Map();

  const headers = (extra = {}) => {
    const cookie = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    return { 'user-agent': userAgent, ...(cookie ? { cookie } : {}), ...extra };
  };

  const captureCookies = (response) => {
    const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    for (const entry of raw) {
      const [pair] = entry.split(';');
      const index = pair.indexOf('=');
      if (index > 0) cookies.set(pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1).trim()));
    }
  };

  const client = {
    userAgent,
    cookies,

    /** Request with cookie handling, over HTTP or HTTPS. */
    async fetch(path, init = {}) {
      const response = await rawRequest(`${base}${path}`, {
        ...init,
        headers: headers(init.headers || {}),
        ...tlsOptions,
      });
      captureCookies(response);
      return response;
    },

    /** Fetch and parse JSON, throwing on a non-2xx status. */
    async json(path, init = {}) {
      const response = await client.fetch(path, init);
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const error = new Error(body?.error?.message || `HTTP ${response.status}`);
        error.status = response.status;
        error.code = body?.error?.code;
        throw error;
      }
      return body;
    },

    post: (path, body) =>
      client.json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }),
    patch: (path, body) =>
      client.json(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }),
    del: (path) => client.fetch(path, { method: 'DELETE' }),

    /** Pick a username, which is the only step needed to use the chat. */
    async identify(displayName) {
      await client.fetch('/'); // establishes the session, exactly like a browser
      const body = await client.patch('/api/session', { displayName });
      return body.session;
    },

    /** Open a WebSocket carrying this client's cookie and User-Agent. */
    connect() {
      const socket = new WebSocket(`${wsBase}/ws`, { headers: headers(), ...tlsOptions });
      return wrapSocket(socket);
    },
  };

  return client;
}

/** Add frame buffering and `waitFor` to a raw WebSocket. */
function wrapSocket(socket) {
  /** @type {object[]} */
  const frames = [];
  /** @type {{ match: Function, resolve: Function }[]} */
  const waiters = [];

  socket.on('message', (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    frames.push(frame);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].match(frame)) {
        waiters[index].resolve(frame);
        waiters.splice(index, 1);
      }
    }
  });

  const api = {
    socket,
    frames,

    /** Resolves when the socket is open. */
    ready() {
      if (socket.readyState === WebSocket.OPEN) return Promise.resolve(api);
      return new Promise((resolve, reject) => {
        socket.once('open', () => resolve(api));
        socket.once('error', reject);
      });
    },

    send(type, payload = {}, id = undefined) {
      socket.send(JSON.stringify(id ? { type, id, payload } : { type, payload }));
    },

    /**
     * Wait for a frame.
     * @param {string|((frame:object)=>boolean)} matcher Frame type or predicate.
     * @param {{ timeout?: number, fromStart?: boolean }} [options]
     */
    waitFor(matcher, options = {}) {
      const match = typeof matcher === 'function' ? matcher : (frame) => frame.type === matcher;
      const start = options.fromStart === false ? frames.length : 0;
      const existing = frames.slice(start).find(match);
      if (existing) return Promise.resolve(existing);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for frame: ${String(matcher)}`)),
          options.timeout || 5000,
        );
        waiters.push({
          match,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },

    /** Send a frame and await its reply, like the browser client does. */
    async request(type, payload = {}, options = {}) {
      const id = `t${Math.random().toString(36).slice(2, 8)}`;
      const reply = api.waitFor((frame) => frame.replyTo === id, options);
      api.send(type, payload, id);
      const frame = await reply;
      if (frame.type === 'error') {
        const error = new Error(frame.payload.message);
        error.code = frame.payload.code;
        throw error;
      }
      return frame.payload;
    },

    /** Drop frames received so far, so a later waitFor only sees new ones. */
    reset() {
      frames.length = 0;
    },

    close() {
      return new Promise((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.once('close', resolve);
        socket.close();
      });
    },
  };

  return api;
}

/** Small sleep used where a test must let an asynchronous broadcast settle. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
