/**
 * Composition root: builds one fully wired Reptile instance.
 *
 * WIRING ORDER (dependencies flow downwards, never back up):
 *
 *   config
 *     -> event bus, identity
 *       -> domain services: hosting, syncing, discovery, mode controller
 *            (the transports they need - the peer HTTP client and the network
 *             probe - are injected here, so the domain never imports them)
 *         -> HTTP: router + route plugins, control panel files, SSE hub
 *         -> reporters: event-bus subscribers (console messages)
 *
 * `createApp` never listens. `app.listen()` does, walking past busy ports,
 * which is also what lets the tests start instances on ephemeral ports.
 */
import http from 'node:http';
import https from 'node:https';
import { EventBus } from './lib/events.js';
import { generateCertificate } from './lib/cert.js';
import { listenWithFallback } from './lib/listen.js';
import { createLogger } from './lib/logger.js';
import { lanAddresses, normalizeAddress } from './lib/net.js';
import { createDiscovery } from './domain/discovery.js';
import { createHostingService } from './domain/hosting.js';
import { createIdentity } from './domain/identity.js';
import { createModeController } from './domain/modes.js';
import { PROTOCOL_VERSION } from './domain/protocol.js';
import { createSyncingService } from './domain/syncing.js';
import { createGuard } from './http/guard.js';
import { fail, json } from './http/respond.js';
import { createRouter } from './http/router.js';
import { registerRoutes } from './http/routes/index.js';
import { createSseHub } from './http/sse.js';
import { createStaticHandler, notFoundHtml } from './http/static.js';
import { createPeerClient } from './peer/client.js';
import { probe } from './peer/probe.js';
import { attachReporters } from './reporters/index.js';

/**
 * @param {{ config: object, logger?: object }} deps
 */
export async function createApp({ config, logger = createLogger('reptile', { level: config.logLevel }) }) {
  // --- Core ----------------------------------------------------------------
  const bus = new EventBus({ onError: (error, event) => logger.error(`listener for "${event}" failed:`, error) });
  const identity = createIdentity({ protocol: config.protocol, interfaces: config.interfaces });

  // --- Domain --------------------------------------------------------------
  const hosting = createHostingService({ bus, identity, config, logger: logger.child('host') });
  const syncing = createSyncingService({
    bus,
    identity,
    config,
    probe,
    peerFactory: (target) => createPeerClient({ ...target, identity, timing: config.timing }),
    logger: logger.child('sync'),
  });
  const discovery = createDiscovery({ config, identity, bus, probe, logger: logger.child('discovery') });
  const modes = createModeController({ bus, hosting, syncing });
  const detachReporters = attachReporters({ bus, logger, identity });

  /** Everything the control panel displays, in one object. */
  const snapshot = () => ({
    identity: identity.toJSON(),
    ui: { remote: config.allowRemoteUi },
    discovery: discovery.status(),
    mode: modes.mode,
    hosting: hosting.status(),
    syncing: syncing.status(),
    serverTime: Date.now(),
  });

  /** The public answer to `GET /api/ping`. */
  const pingInfo = () => ({
    app: 'reptile',
    version: identity.version,
    protocolVersion: PROTOCOL_VERSION,
    uuid: identity.uuid,
    hostname: identity.hostname,
    protocol: identity.protocol,
    port: identity.port,
    mode: modes.mode,
    hosting: hosting.pingInfo(),
  });

  // --- HTTP ----------------------------------------------------------------
  const sse = createSseHub({ bus, snapshot });
  const guard = createGuard({ allowRemote: config.allowRemoteUi, hostname: identity.hostname, interfaces: config.interfaces });
  const router = createRouter();
  registerRoutes(router, { modes, hosting, syncing, discovery, identity, sse, snapshot, pingInfo, config, logger: logger.child('http') });
  const statics = createStaticHandler({ root: config.publicDir });
  const httpLog = logger.child('http');

  /**
   * The single request entry point.
   * @param {boolean} expectContinue The client sent `Expect: 100-continue`.
   */
  async function handleRequest(req, res, expectContinue) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      url = new URL('/', 'http://localhost');
    }
    const matched = router.match(req.method, url.pathname);
    const route = matched?.route ?? null;
    const access = route?.options.access ?? 'ui';

    if (access === 'ui') {
      const denied = guard.checkUi(req);
      if (denied) {
        json(res, denied.status, { error: { code: denied.code, message: denied.message } }, { headers: expectContinue ? { Connection: 'close' } : {} });
        return;
      }
    }
    // Routes that do not decide about the body themselves get it right away.
    if (expectContinue && !route?.options.manualContinue) res.writeContinue();

    try {
      if (route) {
        await route.handler({
          req,
          res,
          url,
          params: matched.params,
          expectContinue,
          remoteAddress: normalizeAddress(req.socket.remoteAddress),
        });
        return;
      }
      const head = req.method === 'HEAD';
      if (matched?.methodMismatch) {
        json(res, 405, { error: { code: 'method_not_allowed', message: `${req.method} is not allowed here.` } }, { head });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        json(res, 404, { error: { code: 'not_found', message: 'Unknown endpoint.' } }, { head });
        return;
      }
      if (await statics.handle(req, res, url)) return;
      notFoundHtml(res, head);
    } catch (error) {
      fail(res, error, { logger: httpLog });
    }
  }

  // --- TLS -----------------------------------------------------------------
  let tls = null;
  let server;
  if (config.protocol === 'https') {
    // A BRAND NEW certificate on every start, replacing the previous one.
    tls = generateCertificate({
      directory: config.certDir,
      commonName: `${identity.hostname}.local`,
      dns: ['localhost', identity.hostname, `${identity.hostname}.local`],
      ip: ['127.0.0.1', '::1', ...lanAddresses(config.interfaces)],
    });
    identity.certificateFingerprint = tls.fingerprint256;
    logger.info(`generated a new self-signed certificate (${tls.keyType}) at ${tls.certPath}`);
    server = https.createServer({ key: tls.key, cert: tls.cert });
  } else {
    server = http.createServer();
  }

  server.on('request', (req, res) => handleRequest(req, res, false));
  server.on('checkContinue', (req, res) => handleRequest(req, res, true));
  // Scanners and browsers disconnect mid-request all the time; that is never
  // a reason to take the process down.
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
    httpLog.debug('client error:', error.message);
  });
  // Plain-HTTP probes against an HTTPS port fail their handshake: expected.
  server.on('tlsClientError', (error) => httpLog.debug('TLS client error:', error.message));

  let closed = false;

  const app = {
    config,
    logger,
    bus,
    identity,
    hosting,
    syncing,
    discovery,
    modes,
    router,
    server,
    tls,
    snapshot,
    pingInfo,

    /**
     * Listen, walking past busy ports, then start discovery.
     * @param {{ port?: number, host?: string, attempts?: number }} [options]
     * @returns {Promise<{ port: number, host: string, url: string }>}
     */
    async listen({ port = config.port, host = config.host, attempts = config.portAttempts } = {}) {
      const result = await listenWithFallback(server, { port, host, attempts, logger });
      identity.port = result.port;
      discovery.start();
      return { port: result.port, host, url: app.urlFor(result.port, host) };
    },

    /** A browsable URL; a wildcard bind becomes localhost. */
    urlFor(port = identity.port, host = config.host) {
      const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
      return `${config.protocol}://${shown.includes(':') ? `[${shown}]` : shown}:${port}`;
    },

    /** Stop everything. Safe to call twice. */
    async close() {
      if (closed) return;
      closed = true;
      await discovery.stop();
      await modes.shutdown();
      sse.close();
      detachReporters();
      await new Promise((resolve) => {
        server.close(() => resolve());
        // Event streams never end by themselves.
        server.closeAllConnections?.();
      });
      bus.clear();
    },
  };

  return app;
}
