/**
 * The syncing side's client for the host's peer API.
 *
 * One client per target (address, port, protocol). It keeps a keep-alive agent
 * for the many small requests of a synchronisation, a separate connection for
 * the long-lived event stream, the bearer token of the current session, and
 * the certificate fingerprint pinned when that session was opened.
 */
import { createReadStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { httpRequest, RequestError } from '../lib/httpRequest.js';
import { createLineParser } from '../lib/ndjson.js';
import { HEADERS, PATHS, TIMING } from '../domain/protocol.js';

/**
 * @param {object} options
 * @param {string} options.address
 * @param {number} options.port
 * @param {'http'|'https'} options.protocol
 * @param {object} options.identity This instance, sent when connecting.
 * @param {Partial<typeof TIMING>} [options.timing] Overrides, for tests.
 */
export function createPeerClient({ address, port, protocol, identity, timing: overrides }) {
  const timing = { ...TIMING, ...(overrides || {}) };
  const Agent = protocol === 'https' ? https.Agent : http.Agent;
  const agent = new Agent({ keepAlive: true, maxSockets: 8, ...(protocol === 'https' ? { rejectUnauthorized: false } : {}) });
  let token = null;
  let fingerprint = null;

  const authHeaders = () => (token ? { Authorization: `Bearer ${token}` } : {});

  const request = (options) =>
    httpRequest({
      protocol,
      host: address,
      port,
      agent,
      fingerprint,
      ...options,
      headers: { ...authHeaders(), ...(options.headers || {}) },
    });

  return {
    address,
    port,
    protocol,

    get token() {
      return token;
    },
    set token(value) {
      token = value;
    },
    get fingerprint() {
      return fingerprint;
    },

    /** `GET /api/ping`. */
    async ping({ timeoutMs = 4000 } = {}) {
      const response = await httpRequest({ protocol, host: address, port, path: PATHS.ping, timeoutMs, headers: { Connection: 'close' } });
      return { ...response.data, fingerprint: response.fingerprint };
    },

    /**
     * Open a session with the PIN. Pins the host's certificate for the rest of
     * the session.
     * @param {{ pin: string, localPath: string }} input
     */
    async connect({ pin, localPath }) {
      const response = await httpRequest({
        protocol,
        host: address,
        port,
        agent,
        method: 'POST',
        path: PATHS.connect,
        timeoutMs: 8000,
        json: {
          pin,
          protocol: identity.protocol,
          peer: { uuid: identity.uuid, hostname: identity.hostname, machine: identity.machine, localPath },
        },
      });
      token = response.data.token;
      fingerprint = response.fingerprint || null;
      return response.data;
    },

    /**
     * Open the host -> peer event stream.
     *
     * The socket's inactivity timeout doubles as the liveness check: the host
     * writes a heartbeat line every few seconds, so a stream that stays silent
     * longer than `timing.streamSilenceMs` is dead and gets closed.
     *
     * @param {{ onMessage: (message: object) => void, onClose: (error?: Error) => void }} handlers
     * @returns {Promise<{ close: () => void }>}
     */
    async openStream({ onMessage, onClose }) {
      const response = await httpRequest({
        protocol,
        host: address,
        port,
        agent: false,
        fingerprint,
        path: PATHS.stream,
        headers: { ...authHeaders(), Accept: 'application/x-ndjson' },
        timeoutMs: timing.streamSilenceMs,
        responseType: 'stream',
      });
      const stream = response.stream;
      let closed = false;
      const finish = (error) => {
        if (closed) return;
        closed = true;
        onClose(error);
      };
      const parse = createLineParser(onMessage);
      stream.on('data', (chunk) => {
        try {
          parse(chunk);
        } catch (error) {
          stream.destroy(error);
        }
      });
      stream.once('end', () => finish());
      stream.once('error', (error) => finish(error));
      stream.once('close', () => finish());
      return {
        close() {
          closed = true;
          stream.destroy();
        },
      };
    },

    /** Every shared entry. */
    async manifest() {
      const response = await request({ path: PATHS.manifest, timeoutMs: 60_000 });
      return response.data;
    },

    /** SHA-256 of the given files on the host. */
    async hashes(paths) {
      const response = await request({ method: 'POST', path: PATHS.hashes, json: { paths }, timeoutMs: 120_000 });
      return response.data.hashes || {};
    },

    /**
     * Download one file.
     * @returns {Promise<{ stream: import('node:http').IncomingMessage, size: number, mtimeMs: number }>}
     */
    async download(path) {
      const response = await request({
        path: `${PATHS.file}?path=${encodeURIComponent(path)}`,
        responseType: 'stream',
        timeoutMs: 30_000,
        headers: { Accept: 'application/octet-stream' },
      });
      const size = Number(response.headers[HEADERS.size] ?? response.headers['content-length']);
      const mtimeMs = Number(response.headers[HEADERS.mtime]);
      if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) {
        response.stream.destroy();
        throw new RequestError('The host sent a file without its size or modification time.', { code: 'bad_response' });
      }
      return { stream: response.stream, size, mtimeMs };
    },

    /**
     * Upload one file from disk.
     * @param {string} path Wire path.
     * @param {{ absolute: string, size: number, mtimeMs: number, base?: { size: number, mtimeMs: number }|null }} file
     */
    async upload(path, { absolute, size, mtimeMs, base }) {
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
        [HEADERS.size]: String(size),
        [HEADERS.mtime]: String(mtimeMs),
      };
      if (base && base.kind !== 'dir') {
        headers[HEADERS.baseSize] = String(base.size);
        headers[HEADERS.baseMtime] = String(base.mtimeMs);
      }
      const response = await request({
        method: 'PUT',
        path: `${PATHS.file}?path=${encodeURIComponent(path)}`,
        headers,
        // Read exactly the announced byte range: a file that grows during the
        // upload must not overflow Content-Length. It will be sent again.
        ...(size === 0
          ? { body: Buffer.alloc(0) }
          : { bodyStream: createReadStream(absolute, { start: 0, end: size - 1 }), expectContinue: true }),
        timeoutMs: 60_000,
      });
      return response.data;
    },

    /** Apply non-content operations on the host, in order. */
    async ops(list) {
      const response = await request({ method: 'POST', path: PATHS.ops, json: { ops: list }, timeoutMs: 60_000 });
      return response.data.results || [];
    },

    /** Tell the host we are alive and what we are doing. */
    async heartbeat(report) {
      await request({ method: 'POST', path: PATHS.heartbeat, json: report, timeoutMs: 5000 });
    },

    /** Leave the session on purpose. Best effort. */
    async disconnect() {
      if (!token) return;
      try {
        await request({ method: 'POST', path: PATHS.disconnect, json: {}, timeoutMs: 2000 });
      } finally {
        token = null;
      }
    },

    /** Release sockets. */
    close() {
      agent.destroy();
    },
  };
}
