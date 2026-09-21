/**
 * Response helpers shared by every HTTP route.
 *
 * All of them are HEAD-safe: for a HEAD request the headers are written and the
 * body is dropped, so `curl -I` returns accurate Content-Length values.
 */
import { toAppError } from '../domain/errors.js';

/** Headers applied to every response. */
export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
});

/**
 * Write a response with a Buffer/string body.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string,string|number|string[]>} headers
 * @param {Buffer|string} [body]
 * @param {{ head?: boolean }} [options]
 */
export function send(res, status, headers = {}, body = '', options = {}) {
  if (res.writableEnded) return;
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Length': payload.length,
    ...headers,
  });
  if (options.head) res.end();
  else res.end(payload);
}

/**
 * JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} value
 * @param {{ headers?: object, head?: boolean }} [options]
 */
export function json(res, status, value, options = {}) {
  send(
    res,
    status,
    {
      'Content-Type': 'application/json; charset=utf-8',
      // API responses are per-session; never let a proxy reuse them.
      'Cache-Control': 'no-store',
      ...(options.headers || {}),
    },
    JSON.stringify(value),
    { head: options.head },
  );
}

/** 204 with no body. */
export function noContent(res, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(204, { ...SECURITY_HEADERS, ...headers });
  res.end();
}

/**
 * Error response. Accepts an `AppError` or any thrown value; unknown errors
 * become a generic 500 so internals never leak to the client.
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} error
 * @param {{ headers?: object, head?: boolean, logger?: object }} [options]
 */
export function fail(res, error, options = {}) {
  const appError = toAppError(error);
  if (appError.status >= 500) options.logger?.error?.(appError.message, appError.cause || appError);
  json(res, appError.status, { error: appError.toJSON() }, options);
}

/** 302 redirect. */
export function redirect(res, location, status = 302) {
  if (res.writableEnded) return;
  res.writeHead(status, { ...SECURITY_HEADERS, Location: location, 'Content-Length': 0 });
  res.end();
}
