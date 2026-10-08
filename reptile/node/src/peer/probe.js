/**
 * Discovery probe: is there a Reptile instance at this address and port, and
 * which protocol does it speak?
 *
 * Step 1 is a bare TCP connect with a short timeout. On a LAN a closed port
 * answers immediately with a reset, and an address with nobody behind it
 * simply times out, so most of a sweep costs one SYN per target.
 *
 * Step 2, only for open ports, is `GET /api/ping`, first over this instance's
 * own protocol and then over the other one. An instance of the other protocol
 * still has to be FOUND so that the list can show it as incompatible, which is
 * what the specification asks for.
 */
import net from 'node:net';
import { httpRequest } from '../lib/httpRequest.js';
import { PATHS } from '../domain/protocol.js';

/**
 * Try to open a TCP connection.
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<'open'|'closed'|'timeout'|'unreachable'>}
 */
export function tcpCheck(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    socket.once('connect', () => finish('open'));
    socket.once('error', (error) => finish(error.code === 'ECONNREFUSED' ? 'closed' : 'unreachable'));
  });
}

/**
 * Validate a ping answer. Anything that is not clearly Reptile is ignored.
 * @param {any} data
 */
export function isReptilePing(data) {
  return (
    data !== null &&
    typeof data === 'object' &&
    data.app === 'reptile' &&
    typeof data.uuid === 'string' &&
    (data.protocol === 'http' || data.protocol === 'https')
  );
}

/**
 * `GET /api/ping` over one protocol.
 * @returns {Promise<object>} The ping body.
 */
export async function ping({ host, port, protocol, timeoutMs = 2000, signal }) {
  const response = await httpRequest({
    protocol,
    host,
    port,
    path: PATHS.ping,
    timeoutMs,
    signal,
    maxBytes: 64 * 1024,
    headers: { Connection: 'close' },
  });
  if (!isReptilePing(response.data)) {
    const error = new Error('Something answered, but it is not Reptile.');
    error.code = 'not_reptile';
    throw error;
  }
  return { ...response.data, fingerprint: response.fingerprint };
}

/** Errors after which the other protocol is worth a try. */
function suggestsOtherProtocol(error) {
  if (!error) return false;
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ABORT_ERR', 'not_reptile'].includes(error.code)) return false;
  // HTTP spoken to a TLS port gets reset; TLS spoken to an HTTP port fails the
  // handshake ("wrong version number"). Anything else odd: try once more.
  return true;
}

/**
 * Probe one address and port.
 *
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {'http'|'https'} options.preferProtocol Tried first.
 * @param {number} [options.connectTimeoutMs]
 * @param {number} [options.requestTimeoutMs]
 * @param {boolean} [options.skipTcpCheck] Go straight to HTTP (known instances).
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ status: 'found'|'closed'|'unreachable'|'not_reptile', info?: object, reachable: boolean }>}
 *   `reachable` tells the sweep that a machine answered at this address, even
 *   if nothing listens on this port.
 */
export async function probe({ host, port, preferProtocol, connectTimeoutMs = 700, requestTimeoutMs = 2000, skipTcpCheck = false, signal }) {
  if (!skipTcpCheck) {
    const tcp = await tcpCheck(host, port, connectTimeoutMs);
    if (tcp === 'closed') return { status: 'closed', reachable: true };
    if (tcp !== 'open') return { status: 'unreachable', reachable: false };
  }

  const order = preferProtocol === 'https' ? ['https', 'http'] : ['http', 'https'];
  let lastError = null;
  for (const protocol of order) {
    try {
      const info = await ping({ host, port, protocol, timeoutMs: requestTimeoutMs, signal });
      return { status: 'found', info: { ...info, address: host, port: info.port || port, protocol: info.protocol }, reachable: true };
    } catch (error) {
      lastError = error;
      if (!suggestsOtherProtocol(error)) break;
    }
  }
  if (lastError?.code === 'ECONNREFUSED') return { status: 'closed', reachable: true };
  if (lastError?.code === 'ETIMEDOUT' || lastError?.code === 'EHOSTUNREACH') return { status: 'unreachable', reachable: false };
  return { status: 'not_reptile', reachable: true };
}
