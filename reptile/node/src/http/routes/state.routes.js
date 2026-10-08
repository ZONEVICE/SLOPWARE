/**
 * The control panel's view of the world: one snapshot on demand, and the same
 * snapshot pushed over server-sent events whenever it changes.
 */
import { json } from '../respond.js';

export default function stateRoutes(router, { snapshot, sse }) {
  router.get('/api/state', ({ res }) => json(res, 200, snapshot()));
  router.get('/api/events', ({ req, res }) => sse.handle(req, res));
}
