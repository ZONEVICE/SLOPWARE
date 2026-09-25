/**
 * HTTP route registry.
 *
 * THIS IS THE LEGO BOARD of the HTTP layer. A route module is a plugin with
 * the signature `(router, deps) => void`. To add an endpoint group, drop a file
 * in this directory and add it to `ROUTE_PLUGINS`; nothing else changes.
 *
 * Every route declares who may call it through its `access` option:
 *   'ui'     (default) the control panel; see `src/http/guard.js`
 *   'peer'   another instance; the handler checks the PIN or the token
 *   'public' anyone (only `GET /api/ping`)
 */
import discoveryRoutes from './discovery.routes.js';
import hostRoutes from './host.routes.js';
import pathRoutes from './paths.routes.js';
import peerRoutes from './peer.routes.js';
import pingRoutes from './ping.routes.js';
import stateRoutes from './state.routes.js';
import syncRoutes from './sync.routes.js';

/** Every route plugin, in registration order. */
export const ROUTE_PLUGINS = [pingRoutes, peerRoutes, stateRoutes, discoveryRoutes, pathRoutes, hostRoutes, syncRoutes];

/**
 * Mount every plugin on a router.
 * @param {object} router
 * @param {object} deps Shared dependencies handed to each plugin.
 */
export function registerRoutes(router, deps) {
  for (const plugin of ROUTE_PLUGINS) router.use(plugin, deps);
  return router;
}
