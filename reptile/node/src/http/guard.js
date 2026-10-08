/**
 * Who may call what.
 *
 * One server answers two very different audiences on the same port:
 *
 *  - other Reptile instances, from anywhere on the network: `GET /api/ping`
 *    is public, and the peer API is protected by the PIN and then a bearer
 *    token;
 *  - the person at this computer, through the control panel.
 *
 * The control panel shows the PIN and can host any directory the process can
 * read. If it were reachable from the whole network, the PIN would protect
 * nothing, so by default it only answers requests coming from this machine
 * (`--remote-ui` lifts that). On top of that, it refuses requests that a web
 * page on another site could forge in the user's browser: a foreign Origin, a
 * cross-site fetch, a non-JSON body, or a Host header that is not this machine
 * (DNS rebinding).
 */
import { isIP } from 'node:net';
import { isLoopbackAddress, localAddresses, normalizeAddress } from '../lib/net.js';

/** Host header without the port; handles "[::1]:55667". */
function hostOnly(header) {
  const value = String(header || '').trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(1, value.indexOf(']'));
  const colon = value.lastIndexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

/**
 * @param {{ allowRemote: boolean, hostname: string, interfaces?: () => object }} options
 */
export function createGuard({ allowRemote, hostname, interfaces }) {
  const names = new Set(['localhost', String(hostname).toLowerCase(), `${String(hostname).toLowerCase()}.local`]);
  let ownCache = { at: 0, set: new Set() };
  const own = () => {
    // Addresses can change (a laptop switching networks); re-read now and then.
    if (Date.now() - ownCache.at > 10_000) ownCache = { at: Date.now(), set: localAddresses(interfaces) };
    return ownCache.set;
  };

  return {
    /**
     * Check a request for the control panel or its API.
     * @param {import('node:http').IncomingMessage} req
     * @returns {null|{ status: number, code: string, message: string }} null when allowed.
     */
    checkUi(req) {
      const remote = normalizeAddress(req.socket.remoteAddress);
      if (!allowRemote && !isLoopbackAddress(remote) && !own().has(remote)) {
        return {
          status: 403,
          code: 'remote_ui_disabled',
          message:
            'The Reptile control panel only accepts connections from the computer it runs on. ' +
            'Open it there, or restart Reptile with --remote-ui to allow other computers.',
        };
      }

      const host = hostOnly(req.headers.host);
      if (host && !isIP(host) && !names.has(host)) {
        return { status: 403, code: 'bad_host', message: `Unexpected Host header "${host}".` };
      }

      const method = req.method.toUpperCase();
      if (method === 'GET' || method === 'HEAD') return null;

      const site = String(req.headers['sec-fetch-site'] || '');
      if (site && site !== 'same-origin' && site !== 'none') {
        return { status: 403, code: 'cross_site', message: 'Cross-site requests are not accepted.' };
      }
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        try {
          if (new URL(origin).host.toLowerCase() !== String(req.headers.host || '').toLowerCase()) {
            return { status: 403, code: 'cross_site', message: 'Cross-origin requests are not accepted.' };
          }
        } catch {
          return { status: 403, code: 'cross_site', message: 'Malformed Origin header.' };
        }
      }
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (method !== 'DELETE' && type !== 'application/json') {
        return { status: 415, code: 'unsupported_media_type', message: 'Expected an application/json body.' };
      }
      return null;
    },
  };
}
