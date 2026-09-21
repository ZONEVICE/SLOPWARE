/**
 * HTTP route registry.
 *
 * THIS IS THE LEGO BOARD for the HTTP layer. A route module is a plugin with
 * the signature `(router, deps) => void`. To add an endpoint group, drop a file
 * in this directory and add it to `ROUTE_PLUGINS`; nothing else changes.
 *
 * Order matters only when two patterns can match the same path. The specific
 * `/api/...` groups are listed before the `/uploads/*` wildcard for clarity.
 */
import sessionRoutes from './session.routes.js';
import roomRoutes from './rooms.routes.js';
import uploadRoutes from './uploads.routes.js';
import healthRoutes from './health.routes.js';

/** Every route plugin, in registration order. */
export const ROUTE_PLUGINS = [sessionRoutes, roomRoutes, uploadRoutes, healthRoutes];

/**
 * Mount every plugin on a router.
 * @param {object} router
 * @param {object} deps Shared dependencies handed to each plugin.
 */
export function registerRoutes(router, deps) {
  for (const plugin of ROUTE_PLUGINS) router.use(plugin, deps);
  return router;
}
