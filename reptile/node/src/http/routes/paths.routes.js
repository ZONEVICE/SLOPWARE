/**
 * Live validation of the directories typed into the control panel, and the
 * content tree of the "Host a directory" screen.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson } from '../body.js';
import { json } from '../respond.js';
import { errors } from '../../domain/errors.js';
import { checkHostDirectory, checkSyncDirectory } from '../../fs/pathCheck.js';
import { buildTree } from '../../fs/walk.js';

/** A directory name derived from a hosted directory's display name. */
function safeFolderName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return cleaned.slice(0, 80) || 'Reptile';
}

export default function pathRoutes(router) {
  router.post('/api/paths/check', async ({ req, res }) => {
    const { path, purpose } = await readJson(req);
    if (purpose !== 'host' && purpose !== 'sync') throw errors.badRequest('purpose must be "host" or "sync".');
    const result = purpose === 'host' ? await checkHostDirectory(path) : await checkSyncDirectory(path);
    json(res, 200, result);
  });

  router.post('/api/paths/tree', async ({ req, res }) => {
    const { path } = await readJson(req);
    const check = await checkHostDirectory(path);
    if (!check.ok) throw errors.badRequest(check.message, 'invalid_path');
    const { tree, total, truncated } = await buildTree(check.path);
    tree.name = check.path;
    json(res, 200, { path: check.path, tree, total, truncated });
  });

  router.get('/api/paths/suggest', ({ res, url }) => {
    const name = safeFolderName(url.searchParams.get('name'));
    json(res, 200, { path: join(homedir(), name) });
  });
}
