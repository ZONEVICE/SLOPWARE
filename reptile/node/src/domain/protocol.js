/**
 * The instance-to-instance protocol: names shared by the host side
 * (`src/http/routes/peer.routes.js`), the syncing side (`src/peer/client.js`)
 * and the services in this directory.
 *
 * Transport summary (everything is plain HTTP or HTTPS):
 *
 *   GET  /api/ping               who are you? (public, used by discovery)
 *   POST /api/peer/connect       PIN in, bearer token out
 *   GET  /api/peer/stream        long-lived NDJSON: host -> peer events
 *   GET  /api/peer/manifest      every shared entry with size and mtime
 *   POST /api/peer/hashes        SHA-256 of selected files
 *   GET  /api/peer/file?path=    download one file
 *   PUT  /api/peer/file?path=    upload one file (raw body)
 *   POST /api/peer/ops           mkdir / unlink / rmdir / rename, in order
 *   POST /api/peer/heartbeat     "still here", plus the peer's sync phase
 *   POST /api/peer/disconnect    leaving on purpose
 *
 * The peer always initiates, so the host never needs to reach the peer. Live
 * changes flow host -> peer over the stream and peer -> host as requests.
 */

export const PROTOCOL_VERSION = 1;

export const PATHS = Object.freeze({
  ping: '/api/ping',
  connect: '/api/peer/connect',
  stream: '/api/peer/stream',
  manifest: '/api/peer/manifest',
  hashes: '/api/peer/hashes',
  file: '/api/peer/file',
  ops: '/api/peer/ops',
  heartbeat: '/api/peer/heartbeat',
  disconnect: '/api/peer/disconnect',
});

/** Operations that travel between instances. `write` is always a file transfer. */
export const OPS = Object.freeze(['mkdir', 'write', 'unlink', 'rmdir', 'rename']);

/** Messages on the host -> peer stream. */
export const STREAM = Object.freeze({
  HELLO: 'hello',
  OPS: 'ops',
  HEARTBEAT: 'heartbeat',
  BYE: 'bye',
});

/** Why a host ended a session. The peer decides what to do from this. */
export const BYE = Object.freeze({
  /** The host changed the PIN: ask the user for the new one. */
  PIN_CHANGED: 'pin_changed',
  /** The host stopped hosting: the session is over for good. */
  HOST_STOPPED: 'host_stopped',
  /** The same peer opened a newer session; this one is obsolete. */
  REPLACED: 'replaced',
  /** The host stopped hearing from the peer. */
  TIMEOUT: 'timeout',
});

/** Upload metadata travels in headers so the body can be the raw file. */
export const HEADERS = Object.freeze({
  mtime: 'x-reptile-mtime',
  size: 'x-reptile-size',
  baseSize: 'x-reptile-base-size',
  baseMtime: 'x-reptile-base-mtime',
});

/** Timings, in milliseconds. */
export const TIMING = Object.freeze({
  /** Host -> peer heartbeat line on the stream. */
  streamHeartbeatMs: 5000,
  /** A peer that heard nothing for this long treats the stream as dead. */
  streamSilenceMs: 16000,
  /** Peer -> host heartbeat request. */
  peerHeartbeatMs: 5000,
  /** A host that heard nothing from its peer for this long ends the session. */
  peerSilenceMs: 20000,
});
