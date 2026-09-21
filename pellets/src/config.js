/**
 * Configuration: command line flags, environment variables and defaults.
 *
 * Precedence (highest first): CLI flag -> environment variable -> default.
 *
 * Startup contract required by the specification:
 *   npm start                 -> HTTP
 *   npm start -- --http       -> HTTP
 *   npm start -- --https      -> fresh self-signed certificate, then HTTPS
 */
import { PUBLIC_DIR, UPLOADS_DIR, CERT_DIR, ROOT } from './lib/paths.js';

/** Human readable usage text printed by `--help`. */
export const USAGE = `
pellets - in-memory real-time chat

Usage:
  npm start                    Start over HTTP on port 8080
  npm start -- --http          Same as above, explicitly
  npm start -- --https         Mint a new self-signed certificate and serve HTTPS
  npm start -- --port 3000     Listen on a different port
  npm start -- --host 0.0.0.0  Bind a different interface (default: 0.0.0.0)

A busy port is not an error: if 8080 is taken the server uses 8081, then 8082,
and so on until it finds a free one. The port it settled on is printed at start.

Options:
  --http                 Serve plain HTTP (default)
  --https, --tls         Serve HTTPS with a certificate generated at startup
  -p, --port <number>    First TCP port to try (default: 8080, env PORT)
  -H, --host <address>   Bind address (default: 0.0.0.0, env HOST)
  --cert-days <number>   Validity of the generated certificate (default: 365)
  --key-type <ec|rsa>    Key algorithm for the certificate (default: ec)
  --log-level <level>    silent | error | warn | info | debug (default: info)
  -h, --help             Show this message

Environment:
  PORT, HOST, PELLETS_PROTOCOL, PELLETS_LOG_LEVEL, PELLETS_PORT_ATTEMPTS,
  PELLETS_MAX_UPLOAD_MB, PELLETS_MAX_MESSAGES_PER_ROOM,
  PELLETS_TLS_KEY_TYPE, PELLETS_TLS_DAYS, PELLETS_TLS_ALT_NAMES
`.trim();

/**
 * Parse an argv slice (without the node/script prefix).
 *
 * Supports `--flag`, `--key value` and `--key=value`. Unknown flags are
 * collected in `unknown` so the caller can warn instead of failing silently.
 *
 * @param {string[]} argv
 * @returns {{ protocol?: 'http'|'https', port?: number, host?: string, certDays?: number, keyType?: string, logLevel?: string, help?: boolean, unknown: string[] }}
 */
export function parseArgs(argv = []) {
  /** @type {any} */
  const out = { unknown: [] };

  const readValue = (index, inlineValue) => {
    if (inlineValue !== undefined) return { value: inlineValue, next: index };
    return { value: argv[index + 1], next: index + 1 };
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (typeof raw !== 'string') continue;
    const eq = raw.indexOf('=');
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);

    switch (flag) {
      case '--http':
        out.protocol = 'http';
        break;
      case '--https':
      case '--tls':
      case '--ssl':
        out.protocol = 'https';
        break;
      case '-p':
      case '--port': {
        const { value, next } = readValue(index, inline);
        out.port = Number.parseInt(value, 10);
        index = next;
        break;
      }
      case '-H':
      case '--host': {
        const { value, next } = readValue(index, inline);
        out.host = value;
        index = next;
        break;
      }
      case '--cert-days': {
        const { value, next } = readValue(index, inline);
        out.certDays = Number.parseInt(value, 10);
        index = next;
        break;
      }
      case '--key-type': {
        const { value, next } = readValue(index, inline);
        out.keyType = value;
        index = next;
        break;
      }
      case '--log-level': {
        const { value, next } = readValue(index, inline);
        out.logLevel = value;
        index = next;
        break;
      }
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        if (raw.startsWith('-')) out.unknown.push(raw);
        break;
    }
  }

  return out;
}

/** Read an integer environment variable, falling back when unset or invalid. */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Build the effective configuration object.
 *
 * @param {string[]} [argv] Raw CLI arguments (defaults to process.argv.slice(2)).
 * @param {object} [overrides] Direct overrides, used heavily by the test suite.
 * @returns {object} Frozen configuration.
 */
export function createConfig(argv = process.argv.slice(2), overrides = {}) {
  const args = parseArgs(argv);

  const protocol =
    overrides.protocol || args.protocol || (process.env.PELLETS_PROTOCOL === 'https' ? 'https' : 'http');

  const config = {
    /** 'http' | 'https' */
    protocol,
    host: overrides.host ?? args.host ?? process.env.HOST ?? '0.0.0.0',
    // Port 0 lets the OS pick a free port; the test suite relies on it.
    port: overrides.port ?? (Number.isFinite(args.port) ? args.port : envInt('PORT', 8080)),

    /**
     * How many consecutive ports to try before giving up.
     *
     * A busy port is not a reason to refuse to start: if 8080 is taken the
     * server moves to 8081, then 8082, and so on. Set this to 1 to disable the
     * walk and fail immediately when the requested port is unavailable.
     */
    portAttempts: overrides.portAttempts ?? envInt('PELLETS_PORT_ATTEMPTS', 64),

    help: Boolean(args.help),
    unknownArgs: args.unknown,
    logLevel: overrides.logLevel ?? args.logLevel ?? process.env.PELLETS_LOG_LEVEL ?? 'info',

    // --- Filesystem -------------------------------------------------------
    root: ROOT,
    publicDir: overrides.publicDir ?? PUBLIC_DIR,
    /** Uploaded attachments. The only thing that survives a restart. */
    uploadsDir: overrides.uploadsDir ?? process.env.PELLETS_UPLOADS_DIR ?? UPLOADS_DIR,
    /** Regenerated on every --https start. */
    certDir: overrides.certDir ?? process.env.PELLETS_CERT_DIR ?? CERT_DIR,

    // --- TLS --------------------------------------------------------------
    tls: {
      keyType: overrides.keyType ?? args.keyType ?? process.env.PELLETS_TLS_KEY_TYPE ?? 'ec',
      days: overrides.certDays ?? (Number.isFinite(args.certDays) ? args.certDays : envInt('PELLETS_TLS_DAYS', 365)),
      commonName: process.env.PELLETS_TLS_COMMON_NAME || 'pellets.local',
      /** Extra SANs, comma separated. Local interfaces are always included. */
      altNames: String(process.env.PELLETS_TLS_ALT_NAMES || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    },

    // --- Sessions ---------------------------------------------------------
    session: {
      cookieName: 'pellets.sid',
      /** 30 days. Sessions live in memory only; this bounds the cookie. */
      cookieMaxAgeSeconds: envInt('PELLETS_SESSION_DAYS', 30) * 24 * 60 * 60,
      /**
       * Client-metadata fingerprinting recognises a returning client whose
       * cookie was dropped. Disable with PELLETS_FINGERPRINT=0 when several
       * identical clients must stay distinct (e.g. automated load testing).
       */
      fingerprintEnabled: process.env.PELLETS_FINGERPRINT !== '0',
    },

    // --- Chat limits ------------------------------------------------------
    chat: {
      /**
       * Generous safety bound, not a content rule: the specification allows any
       * username a client wants, so nothing here filters or reserves names.
       */
      maxDisplayNameLength: envInt('PELLETS_MAX_NAME_LENGTH', 120),
      maxRoomNameLength: envInt('PELLETS_MAX_ROOM_NAME_LENGTH', 120),
      maxRoomTopicLength: envInt('PELLETS_MAX_ROOM_TOPIC_LENGTH', 240),
      maxMessageLength: envInt('PELLETS_MAX_MESSAGE_LENGTH', 4000),
      maxAttachmentsPerMessage: envInt('PELLETS_MAX_ATTACHMENTS', 10),
      /**
       * 0 = unlimited, which is the default because the specification says a
       * client joining a room must see every earlier message. Set a positive
       * number to cap memory growth on a long-lived server.
       */
      maxMessagesPerRoom: envInt('PELLETS_MAX_MESSAGES_PER_ROOM', 0),
      /** A typing flag expires on its own if the client goes quiet. */
      typingTimeoutMs: envInt('PELLETS_TYPING_TIMEOUT_MS', 6000),
    },

    // --- Uploads ----------------------------------------------------------
    uploads: {
      maxBytes: envInt('PELLETS_MAX_UPLOAD_MB', 256) * 1024 * 1024,
      /** Public URL prefix for stored files. */
      urlPrefix: '/uploads/',
    },

    // --- Realtime ---------------------------------------------------------
    realtime: {
      path: '/ws',
      /** Heartbeat interval; a connection that misses a beat is terminated. */
      heartbeatMs: envInt('PELLETS_WS_HEARTBEAT_MS', 30000),
      /**
       * How long a connection may go without sending ANY frame before it is
       * reclaimed. The browser answers protocol-level pings even when the page
       * is frozen in the back/forward cache, so this application-level timeout
       * is what actually detects a parked tab. The client pings every 20s.
       */
      idleTimeoutMs: envInt('PELLETS_WS_IDLE_TIMEOUT_MS', 70000),
      /** Largest accepted WebSocket frame. Binary payloads go over HTTP. */
      maxPayloadBytes: envInt('PELLETS_WS_MAX_PAYLOAD_KB', 512) * 1024,
    },
  };

  return Object.freeze(config);
}
