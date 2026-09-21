/**
 * WebSocket gateway.
 *
 * Owns the `ws` server, the connection table and the frame dispatch loop. It is
 * the only module in the project that imports `ws`, which keeps the single
 * allowed dependency in exactly one place.
 *
 * Responsibilities:
 *  - Resolve the session during the HTTP upgrade (cookies travel with it), and
 *    set the session cookie on the 101 response when the client had none.
 *  - Dispatch frames to the handler registry.
 *  - Provide the fan-out primitives the broadcasters use.
 *  - Keep connections honest with a ping/pong heartbeat.
 */
import { WebSocketServer, WebSocket } from 'ws';
import { token } from '../lib/ids.js';
import { serializeCookie } from '../lib/cookies.js';
import { parseFrame, frame, S2C } from './protocol.js';
import { createHandlerRegistry } from './registry.js';
import { registerHandlers } from './handlers/index.js';
import { toAppError, errors } from '../domain/errors.js';

/** Where the upgrade handler stashes the resolved session for later hooks. */
const RESOLVED_SESSION = Symbol('pellets.session');

/**
 * @param {object} deps
 * @param {import('node:http').Server} deps.server
 * @param {object} deps.domain
 * @param {object} deps.config
 * @param {object} deps.sessionMiddleware
 * @param {object} [deps.logger]
 */
export function createGateway({ server, domain, config, sessionMiddleware, logger }) {
  const log = logger?.child?.('ws') || logger;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.realtime.maxPayloadBytes,
    // Text frames are tiny; compression would cost more than it saves.
    perMessageDeflate: false,
  });

  /** @type {Map<string, object>} connection id -> connection */
  const connections = new Map();

  const registry = createHandlerRegistry();
  registerHandlers(registry, { domain, config, logger: log });

  // ---------------------------------------------------------------------
  // Handshake
  // ---------------------------------------------------------------------

  /**
   * Set the session cookie on the 101 response. `ws` emits `headers` right
   * before writing the handshake, which is the only chance to do this.
   */
  wss.on('headers', (headers, req) => {
    const resolved = req[RESOLVED_SESSION];
    if (!resolved) return;
    headers.push(
      `Set-Cookie: ${serializeCookie(config.session.cookieName, resolved.session.id, {
        maxAge: config.session.cookieMaxAgeSeconds,
        httpOnly: true,
        secure: config.protocol === 'https',
        sameSite: 'Lax',
        path: '/',
      })}`,
    );
  });

  /**
   * HTTP upgrade handler. Attached by `createServer`.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  function handleUpgrade(req, socket, head) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== config.realtime.path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Same "Client Metadata" resolution the HTTP layer performs, so a socket
    // and a page load always land on the same session.
    req[RESOLVED_SESSION] = sessionMiddleware.resolve(req);

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }

  // ---------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------

  /** Wrap a raw socket in the connection object handlers receive. */
  function createConnection(ws, sessionId) {
    const id = token(9);
    const connection = {
      id,
      ws,
      sessionId,
      isAlive: true,
      /** Updated on every inbound frame; drives the idle timeout. */
      lastFrameAt: Date.now(),
      /**
       * @param {string} type
       * @param {any} [payload]
       * @param {string} [replyTo]
       */
      send(type, payload = {}, replyTo = undefined) {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(frame(type, payload, replyTo)));
        return true;
      },
      /** @param {unknown} error */
      sendError(error, replyTo = undefined) {
        const appError = toAppError(error);
        if (appError.status >= 500) log?.error?.('handler failed:', appError.cause || appError);
        return connection.send(S2C.ERROR, appError.toJSON(), replyTo);
      },
    };
    return connection;
  }

  wss.on('connection', (ws, req) => {
    const resolved = req[RESOLVED_SESSION];
    if (!resolved) {
      ws.close(1011, 'Session could not be resolved');
      return;
    }

    const connection = createConnection(ws, resolved.session.id);
    connections.set(connection.id, connection);
    domain.presence.connect(connection.id, connection.sessionId);
    log?.debug?.('open', connection.id, 'session', connection.sessionId);

    // Opening frames: who you are, and what rooms exist. With these two the
    // client can render Home without a single HTTP request.
    connection.send(S2C.SESSION_STATE, { session: domain.sessions.toPrivateView(resolved.session) });
    connection.send(S2C.ROOMS_STATE, { rooms: domain.rooms.list() });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        connection.sendError(errors.badRequest('Binary frames are not accepted; upload files over HTTP.'));
        return;
      }
      dispatch(connection, raw);
    });

    ws.on('pong', () => {
      connection.isAlive = true;
    });

    ws.on('error', (error) => {
      log?.debug?.('socket error', connection.id, error.message);
    });

    ws.on('close', () => {
      connections.delete(connection.id);
      const result = domain.presence.disconnect(connection.id);
      // Only clear typing where this user genuinely left; another tab may still
      // be open in the same room.
      for (const roomId of result.sessionLeftRooms) {
        domain.typing.clear(roomId, connection.sessionId);
      }
      log?.debug?.('close', connection.id);
    });
  });

  /**
   * Parse and route one incoming frame.
   * @param {object} connection
   * @param {Buffer|string} raw
   */
  async function dispatch(connection, raw) {
    connection.lastFrameAt = Date.now();
    const parsed = parseFrame(raw);
    if (!parsed.ok) {
      connection.sendError(errors.badRequest(parsed.reason));
      return;
    }

    const handler = registry.get(parsed.type);
    if (!handler) {
      connection.sendError(errors.badRequest(`Unknown frame type "${parsed.type}".`), parsed.id);
      return;
    }

    // Always read the session fresh: a profile change in another tab must be
    // visible here immediately, and the record may have been replaced.
    const session = domain.sessions.get(connection.sessionId);
    if (!session) {
      connection.sendError(errors.notFound('Session no longer exists. Reload the page.'), parsed.id);
      return;
    }

    try {
      const result = await handler({
        connection,
        session,
        payload: parsed.payload,
        frameId: parsed.id,
        domain,
        config,
        gateway,
        logger: log,
      });

      // Handlers that send their own reply return undefined. Handlers that
      // return a value get it wrapped in an `ack`, so a client using the
      // request/reply helper is never left waiting.
      if (result !== undefined && parsed.id) {
        connection.send(S2C.ACK, result, parsed.id);
      }
    } catch (error) {
      connection.sendError(error, parsed.id);
    }
  }

  // ---------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const connection of connections.values()) {
      // A page parked in the browser's back/forward cache still answers
      // protocol-level pings, so silence at the APPLICATION level is the only
      // reliable signal that nobody is home.
      if (now - connection.lastFrameAt > config.realtime.idleTimeoutMs) {
        log?.debug?.('idle timeout', connection.id);
        connection.ws.terminate();
        continue;
      }
      if (!connection.isAlive) {
        log?.debug?.('heartbeat timeout', connection.id);
        connection.ws.terminate();
        continue;
      }
      connection.isAlive = false;
      try {
        connection.ws.ping();
      } catch {
        connection.ws.terminate();
      }
    }
  }, config.realtime.heartbeatMs);
  // A heartbeat must never be the reason the process stays alive.
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  // ---------------------------------------------------------------------
  // Fan-out primitives used by the broadcasters
  // ---------------------------------------------------------------------

  const gateway = {
    wss,
    connections,
    registry,
    handleUpgrade,

    /** Send to every open connection. */
    broadcast(type, payload) {
      const data = JSON.stringify(frame(type, payload));
      let sent = 0;
      for (const connection of connections.values()) {
        if (connection.ws.readyState !== WebSocket.OPEN) continue;
        connection.ws.send(data);
        sent += 1;
      }
      return sent;
    },

    /**
     * Send to every connection inside a room.
     * @param {{ exceptConnectionId?: string }} [options]
     */
    toRoom(roomId, type, payload, options = {}) {
      const data = JSON.stringify(frame(type, payload));
      let sent = 0;
      for (const connectionId of domain.presence.connectionsInRoom(roomId)) {
        if (options.exceptConnectionId && connectionId === options.exceptConnectionId) continue;
        const connection = connections.get(connectionId);
        if (!connection || connection.ws.readyState !== WebSocket.OPEN) continue;
        connection.ws.send(data);
        sent += 1;
      }
      return sent;
    },

    /** Send to every tab of one session. */
    toSession(sessionId, type, payload) {
      const data = JSON.stringify(frame(type, payload));
      let sent = 0;
      for (const connectionId of domain.presence.connectionsOfSession(sessionId)) {
        const connection = connections.get(connectionId);
        if (!connection || connection.ws.readyState !== WebSocket.OPEN) continue;
        connection.ws.send(data);
        sent += 1;
      }
      return sent;
    },

    /** Close every socket and stop the heartbeat. */
    async close() {
      clearInterval(heartbeat);
      for (const connection of connections.values()) {
        try {
          connection.ws.close(1001, 'Server shutting down');
        } catch {
          connection.ws.terminate();
        }
      }
      connections.clear();
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  };

  return gateway;
}
