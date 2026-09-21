/**
 * Cookie parsing and serialisation.
 *
 * The session cookie is the primary way a returning client is recognised; see
 * `src/http/middleware/session.js` for the metadata fallback used when the
 * cookie is missing.
 */

/**
 * Parse a raw `Cookie` header into a plain object.
 * Malformed pairs are skipped rather than throwing.
 * @param {string|undefined} header
 * @returns {Record<string,string>}
 */
export function parseCookies(header) {
  /** @type {Record<string,string>} */
  const out = {};
  if (!header || typeof header !== 'string') return out;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value; // Keep the raw value instead of dropping the cookie.
    }
  }
  return out;
}

/**
 * Build a `Set-Cookie` header value.
 * @param {string} name
 * @param {string} value
 * @param {{ maxAge?: number, path?: string, httpOnly?: boolean, secure?: boolean, sameSite?: 'Strict'|'Lax'|'None' }} [options]
 */
export function serializeCookie(name, value, options = {}) {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${options.path || '/'}`);
  if (typeof options.maxAge === 'number') {
    segments.push(`Max-Age=${Math.floor(options.maxAge)}`);
    segments.push(`Expires=${new Date(Date.now() + options.maxAge * 1000).toUTCString()}`);
  }
  if (options.httpOnly !== false) segments.push('HttpOnly');
  if (options.secure) segments.push('Secure');
  segments.push(`SameSite=${options.sameSite || 'Lax'}`);
  return segments.join('; ');
}
