/**
 * Session middleware: the "Client Metadata" layer.
 *
 * The specification says that hitting the site must automatically tell the
 * server whether this is a new or a returning client. Two signals are used, in
 * this order:
 *
 *   1. The `pellets.sid` cookie. Authoritative when it points at a live
 *      session.
 *   2. A CLIENT METADATA FINGERPRINT: a SHA-256 over the stable request
 *      metadata a browser sends on every request (User-Agent, Accept-Language,
 *      Accept-Encoding, UA client hints and the peer address). This recovers
 *      the session of a client whose cookie was cleared or blocked.
 *
 * Neither signal is a security boundary, and nothing in Pellets pretends
 * otherwise: sessions grant no privileges beyond "this is the username and
 * colour you were using", plus the right to delete rooms you created.
 *
 * KNOWN TRADE-OFF: two cookie-less clients that are genuinely identical (same
 * browser build, same language, same address) fingerprint the same and will
 * share a session. Set `PELLETS_FINGERPRINT=0` to disable the fallback when
 * that matters, e.g. for load testing.
 */
import { createHash } from 'node:crypto';
import { parseCookies, serializeCookie } from '../../lib/cookies.js';

/** Metadata headers that take part in the fingerprint. */
const FINGERPRINT_HEADERS = [
  'user-agent',
  'accept-language',
  'accept-encoding',
  'sec-ch-ua',
  'sec-ch-ua-platform',
  'sec-ch-ua-mobile',
];

/**
 * Normalise the peer address: IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is folded
 * down so the same client looks the same over both stacks.
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 */
export function clientAddress(req, trustProxy = false) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = String(forwarded).split(',')[0].trim();
      if (first) return first.replace(/^::ffff:/i, '');
    }
  }
  const raw = req.socket?.remoteAddress || '';
  return String(raw).replace(/^::ffff:/i, '');
}

/**
 * @param {{ domain: object, config: object, logger?: object }} deps
 */
export function createSessionMiddleware({ domain, config, logger }) {
  const trustProxy = process.env.PELLETS_TRUST_PROXY === '1';
  const cookieName = config.session.cookieName;

  /**
   * Hash the client metadata of a request.
   * @param {import('node:http').IncomingMessage} req
   * @returns {string}
   */
  function fingerprint(req) {
    const parts = FINGERPRINT_HEADERS.map((header) => `${header}=${req.headers[header] || ''}`);
    parts.push(`addr=${clientAddress(req, trustProxy)}`);
    return createHash('sha256').update(parts.join('\n')).digest('hex');
  }

  /**
   * Resolve (or create) the session for a request, without touching the
   * response. Used by the WebSocket upgrade, which has no ServerResponse.
   * @param {import('node:http').IncomingMessage} req
   * @returns {{ session: object, created: boolean, matchedBy: string, fingerprint: string }}
   */
  function resolve(req) {
    const cookies = parseCookies(req.headers.cookie);
    const print = fingerprint(req);
    const result = domain.sessions.resolve({
      sessionId: cookies[cookieName] || null,
      fingerprint: print,
      userAgent: req.headers['user-agent'] || '',
    });

    // Keep the fingerprint current so a client whose browser updated can still
    // be recognised later without its cookie. Never steal another session's key.
    if (config.session.fingerprintEnabled && result.session.fingerprint !== print) {
      const owner = domain.sessions.getByFingerprint(print);
      if (!owner || owner.id === result.session.id) {
        domain.sessions.setFingerprint(result.session.id, print);
      }
    }

    return { ...result, fingerprint: print };
  }

  /**
   * Resolve the session and write the session cookie.
   *
   * The cookie is refreshed on every request so its lifetime slides forward and
   * so a fingerprint-recovered client gets a cookie back immediately.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function attach(req, res) {
    const result = resolve(req);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(cookieName, result.session.id, {
        maxAge: config.session.cookieMaxAgeSeconds,
        httpOnly: true, // the client reads its session through /api/session
        secure: config.protocol === 'https',
        sameSite: 'Lax',
        path: '/',
      }),
    );
    if (result.created) logger?.debug?.('new session', result.session.id, 'via', result.matchedBy);
    return result;
  }

  return { fingerprint, resolve, attach, cookieName };
}
