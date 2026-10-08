/**
 * The control panel's files, served as they are from `public/`.
 *
 * The client routes with the URL hash (`#/host`, `#/sync`), so there is no
 * history-API fallback: every real path maps to a real file or to a 404.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { SECURITY_HEADERS, send } from './respond.js';

const MIME = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff2',
  }),
);

/** The control panel may only talk to its own origin. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * @param {{ root: string }} options
 */
export function createStaticHandler({ root }) {
  const base = resolve(root);

  function resolvePath(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;
    const relative = decoded.replace(/^\/+/, '') || 'index.html';
    const full = resolve(base, relative);
    if (full !== base && !full.startsWith(base + sep)) return null;
    return full;
  }

  return {
    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {URL} url
     * @returns {Promise<boolean>} true when a file was served.
     */
    async handle(req, res, url) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;
      const target = resolvePath(url.pathname);
      if (!target) return false;
      let info;
      try {
        info = await stat(target);
      } catch {
        return false;
      }
      if (!info.isFile()) return false;
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME.get(extname(target).toLowerCase()) || 'application/octet-stream',
        'Content-Length': info.size,
        // No build step means no content hashes: always revalidate.
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      });
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      const stream = createReadStream(target);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return true;
    },
  };
}

/** Minimal HTML 404. */
export function notFoundHtml(res, head = false) {
  send(res, 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found.</p>', { head });
}
