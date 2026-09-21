/**
 * Static file delivery.
 *
 * Two consumers:
 *  1. The client application under `public/` (HTML, CSS, JS).
 *  2. Uploaded attachments under `uploads/`, through the uploads route.
 *
 * `sendFile` implements conditional requests (ETag / Last-Modified) and HTTP
 * range requests. Range support is not optional here: without it a browser
 * cannot seek inside a `<video>`, and the specification requires videos to play
 * with the browser's own controls.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep, join } from 'node:path';
import { lookupMime, isInlineRenderable } from '../lib/mime.js';
import { SECURITY_HEADERS, send } from './respond.js';

/**
 * Parse a single-range `Range` header.
 * Multi-range requests are answered with the full body, which is allowed.
 * @param {string|undefined} header
 * @param {number} size
 * @returns {{ start: number, end: number }|null|'invalid'}
 */
export function parseRange(header, size) {
  if (!header || typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  let start;
  let end;
  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
    if (end >= size) end = size - 1;
  }

  if (start > end || start < 0 || start >= size) return 'invalid';
  return { start, end };
}

/** Weak validator derived from size and mtime; good enough for static assets. */
function buildEtag(info) {
  return `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
}

/**
 * Stream a file to the client.
 *
 * @param {object} input
 * @param {import('node:http').IncomingMessage} input.req
 * @param {import('node:http').ServerResponse} input.res
 * @param {string} input.path Absolute path, already validated by the caller.
 * @param {string} [input.mime]
 * @param {string} [input.cacheControl]
 * @param {string} [input.downloadName] When set, forces a download with this name.
 * @param {boolean} [input.sandbox] Adds a strict CSP; used for user uploads.
 * @returns {Promise<boolean>} false when the file does not exist.
 */
export async function sendFile({ req, res, path, mime, cacheControl, downloadName, sandbox }) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const isHead = req.method === 'HEAD';
  const contentType = mime || lookupMime(path);
  const etag = buildEtag(info);
  const lastModified = new Date(info.mtimeMs).toUTCString();

  /** @type {Record<string, string|number>} */
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Cache-Control': cacheControl || 'no-cache',
    ETag: etag,
    'Last-Modified': lastModified,
    'Accept-Ranges': 'bytes',
  };

  if (sandbox) {
    // User-supplied files are served with scripting fully disabled, so an
    // uploaded SVG or HTML file can never run in the application's origin.
    headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self' data:; media-src 'self'; sandbox";
  }

  if (downloadName) {
    // RFC 6266: an ASCII fallback plus a UTF-8 form for non-ASCII names.
    const ascii = downloadName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    headers['Content-Disposition'] =
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  } else if (!isInlineRenderable(contentType)) {
    // Non-media types are never rendered inline by this server.
    headers['Content-Disposition'] = 'inline';
  }

  // Conditional request handling.
  const ifNoneMatch = req.headers['if-none-match'];
  const ifModifiedSince = req.headers['if-modified-since'];
  const notModified =
    (ifNoneMatch && ifNoneMatch.split(',').some((value) => value.trim() === etag)) ||
    (!ifNoneMatch && ifModifiedSince && new Date(ifModifiedSince).getTime() >= Math.floor(info.mtimeMs / 1000) * 1000);

  if (notModified) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  const range = parseRange(req.headers.range, info.size);

  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}`, 'Content-Length': 0 });
    res.end();
    return true;
  }

  if (range) {
    const length = range.end - range.start + 1;
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
      'Content-Length': length,
    });
    if (isHead) {
      res.end();
      return true;
    }
    const stream = createReadStream(path, { start: range.start, end: range.end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return true;
  }

  res.writeHead(200, { ...headers, 'Content-Length': info.size });
  if (isHead) {
    res.end();
    return true;
  }
  const stream = createReadStream(path);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
  return true;
}

/**
 * Serve the client application from `public/`.
 *
 * Unknown paths that look like application routes (no file extension, HTML
 * accepted) fall back to `index.html`, so History API URLs such as
 * `/room/<uuid>` and `/settings` are shareable and survive a reload.
 *
 * @param {{ root: string, logger?: object, reservedPrefixes?: string[] }} options
 */
export function createStaticHandler({ root, logger, reservedPrefixes }) {
  const base = resolve(root);
  /**
   * Server namespaces that must never fall back to the application shell: an
   * unknown `/api/...` path has to answer 404 so a client can tell a missing
   * endpoint from a typo in a link.
   */
  const reserved = reservedPrefixes || ['/api/', '/uploads/', '/ws'];

  /** Map a URL path to an absolute path inside `public/`, or null. */
  function resolvePath(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;

    const relative = decoded.replace(/^\/+/, '');
    const full = resolve(base, relative || 'index.html');
    // Containment check: reject anything that escapes `public/`.
    if (full !== base && !full.startsWith(base + sep)) return null;
    return full;
  }

  return {
    root: base,
    resolvePath,

    /**
     * @param {object} ctx
     * @returns {Promise<boolean>} true when the request was answered.
     */
    async handle(ctx) {
      const { req, res, url } = ctx;
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;

      const target = resolvePath(url.pathname);
      if (!target) return false;

      const isDocument = url.pathname === '/' || target.endsWith('.html');
      const served = await sendFile({
        req,
        res,
        path: target,
        // The shell must always be revalidated so a deploy is picked up; other
        // assets are revalidated too, since there is no content hashing.
        cacheControl: isDocument ? 'no-cache' : 'no-cache',
      });
      if (served) return true;

      // Application route fallback.
      if (reserved.some((prefix) => url.pathname.startsWith(prefix))) return false;
      const accepts = String(req.headers.accept || '');
      const looksLikeFile = /\.[a-z0-9]{1,12}$/i.test(url.pathname);
      if (!looksLikeFile && (accepts.includes('text/html') || accepts === '' || accepts.includes('*/*'))) {
        logger?.debug?.('SPA fallback for', url.pathname);
        return sendFile({ req, res, path: join(base, 'index.html'), cacheControl: 'no-cache' });
      }

      return false;
    },
  };
}

/** Convenience 404 body used by the server when nothing handled a request. */
export function notFoundHtml(res, head = false) {
  send(
    res,
    404,
    { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    '<!doctype html><meta charset="utf-8"><title>404</title><p>Not found.',
    { head },
  );
}
