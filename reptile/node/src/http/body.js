/**
 * Request body helpers for small JSON bodies. File uploads never pass through
 * here: they are streamed straight to a temporary file by the peer routes.
 */
import { errors } from '../domain/errors.js';

/**
 * Buffer a request body with a hard size limit.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit?: number }} [options]
 * @returns {Promise<Buffer>}
 */
export function readBody(req, options = {}) {
  const limit = options.limit ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish(reject, errors.payloadTooLarge('Request body is too large.'));
        req.resume();
        return;
      }
      if (!settled) chunks.push(chunk);
    });
    req.once('end', () => finish(resolve, Buffer.concat(chunks)));
    req.once('error', (error) => finish(reject, error));
  });
}

/**
 * Read and parse a JSON object body. An empty body yields `{}`.
 *
 * Requiring `application/json` is also the CSRF defence of the interface
 * routes: a cross-origin page cannot send that content type without a CORS
 * preflight, and this server never answers preflights.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit?: number }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function readJson(req, options = {}) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const raw = await readBody(req, options);
  if (raw.length === 0) return {};
  if (type !== 'application/json') throw errors.unsupportedMedia('Expected an application/json body.');
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw errors.badRequest('Malformed JSON body.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw errors.badRequest('The JSON body must be an object.');
  }
  return parsed;
}
