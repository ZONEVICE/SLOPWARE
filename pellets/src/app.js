/**
 * Application composition root.
 *
 * Builds one fully wired Pellets instance: event bus, in-memory stores, domain
 * services, HTTP routes, static file serving and the WebSocket gateway, all
 * inside a SINGLE Node process, exactly as the specification requires.
 *
 * `createApp` never listens on a port. `app.listen()` does, which is what lets
 * the test suite spin up a real server on an ephemeral port.
 *
 * WIRING ORDER (dependencies flow downwards, never back up):
 *   config -> bus + store -> domain -> transports (HTTP router, WS gateway)
 *   and the broadcasters close the loop: domain events -> WebSocket frames.
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { EventBus } from './lib/events.js';
import { createLogger } from './lib/logger.js';
import { createStore } from './store/index.js';
import { createDomain } from './domain/index.js';
import { createRouter } from './http/router.js';
import { registerRoutes } from './http/routes/index.js';
import { createStaticHandler, notFoundHtml } from './http/static.js';
import { createSessionMiddleware } from './http/middleware/session.js';
import { json, fail } from './http/respond.js';
import { createGateway } from './realtime/gateway.js';
import { attachBroadcasters } from './realtime/broadcasters.js';
import { generateCertificateFiles } from './lib/selfSignedCert.js';

/**
 * @param {{ config: object, logger?: object }} deps
 * @returns {Promise<object>} The application handle.
 */
export async function createApp({ config, logger = createLogger('pellets', { level: config.logLevel }) }) {
  const startedAt = Date.now();

  // --- Core --------------------------------------------------------------
  const bus = new EventBus({
    onError: (error, event) => logger.error(`event listener for "${event}" failed:`, error),
  });
  const store = createStore();
  const domain = createDomain({ store, bus, config, logger });

  // `uploads/` is the one directory that must exist before the first request.
  await domain.uploads.ensureDirectory();

  // --- HTTP --------------------------------------------------------------
  const sessionMiddleware = createSessionMiddleware({ domain, config, logger: logger.child('session') });
  const router = createRouter();
  registerRoutes(router, { domain, config, store, logger: logger.child('http'), startedAt });
  const staticHandler = createStaticHandler({ root: config.publicDir, logger: logger.child('static') });
  const httpLog = logger.child('http');

  /**
   * The single request entry point.
   *
   * Every request resolves a session first, which is what makes "open the site
   * and the server already knows whether you are new" true for the very first
   * byte of HTML.
   */
  async function handleRequest(req, res) {
    const started = Date.now();
    let url;
    try {
      // The Host header is attacker-controlled; only the path and query are used.
      url = new URL(req.url, `${config.protocol}://${req.headers.host || 'localhost'}`);
    } catch {
      url = new URL(req.url || '/', 'http://localhost');
    }

    const ctx = {
      req,
      res,
      url,
      params: {},
      session: null,
      domain,
      config,
      store,
      logger: httpLog,
      methodMismatch: false,
    };

    res.on('finish', () => {
      httpLog.debug(`${req.method} ${url.pathname} -> ${res.statusCode} (${Date.now() - started}ms)`);
    });

    try {
      ctx.session = sessionMiddleware.attach(req, res).session;

      if (await router.handle(ctx)) return;
      if (await staticHandler.handle(ctx)) return;

      const head = req.method === 'HEAD';
      if (ctx.methodMismatch) {
        json(res, 405, { error: { code: 'method_not_allowed', message: `${req.method} is not allowed here.` } }, { head });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        json(res, 404, { error: { code: 'not_found', message: 'Unknown endpoint.' } }, { head });
        return;
      }
      notFoundHtml(res, head);
    } catch (error) {
      fail(res, error, { logger: httpLog });
    }
  }

  // --- TLS ---------------------------------------------------------------
  /** @type {object|null} Certificate metadata, when running over HTTPS. */
  let tls = null;
  let server;

  if (config.protocol === 'https') {
    // A BRAND NEW certificate on every start, even when cert/ already holds
    // one. This is required behaviour, not an optimisation opportunity.
    tls = generateCertificateFiles({
      directory: config.certDir,
      keyType: config.tls.keyType,
      days: config.tls.days,
      commonName: config.tls.commonName,
      altNames: config.tls.altNames,
      logger,
    });
    logger.info(
      `generated a fresh self-signed certificate (${tls.generator}, ${tls.keyType}) at ${tls.certPath}`,
    );
    server = createHttpsServer({ key: tls.key, cert: tls.cert }, handleRequest);
  } else {
    server = createHttpServer(handleRequest);
  }

  // --- Realtime ----------------------------------------------------------
  const gateway = createGateway({ server, domain, config, sessionMiddleware, logger });
  server.on('upgrade', gateway.handleUpgrade);
  const detachBroadcasters = attachBroadcasters({ bus, gateway, domain, logger: logger.child('broadcast') });

  // A client that disappears mid-request must not take the process down.
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
    logger.debug('client error:', error.message);
  });

  let closed = false;

  const app = {
    config,
    logger,
    bus,
    store,
    domain,
    router,
    gateway,
    server,
    tls,
    startedAt,

    /**
     * Bind one specific port, once.
     *
     * Rejects with the raw listen error, `EADDRINUSE` included, so the caller
     * can decide whether to try the next port. A failed bind leaves the server
     * object reusable, which is what makes the retry loop below possible.
     *
     * @param {number} port
     * @param {string} host
     * @returns {Promise<{ port: number, host: string, url: string }>}
     */
    bind(port, host) {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          // With port 0 the OS picked one for us; read back what we actually got.
          const actualPort = typeof address === 'object' && address ? address.port : port;
          resolve({ port: actualPort, host, url: app.urlFor(actualPort, host) });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },

    /**
     * Start listening, walking upwards past ports that are already taken.
     *
     * If 8080 is busy it tries 8081, then 8082, and so on until it finds a free
     * one. This applies to the default port and to an explicit `--port` alike:
     * starting the server should never fail just because something else is
     * already listening.
     *
     * Only `EADDRINUSE` triggers a retry. Anything else (a privileged port, an
     * unreachable address) is a real configuration problem and is reported as
     * is, rather than being hidden behind dozens of pointless attempts.
     *
     * Port 0 is passed straight through: it already means "any free port".
     *
     * @param {{ port?: number, host?: string, attempts?: number }} [options]
     *   `attempts` of 1 disables the fallback and fails on a busy port.
     * @returns {Promise<{ port: number, host: string, url: string }>}
     */
    async listen({ port = config.port, host = config.host, attempts = config.portAttempts } = {}) {
      const requested = Number(port);
      // Port 0 lets the kernel choose, so there is nothing to walk past.
      const maxAttempts = requested === 0 ? 1 : Math.max(1, Math.floor(attempts) || 1);

      let candidate = requested;
      let lastError = null;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (candidate > 65535) break;
        try {
          const result = await app.bind(candidate, host);
          if (result.port !== requested && requested !== 0) {
            const skipped = result.port - requested;
            logger.warn(
              `port ${requested} is already in use; listening on ${result.port} instead ` +
                `(${skipped} port${skipped === 1 ? ' was' : 's were'} busy)`,
            );
          }
          return result;
        } catch (error) {
          if (error.code !== 'EADDRINUSE') throw error;
          lastError = error;
          logger.debug(`port ${candidate} is in use, trying ${candidate + 1}`);
          candidate += 1;
        }
      }

      const searched = candidate - 1;
      const error = new Error(
        `No free port found: ${requested}${searched > requested ? ` through ${searched}` : ''} ` +
          `are all in use. Pick another port with --port, or raise PELLETS_PORT_ATTEMPTS.`,
      );
      error.code = 'EADDRINUSE';
      error.cause = lastError;
      throw error;
    },

    /** Build a browsable URL, turning a wildcard bind into localhost. */
    urlFor(port = config.port, host = config.host) {
      const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
      const bracketed = displayHost.includes(':') ? `[${displayHost}]` : displayHost;
      return `${config.protocol}://${bracketed}:${port}`;
    },

    /** Stop everything and release every timer. Safe to call twice. */
    async close() {
      if (closed) return;
      closed = true;
      detachBroadcasters();
      await gateway.close();
      domain.stop();
      bus.clear();
      await new Promise((resolve) => server.close(() => resolve()));
      logger.debug('server closed');
    },
  };

  return app;
}
