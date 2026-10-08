/**
 * Syncing controls for the control panel: inspect a target, connect with a
 * PIN, answer a PIN change, stop.
 */
import { readJson } from '../body.js';
import { json } from '../respond.js';

export default function syncRoutes(router, { modes, syncing, sse }) {
  router.post('/api/sync/inspect', async ({ req, res }) => {
    const { address, port } = await readJson(req);
    json(res, 200, await syncing.inspect({ address, port }));
  });

  router.post('/api/sync', async ({ req, res }) => {
    const { address, port, localPath, pin } = await readJson(req);
    const status = await modes.startSyncing({ address, port, localPath, pin });
    sse.flush();
    json(res, 201, status);
  });

  router.post('/api/sync/pin', async ({ req, res }) => {
    const { pin } = await readJson(req);
    const status = await modes.submitSyncPin(pin);
    sse.flush();
    json(res, 200, status);
  });

  router.delete('/api/sync', async ({ res }) => {
    await modes.stopSyncing();
    sse.flush();
    json(res, 200, { ok: true });
  });
}
