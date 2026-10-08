/**
 * Outgoing HTTP(S) requests between instances, on `node:http` / `node:https`.
 *
 * Why not `fetch`: it offers no way to accept a self-signed certificate or to
 * read the certificate the peer presented, and both are needed. Every HTTPS
 * instance generates its own certificate at startup, so peers connect with
 * `rejectUnauthorized: false` and then pin the SHA-256 fingerprint they saw
 * when the session was opened (`fingerprint` below). A different certificate
 * later in the same session means a different server, and the request fails.
 */
import http from 'node:http';
import https from 'node:https';

/** A failed request: transport error, timeout, or an error status from the peer. */
export class RequestError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, cause?: unknown, details?: any }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'RequestError';
    /** HTTP status, or 0 when the request never got a response. */
    this.status = info.status ?? 0;
    /** Machine code: the peer's error code, or a transport code such as ECONNREFUSED. */
    this.code = info.code ?? 'request_failed';
    this.details = info.details;
    if (info.cause) this.cause = info.cause;
  }
}

/** Read a whole response body, refusing to buffer more than `maxBytes`. */
function readAll(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy();
        reject(new RequestError('Response is too large.', { code: 'response_too_large' }));
        return;
      }
      chunks.push(chunk);
    });
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

/** SHA-256 fingerprint of the certificate on a TLS socket, or null. */
export function peerFingerprint(socket) {
  try {
    const certificate = socket?.getPeerCertificate?.();
    return certificate?.fingerprint256 || null;
  } catch {
    return null;
  }
}

/**
 * Perform one request.
 *
 * @param {object} options
 * @param {'http'|'https'} options.protocol
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.path Path plus query string.
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {any} [options.json] Sent as an `application/json` body.
 * @param {Buffer|string} [options.body]
 * @param {import('node:stream').Readable} [options.bodyStream] Streamed request body.
 * @param {boolean} [options.expectContinue] Send `Expect: 100-continue` and
 *   stream `bodyStream` only once the server agrees. A refused upload then
 *   costs one round trip instead of the whole file.
 * @param {number} [options.timeoutMs] Socket inactivity timeout (not a total deadline).
 * @param {import('node:http').Agent} [options.agent]
 * @param {AbortSignal} [options.signal]
 * @param {'json'|'buffer'|'stream'|'none'} [options.responseType]
 * @param {string|null} [options.fingerprint] Expected certificate fingerprint.
 * @param {number} [options.maxBytes] Limit for buffered responses.
 * @returns {Promise<{ status: number, headers: object, data?: any, stream?: import('node:http').IncomingMessage, fingerprint: string|null }>}
 */
export function httpRequest(options) {
  const {
    protocol = 'http',
    host,
    port,
    path,
    method = 'GET',
    headers = {},
    json,
    body,
    bodyStream,
    expectContinue = false,
    timeoutMs = 10_000,
    agent,
    signal,
    responseType = 'json',
    fingerprint = null,
    maxBytes = 64 * 1024 * 1024,
  } = options;

  const transport = protocol === 'https' ? https : http;
  const finalHeaders = { Accept: 'application/json', ...headers };
  let payload = null;
  if (json !== undefined) {
    payload = Buffer.from(JSON.stringify(json), 'utf8');
    finalHeaders['Content-Type'] = 'application/json';
  } else if (body !== undefined) {
    payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  }
  if (payload) finalHeaders['Content-Length'] = String(payload.length);
  if (bodyStream && expectContinue) finalHeaders.Expect = '100-continue';

  return new Promise((resolve, reject) => {
    // Already aborted: do not even create the request. (Creating and then
    // destroying it before its 'error' listener exists would turn the abort
    // into an uncaught exception.)
    if (signal?.aborted) {
      reject(new RequestError('Request aborted.', { code: 'ABORT_ERR' }));
      return;
    }
    let settled = false;
    let piped = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };

    const req = transport.request({
      host,
      port,
      path,
      method,
      headers: finalHeaders,
      agent,
      // Peers use self-signed certificates by design; see the file comment.
      ...(protocol === 'https' ? { rejectUnauthorized: false } : {}),
    });

    const onAbort = () => {
      const error = new RequestError('Request aborted.', { code: 'ABORT_ERR' });
      req.destroy(error);
      settle(reject, error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    req.setTimeout(timeoutMs, () => {
      const error = new RequestError(`No answer from ${host}:${port} within ${timeoutMs} ms.`, { code: 'ETIMEDOUT' });
      req.destroy(error);
      settle(reject, error);
    });

    req.on('error', (error) => {
      if (error instanceof RequestError) {
        settle(reject, error);
        return;
      }
      settle(
        reject,
        new RequestError(error.message || 'Request failed.', { code: error.code || 'request_failed', cause: error }),
      );
    });

    req.on('response', async (res) => {
      // A response destroyed after the promise settled (an abort, a dropped
      // connection) must never become an uncaught 'error' event. Consumers
      // attach their own listeners on top of this one.
      res.on('error', () => {});
      if (bodyStream && expectContinue && !piped) {
        // The server answered without asking for the body (refused it, or
        // already had the file). Never send it, and release the file handle.
        bodyStream.destroy();
        res.once('end', () => req.destroy());
      }
      const seen = protocol === 'https' ? peerFingerprint(res.socket) : null;
      if (fingerprint && seen && seen !== fingerprint) {
        res.destroy();
        req.destroy();
        settle(
          reject,
          new RequestError('The peer presented a different certificate than when the session started.', {
            code: 'certificate_changed',
          }),
        );
        return;
      }

      try {
        if (res.statusCode >= 400) {
          const raw = await readAll(res, 1024 * 1024).catch(() => Buffer.alloc(0));
          let parsed = null;
          try {
            parsed = raw.length ? JSON.parse(raw.toString('utf8')) : null;
          } catch {
            parsed = null;
          }
          const error = parsed?.error;
          // A streamed upload the peer refused early must stop sending now.
          if (bodyStream) {
            bodyStream.unpipe?.(req);
            bodyStream.destroy?.();
            req.destroy();
          }
          settle(
            reject,
            new RequestError(error?.message || `HTTP ${res.statusCode}`, {
              status: res.statusCode,
              code: error?.code || `http_${res.statusCode}`,
              details: error?.details,
            }),
          );
          return;
        }

        const base = { status: res.statusCode, headers: res.headers, fingerprint: seen };
        if (responseType === 'stream') {
          settle(resolve, { ...base, stream: res });
          return;
        }
        if (responseType === 'none') {
          res.resume();
          res.once('end', () => settle(resolve, base));
          res.once('error', (error) => settle(reject, error));
          return;
        }
        const raw = await readAll(res, maxBytes);
        if (responseType === 'buffer') {
          settle(resolve, { ...base, data: raw });
          return;
        }
        let data = null;
        if (raw.length) {
          try {
            data = JSON.parse(raw.toString('utf8'));
          } catch {
            settle(reject, new RequestError('The peer sent malformed JSON.', { status: res.statusCode, code: 'bad_json' }));
            return;
          }
        }
        settle(resolve, { ...base, data });
      } catch (error) {
        settle(reject, error instanceof RequestError ? error : new RequestError(error.message, { cause: error }));
      }
    });

    if (bodyStream) {
      bodyStream.once('error', (error) => {
        req.destroy(error);
        settle(reject, new RequestError(`Could not read the local file: ${error.message}`, { code: 'local_read_failed', cause: error }));
      });
      if (expectContinue) {
        req.once('continue', () => {
          if (settled) return;
          piped = true;
          bodyStream.pipe(req);
        });
        // Headers must leave now: nothing else will flush them before 100.
        req.flushHeaders();
      } else {
        bodyStream.pipe(req);
      }
    } else if (payload) {
      req.end(payload);
    } else {
      req.end();
    }
  });
}
