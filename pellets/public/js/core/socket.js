/**
 * WebSocket client.
 *
 * Responsibilities:
 *  - Pick `ws://` or `wss://` automatically from the page's own protocol, so
 *    the same build works over HTTP and HTTPS with no configuration.
 *  - Reconnect with exponential backoff and announce connection state.
 *  - Provide `send` (fire and forget) and `request` (awaits the matching reply).
 *
 * Frames in and out are the envelopes documented in
 * `src/realtime/protocol.js`.
 */

/** @type {Map<string, Set<Function>>} frame type -> handlers */
const frameListeners = new Map();
/** Handlers that receive every frame. */
const anyListeners = new Set();

let socket = null;
let sequence = 0;
let attempt = 0;
let reconnectTimer = null;
let manuallyClosed = false;

/** @type {Map<string, { resolve: Function, reject: Function, timer: any }>} */
const pending = new Map();
/** Frames buffered while the socket is down, flushed on reconnect. */
const outbox = [];

let onStateChange = () => {};
let lifecycleInstalled = false;

/** Build the WebSocket URL from the current page location. */
export function socketUrl(path = '/ws') {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}${path}`;
}

/**
 * Subscribe to a frame type. Pass '*' to receive everything.
 * @param {string} type
 * @param {(payload: any, frame: object) => void} handler
 * @returns {() => void} Unsubscribe.
 */
export function onFrame(type, handler) {
  if (type === '*') {
    anyListeners.add(handler);
    return () => anyListeners.delete(handler);
  }
  let set = frameListeners.get(type);
  if (!set) {
    set = new Set();
    frameListeners.set(type, set);
  }
  set.add(handler);
  return () => {
    const current = frameListeners.get(type);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) frameListeners.delete(type);
  };
}

function dispatch(frame) {
  // A reply resolves its pending request before anything else sees it.
  if (frame.replyTo && pending.has(frame.replyTo)) {
    const entry = pending.get(frame.replyTo);
    pending.delete(frame.replyTo);
    clearTimeout(entry.timer);
    if (frame.type === 'error') entry.reject(Object.assign(new Error(frame.payload.message), frame.payload));
    else entry.resolve(frame.payload);
  }

  for (const handler of anyListeners) safely(handler, frame.payload, frame);
  const set = frameListeners.get(frame.type);
  if (!set) return;
  for (const handler of Array.from(set)) safely(handler, frame.payload, frame);
}

function safely(handler, payload, frame) {
  try {
    handler(payload, frame);
  } catch (error) {
    console.error(`[socket] handler for "${frame.type}" failed`, error);
  }
}

/**
 * Release the socket when the page goes away, and take it back when the page
 * comes back.
 *
 * THIS MATTERS MORE THAN IT LOOKS. A browser puts a navigated-away page into
 * the back/forward cache with its WebSocket still open, so without this the
 * server keeps counting a user who already left a room - and keeps counting
 * every page they visited - until the 30 second heartbeat notices. `pagehide`
 * fires before the freeze, which is the last moment JavaScript can run.
 *
 * @param {string} path
 */
function installLifecycleHandlers(path) {
  if (lifecycleInstalled || typeof window === 'undefined') return;
  lifecycleInstalled = true;

  window.addEventListener('pagehide', () => {
    if (!socket) return;
    manuallyClosed = true; // do not reconnect a page that is going away
    try {
      // Only 1000 and 3000-4999 are legal from WebSocket.close(); anything
      // else (1001 "going away", tempting as it looks) throws InvalidAccessError
      // and would leave the socket open.
      socket.close(1000, 'page hidden');
    } catch {
      /* the page is being torn down anyway */
    }
    socket = null;
  });

  window.addEventListener('pageshow', (event) => {
    // Only a bfcache restore needs this; a fresh load connects on boot.
    if (event.persisted) connect({ path });
  });
}

/**
 * Open the connection. Idempotent: calling it twice keeps one socket.
 * @param {{ path?: string, onState?: (status: string) => void }} [options]
 */
export function connect(options = {}) {
  if (options.onState) onStateChange = options.onState;
  const path = options.path || '/ws';
  manuallyClosed = false;
  installLifecycleHandlers(path);

  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  onStateChange('connecting');
  socket = new WebSocket(socketUrl(path));

  socket.addEventListener('open', () => {
    attempt = 0;
    onStateChange('online');
    // Flush anything composed while offline.
    while (outbox.length) socket.send(outbox.shift());
    // A synthetic frame, not part of the wire protocol: views subscribe to it
    // to re-join their room, because a reconnect loses server-side presence.
    dispatch({ type: 'socket:open', payload: {} });
  });

  socket.addEventListener('message', (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      console.warn('[socket] dropped a non-JSON frame');
      return;
    }
    if (!frame || typeof frame.type !== 'string') return;
    dispatch({ type: frame.type, payload: frame.payload || {}, replyTo: frame.replyTo });
  });

  socket.addEventListener('close', () => {
    socket = null;
    if (manuallyClosed) {
      onStateChange('offline');
      return;
    }
    onStateChange('offline');
    scheduleReconnect(path);
  });

  socket.addEventListener('error', () => {
    // 'close' always follows; nothing to do here but avoid an unhandled event.
  });
}

/** Exponential backoff with jitter, capped at 8 seconds. */
function scheduleReconnect(path) {
  if (reconnectTimer) return;
  attempt += 1;
  const base = Math.min(500 * 2 ** (attempt - 1), 8000);
  const delay = base + Math.random() * 300;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect({ path });
  }, delay);
}

/**
 * Send a frame. When the socket is down the frame is queued and flushed on the
 * next successful connection.
 * @param {string} type
 * @param {object} [payload]
 * @param {string} [id]
 */
export function send(type, payload = {}, id = undefined) {
  const data = JSON.stringify(id ? { type, id, payload } : { type, payload });
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(data);
    return true;
  }
  // Keep the queue bounded; a long outage should not grow without limit.
  if (outbox.length < 64) outbox.push(data);
  return false;
}

/**
 * Send a frame and wait for its reply.
 * @param {string} type
 * @param {object} [payload]
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<any>} The reply payload, or a rejection carrying `code`.
 */
export function request(type, payload = {}, options = {}) {
  sequence += 1;
  const id = `r${sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('The server did not answer in time.'), { code: 'timeout' }));
    }, options.timeout || 12000);
    pending.set(id, { resolve, reject, timer });
    send(type, payload, id);
  });
}

/** Close for good; no reconnection will be attempted. */
export function close() {
  manuallyClosed = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) socket.close(1000, 'client closing');
  socket = null;
}

/** Current readiness, for views that need to know before sending. */
export function isOpen() {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

/**
 * Application-level keepalive.
 *
 * Protocol-level ping/pong is answered by the browser's network stack even for
 * a page whose JavaScript is frozen in the back/forward cache, so it cannot
 * tell a live client from a parked one. This interval runs in the page itself:
 * when the page stops running, the pings stop and the server reclaims the
 * connection. See `realtime.idleTimeoutMs` on the server side.
 */
const KEEPALIVE_MS = 20000;
setInterval(() => {
  if (isOpen()) send('ping');
}, KEEPALIVE_MS);
