/**
 * Tiny levelled logger. No dependency and no transport configuration: Reptile
 * logs to stdout/stderr and lets whoever started the process deal with it.
 *
 * Levels, from quietest to loudest: silent, error, warn, info, debug.
 */
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/**
 * @param {string} scope Short tag printed on every line, e.g. "http".
 * @param {{ level?: string }} [options]
 */
export function createLogger(scope, options = {}) {
  const configured = options.level || process.env.REPTILE_LOG_LEVEL || 'info';
  const threshold = LEVELS[configured] ?? LEVELS.info;

  const write = (level, stream, args) => {
    if (LEVELS[level] > threshold) return;
    const stamp = new Date().toISOString();
    stream(`${stamp} ${level.toUpperCase().padEnd(5)} [${scope}]`, ...args);
  };

  return {
    scope,
    level: configured,
    error: (...args) => write('error', console.error, args),
    warn: (...args) => write('warn', console.warn, args),
    info: (...args) => write('info', console.log, args),
    debug: (...args) => write('debug', console.log, args),
    /** Derive a child logger: `log.child('host')` prints "[reptile:host]". */
    child: (childScope) => createLogger(`${scope}:${childScope}`, { level: configured }),
  };
}

/** A logger that discards everything; the default for modules used in tests. */
export const silentLogger = createLogger('silent', { level: 'silent' });
