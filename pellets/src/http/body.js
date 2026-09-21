/**
 * Request body helpers.
 *
 * Only small JSON/form bodies are buffered here. Attachments never pass through
 * this module: they are streamed straight to disk by the uploads route.
 */
import { errors } from '../domain/errors.js';
import { parseContentType } from './multipart.js';

/**
 * Buffer a request body with a hard size limit.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit?: number }} [options]
 * @returns {Promise<Buffer>}
 */
export function readBody(req, options = {}) {
  const limit = options.limit ?? 1024 * 1024; // 1 MB is plenty for JSON
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', fail);
      reject(error);
    };

    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(errors.payloadTooLarge('Request body is too large.'));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', fail);
  });
}

/**
 * Read and parse a JSON body.
 * An empty body yields `{}` so optional-payload endpoints stay simple.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit?: number }} [options]
 * @returns {Promise<any>}
 */
export async function readJson(req, options = {}) {
  const { type } = parseContentType(req.headers['content-type']);
  if (type && type !== 'application/json' && type !== 'text/plain') {
    throw errors.unsupportedMedia('Expected application/json.');
  }

  const raw = await readBody(req, options);
  if (raw.length === 0) return {};

  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw errors.badRequest('JSON body must be an object.');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'bad_request') throw error;
    throw errors.badRequest('Malformed JSON body.');
  }
}
