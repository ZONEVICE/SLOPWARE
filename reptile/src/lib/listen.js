/**
 * Port selection: bind the first free port at or after the requested one.
 *
 * A busy port is not an error. If 55667 is taken the server tries 55668, then
 * 55669, and so on. This applies to an explicit `--port` too: `--port 8080`
 * means "start at 8080", not "8080 or nothing". Running `npm start` twice
 * simply gives you two instances, which is also how two instances are tested
 * side by side on one machine.
 */

/**
 * Bind one specific port, once.
 *
 * Rejects with the raw listen error, `EADDRINUSE` included, so the caller can
 * decide whether to try the next port. A failed bind leaves the server object
 * reusable, which is what makes retrying on the same instance legal.
 *
 * @param {import('node:net').Server} server
 * @param {number} port
 * @param {string} host
 * @returns {Promise<number>} The port actually bound (differs from `port` only for 0).
 */
export function bindOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Start listening, walking upwards past ports that are already taken.
 *
 * Only `EADDRINUSE` triggers a retry. Anything else (a privileged port, an
 * address that is not on this machine) is a real configuration problem, and
 * incrementing the port would only hide it behind dozens of pointless attempts
 * and a misleading final error.
 *
 * Port 0 is passed straight through: it already means "any free port", and the
 * test suite relies on it.
 *
 * @param {import('node:net').Server} server
 * @param {{ port: number, host: string, attempts?: number, logger?: object }} options
 * @returns {Promise<{ port: number, host: string, requested: number }>}
 */
export async function listenWithFallback(server, { port, host, attempts = 64, logger }) {
  const requested = Number(port);
  const maxAttempts = requested === 0 ? 1 : Math.max(1, Math.floor(attempts) || 1);

  let candidate = requested;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (candidate > 65535) break;
    try {
      const bound = await bindOnce(server, candidate, host);
      if (bound !== requested && requested !== 0) {
        const skipped = bound - requested;
        logger?.warn?.(
          `port ${requested} is already in use; listening on ${bound} instead ` +
            `(${skipped} port${skipped === 1 ? ' was' : 's were'} busy)`,
        );
      }
      return { port: bound, host, requested };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      lastError = error;
      logger?.debug?.(`port ${candidate} is in use, trying ${candidate + 1}`);
      candidate += 1;
    }
  }

  const searched = candidate - 1;
  const error = new Error(
    `No free port found: ${requested}${searched > requested ? ` through ${searched}` : ''} ` +
      'are all in use. Pick another starting port with --port.',
  );
  error.code = 'EADDRINUSE';
  error.cause = lastError;
  throw error;
}
