/**
 * Configuration: command-line flags, environment variables and defaults.
 *
 * Precedence (highest first): explicit overrides (tests) -> CLI flag ->
 * environment variable -> default.
 *
 * Startup contract required by the specification:
 *   npm start                     -> HTTP on port 55667 (or the next free one)
 *   npm start -- --http           -> the same, explicitly
 *   npm start -- --https          -> a fresh self-signed certificate, then HTTPS
 *   npm start -- --port 8080      -> start at 8080, walking up if it is busy
 */
import { parseHostSpec, parsePortSpec } from './lib/net.js';
import { CERT_DIR, PUBLIC_DIR } from './lib/paths.js';

/** Default port. Discovery scans it and the ports that follow it. */
export const DEFAULT_PORT = 55667;

/** How many ports, starting at the default, discovery scans on each host. */
export const SCAN_PORT_COUNT = 20;

export const USAGE = `
reptile - real-time two-way directory sync between two computers on a LAN

Usage:
  npm start                         HTTP, starting at port ${DEFAULT_PORT}
  npm start -- --http               The same, explicitly
  npm start -- --https              Generate a new self-signed certificate, then HTTPS
  npm start -- --port 8080          Start at another port (the next free one is used if busy)

Options:
  --http                  Serve plain HTTP (default)
  --https                 Serve HTTPS with a certificate generated at startup (needs openssl)
  -p, --port <number>     First port to try (default: ${DEFAULT_PORT})
  -H, --host <address>    Interface to bind (default: 0.0.0.0, every interface)
  --no-scan               Start with the background network scan switched off
  --scan-hosts <list>     Scan these hosts instead of the local subnets,
                          e.g. 192.168.1.0/24,10.0.0.7
  --scan-ports <list>     Scan these ports instead of ${DEFAULT_PORT}-${DEFAULT_PORT + SCAN_PORT_COUNT - 1},
                          e.g. 55667-55686,8080
  --remote-ui             Let other computers open this instance's control panel
  --log-level <level>     silent | error | warn | info | debug (default: info)
  -h, --help              Show this message

Environment:
  REPTILE_PORT, REPTILE_HOST, REPTILE_PROTOCOL, REPTILE_LOG_LEVEL,
  REPTILE_PORT_ATTEMPTS, REPTILE_SCAN (0 disables), REPTILE_SCAN_HOSTS,
  REPTILE_SCAN_PORTS, REPTILE_REMOTE_UI (1 enables), REPTILE_CERT_DIR,
  REPTILE_OPENSSL
`.trim();

/**
 * Parse an argv slice (without the node/script prefix).
 *
 * Supports `--flag`, `--key value` and `--key=value`. Unknown flags are
 * collected so the caller can warn instead of failing silently.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv = []) {
  /** @type {Record<string, any>} */
  const out = { unknown: [] };

  const readValue = (index, inline) => (inline !== undefined ? { value: inline, next: index } : { value: argv[index + 1], next: index + 1 });

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
      case '--no-scan':
        out.scan = false;
        break;
      case '--scan-hosts': {
        const { value, next } = readValue(index, inline);
        out.scanHosts = value;
        index = next;
        break;
      }
      case '--scan-ports': {
        const { value, next } = readValue(index, inline);
        out.scanPorts = value;
        index = next;
        break;
      }
      case '--remote-ui':
        out.remoteUi = true;
        break;
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

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** `start` and the `count - 1` ports after it. */
function portRange(start, count) {
  return Array.from({ length: count }, (_, offset) => start + offset).filter((port) => port <= 65535);
}

/**
 * Build the effective configuration.
 *
 * @param {string[]} [argv] Raw CLI arguments (defaults to process.argv.slice(2)).
 * @param {object} [overrides] Direct overrides, used by the test suite. Nested
 *   `discovery` and `watcher` objects are merged over the defaults.
 */
export function createConfig(argv = process.argv.slice(2), overrides = {}) {
  const args = parseArgs(argv);

  const protocol =
    overrides.protocol ?? args.protocol ?? (String(process.env.REPTILE_PROTOCOL).toLowerCase() === 'https' ? 'https' : 'http');
  const port = overrides.port ?? (Number.isFinite(args.port) ? args.port : envInt('REPTILE_PORT', DEFAULT_PORT));

  // Discovery scans the default port range; an instance started elsewhere
  // (--port 8080) also scans its own neighbourhood, so two instances started
  // with the same custom port still find each other.
  const scanPortSpec = args.scanPorts ?? process.env.REPTILE_SCAN_PORTS;
  let scanPorts = scanPortSpec ? parsePortSpec(scanPortSpec) : portRange(DEFAULT_PORT, SCAN_PORT_COUNT);
  if (!scanPortSpec && port > 0 && !scanPorts.includes(port)) scanPorts = [...scanPorts, ...portRange(port, SCAN_PORT_COUNT)];
  const scanHostSpec = args.scanHosts ?? process.env.REPTILE_SCAN_HOSTS;

  const config = {
    protocol,
    host: overrides.host ?? args.host ?? process.env.REPTILE_HOST ?? '0.0.0.0',
    port,
    /** How many consecutive ports to try; 1 turns a busy port into an error. */
    portAttempts: overrides.portAttempts ?? envInt('REPTILE_PORT_ATTEMPTS', 64),
    help: Boolean(args.help),
    unknownArgs: args.unknown,
    logLevel: overrides.logLevel ?? args.logLevel ?? process.env.REPTILE_LOG_LEVEL ?? 'info',
    publicDir: overrides.publicDir ?? PUBLIC_DIR,
    /** Replaced on every --https start. */
    certDir: overrides.certDir ?? process.env.REPTILE_CERT_DIR ?? CERT_DIR,
    /** The control panel answers only this machine unless this is true. */
    allowRemoteUi: overrides.allowRemoteUi ?? (args.remoteUi || process.env.REPTILE_REMOTE_UI === '1'),
    /** Injectable `os.networkInterfaces` replacement, for tests only. */
    interfaces: overrides.interfaces,

    discovery: {
      enabled: args.scan ?? process.env.REPTILE_SCAN !== '0',
      /** null means "the /24 of every LAN interface, plus loopback". */
      hosts: scanHostSpec ? parseHostSpec(scanHostSpec) : null,
      ports: scanPorts,
      concurrency: 128,
      connectTimeoutMs: 700,
      requestTimeoutMs: 2000,
      /** Pause between two sweeps of the whole subnet. */
      sweepIntervalMs: 8000,
      /** Known instances are re-pinged this often. */
      refreshIntervalMs: 3000,
      /** An instance silent for this long leaves the list. */
      staleMs: 12_000,
      /** A host that answered is scanned on every port for this long. */
      aliveMemoryMs: 5 * 60_000,
      interfaces: overrides.interfaces,
      ...(overrides.discovery || {}),
    },

    /** Heartbeat and silence timeouts; defaults in `src/domain/protocol.js`. */
    timing: overrides.timing,

    /** Change detection timing; see `src/fs/watcher.js`. */
    watcher: {
      quietMs: 150,
      maxWaitMs: 1000,
      renameWindowMs: 1200,
      stabilityMs: 300,
      ...(overrides.watcher || {}),
    },
  };

  return Object.freeze(config);
}
