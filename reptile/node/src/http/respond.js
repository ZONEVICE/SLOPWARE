/**
 * Response helpers shared by every route. All of them are HEAD-safe.
 */
import { toAppError } from '../domain/errors.js';

/** Headers applied to every response. */
export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
});

/**
 * Write a complete response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, string|number>} headers
 * @param {Buffer|string} [body]
 * @param {{ head?: boolean }} [options]
 */
export function send(res, status, headers = {}, body = '', options = {}) {
  if (res.writableEnded || res.headersSent) return;
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Length': payload.length, ...headers });
  if (options.head) res.end();
  else res.end(payload);
}

/**
 * JSON response. API answers are never cacheable.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} value
 * @param {{ headers?: object, head?: boolean }} [options]
 */
export function json(res, status, value, options = {}) {
  send(
    res,
    status,
    { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(options.headers || {}) },
    JSON.stringify(value),
    { head: options.head },
  );
}

/**
 * Error response: `{ error: { code, message } }`. Unknown errors become a
 * generic 500 so internals never leak.
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} error
 * @param {{ logger?: object, headers?: object }} [options]
 */
export function fail(res, error, options = {}) {
  const appError = toAppError(error);
  if (appError.status >= 500) options.logger?.error?.(appError.message, appError.cause || appError);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  json(res, appError.status, { error: appError.toJSON() }, { headers: options.headers });
}
