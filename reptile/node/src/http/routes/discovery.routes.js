/**
 * Discovery controls: the status bar's scan switch, and "scan now".
 */
import { readJson } from '../body.js';
import { json } from '../respond.js';
import { errors } from '../../domain/errors.js';

export default function discoveryRoutes(router, { discovery, sse }) {
  router.post('/api/discovery', async ({ req, res }) => {
    const body = await readJson(req);
    if (typeof body.enabled !== 'boolean') throw errors.badRequest('Send { "enabled": true } or { "enabled": false }.');
    const status = discovery.setEnabled(body.enabled);
    sse.flush();
    json(res, 200, status);
  });

  router.post('/api/discovery/scan', ({ res }) => json(res, 200, discovery.scanNow()));
}
