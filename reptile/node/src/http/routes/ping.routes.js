/**
 * `GET /api/ping`: the discovery handshake.
 *
 * Public on purpose: any instance scanning the network must be able to ask
 * "are you Reptile?". The answer identifies the instance (hostname, session
 * UUID, protocol) and says whether it is hosting a directory, and which one.
 * It never includes a path on disk or the PIN.
 */
import { json } from '../respond.js';

/** @param {import('../router.js').createRouter} router */
export default function pingRoutes(router, { pingInfo }) {
  router.get('/api/ping', ({ req, res }) => json(res, 200, pingInfo(), { head: req.method === 'HEAD' }), { access: 'public' });
}
