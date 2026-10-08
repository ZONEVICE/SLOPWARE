/**
 * Event subscriber registry.
 *
 * THIS IS THE LEGO BOARD for features that only need to KNOW what happens
 * (notifications, logs, statistics). A reporter is `({ bus, logger, ...deps })
 * => detach`. To add one, drop a file in this directory and add it to
 * REPORTER_PLUGINS; no existing module has to import it. The server-sent
 * events hub (`src/http/sse.js`) is the same idea, wired in app.js because it
 * also serves HTTP.
 */
import consoleReporter from './console.js';

export const REPORTER_PLUGINS = [consoleReporter];

/**
 * Attach every reporter.
 * @param {object} deps `{ bus, logger, ... }`
 * @returns {() => void} Detach them all.
 */
export function attachReporters(deps) {
  const detachers = REPORTER_PLUGINS.map((plugin) => plugin(deps));
  return () => {
    for (const detach of detachers) detach?.();
  };
}
