/**
 * Hosting controls for the control panel: start, change the PIN, stop.
 */
import { readJson } from '../body.js';
import { json } from '../respond.js';
import { generatePin } from '../../domain/pin.js';

export default function hostRoutes(router, { modes, sse }) {
  router.get('/api/host/pin/suggest', ({ res }) => json(res, 200, { pin: generatePin() }));

  router.post('/api/host', async ({ req, res }) => {
    const { path, name, pin, excluded } = await readJson(req, { limit: 16 * 1024 * 1024 });
    const status = await modes.startHosting({ path, name, pin, excluded });
    sse.flush();
    json(res, 201, status);
  });

  router.post('/api/host/pin', async ({ req, res }) => {
    const { pin } = await readJson(req);
    const result = await modes.setHostPin(pin);
    sse.flush();
    json(res, 200, result);
  });

  router.delete('/api/host', async ({ res }) => {
    await modes.stopHosting();
    sse.flush();
    json(res, 200, { ok: true });
  });
}
