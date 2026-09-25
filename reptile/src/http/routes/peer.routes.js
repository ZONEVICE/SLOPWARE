/**
 * The peer API: what a syncing instance calls on the instance that hosts.
 *
 * Everything except `connect` requires `Authorization: Bearer <token>`, where
 * the token came from a successful `connect` with the right PIN. The rules
 * (one peer at a time, unchecked items, conflicts) live in
 * `src/domain/hosting.js`; this file only speaks HTTP.
 */
import { createReadStream } from 'node:fs';
import { readJson } from '../body.js';
import { fail, json, SECURITY_HEADERS } from '../respond.js';
import { errors } from '../../domain/errors.js';
import { HEADERS, PATHS } from '../../domain/protocol.js';
import { encodeLine } from '../../lib/ndjson.js';

/** The bearer token of a request, or "". */
function bearer(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/** A finite number from a header, or NaN. */
function numberHeader(req, name) {
  const raw = req.headers[name];
  return raw === undefined || raw === '' ? Number.NaN : Number(raw);
}

export default function peerRoutes(router, { hosting, logger }) {
  const peer = { access: 'peer' };

  router.post(
    PATHS.connect,
    async ({ req, res, remoteAddress }) => {
      const body = await readJson(req, { limit: 64 * 1024 });
      json(res, 200, hosting.connect({ pin: body.pin, protocol: body.protocol, peer: body.peer, remoteAddress }));
    },
    peer,
  );

  router.get(
    PATHS.stream,
    ({ req, res }) => {
      const token = bearer(req);
      hosting.verify(token);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      req.socket.setNoDelay(true);
      req.socket.setKeepAlive(true, 10_000);
      const sink = {
        send: (message) => {
          if (!res.writableEnded) res.write(encodeLine(message));
        },
        close: () => {
          if (!res.writableEnded) res.end();
        },
      };
      const detach = hosting.attachStream(token, sink);
      req.on('close', detach);
    },
    peer,
  );

  router.get(PATHS.manifest, async ({ req, res }) => json(res, 200, await hosting.manifest(bearer(req))), peer);

  router.post(
    PATHS.hashes,
    async ({ req, res }) => {
      const body = await readJson(req, { limit: 16 * 1024 * 1024 });
      json(res, 200, await hosting.hashes(bearer(req), body.paths));
    },
    peer,
  );

  router.get(
    PATHS.file,
    async ({ req, res, url }) => {
      const file = await hosting.openFile(bearer(req), url.searchParams.get('path'));
      const { size, mtimeMs } = file.state;
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'Cache-Control': 'no-store',
        [HEADERS.size]: String(size),
        [HEADERS.mtime]: String(mtimeMs),
      });
      res.once('finish', () => file.sent());
      if (size === 0 || req.method === 'HEAD') {
        res.end();
        return;
      }
      // Exactly the announced range: a file growing meanwhile must not
      // overflow Content-Length. A shrinking one ends early and the peer's
      // size check rejects it.
      const stream = createReadStream(file.absolute, { start: 0, end: size - 1 });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    },
    peer,
  );

  router.put(
    PATHS.file,
    async ({ req, res, url, expectContinue }) => {
      const size = numberHeader(req, HEADERS.size);
      const mtimeMs = numberHeader(req, HEADERS.mtime);
      const baseSize = numberHeader(req, HEADERS.baseSize);
      const baseMtime = numberHeader(req, HEADERS.baseMtime);
      const base = Number.isFinite(baseSize) && Number.isFinite(baseMtime) ? { kind: 'file', size: baseSize, mtimeMs: baseMtime } : null;
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && Number.isFinite(size) && declared !== size) {
        throw errors.badRequest('Content-Length and the declared file size differ.', 'size_mismatch');
      }

      // Decide before reading a single byte. With `Expect: 100-continue` a
      // refused upload never sends its body at all.
      const prepared = await hosting.prepareUpload(bearer(req), { path: url.searchParams.get('path'), size, mtimeMs, base });
      if (prepared.unchanged) {
        json(res, 200, { ok: true, unchanged: true });
        if (!expectContinue) req.resume();
        return;
      }
      if (expectContinue) res.writeContinue();
      try {
        json(res, 200, await hosting.receiveFile(prepared, req, { size, mtimeMs }));
      } catch (error) {
        // Keep the socket usable: drain what the peer still sends.
        req.resume();
        fail(res, error, { logger });
      }
    },
    { ...peer, manualContinue: true },
  );

  router.post(
    PATHS.ops,
    async ({ req, res }) => {
      const body = await readJson(req, { limit: 64 * 1024 * 1024 });
      json(res, 200, await hosting.applyOps(bearer(req), body.ops));
    },
    peer,
  );

  router.post(
    PATHS.heartbeat,
    async ({ req, res }) => {
      const body = await readJson(req, { limit: 64 * 1024 });
      json(res, 200, hosting.heartbeat(bearer(req), body));
    },
    peer,
  );

  router.post(
    PATHS.disconnect,
    async ({ req, res }) => {
      await readJson(req, { limit: 1024 });
      json(res, 200, hosting.disconnect(bearer(req)));
    },
    peer,
  );
}
