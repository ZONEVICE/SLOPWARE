/**
 * Content selection: only what the host checked is shared.
 *
 * "Unchecked items never leave the host and are never modified from the
 * other side." Checked here at three levels: the Selection rules themselves,
 * the host's peer API (manifest, downloads, uploads, operations), and a real
 * synchronisation between two instances, including renames on the host that
 * must not leak an unchecked item.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { normalizeExclusions, Selection } from '../src/domain/selection.js';
import { cleanup, connectedPair, sleep, startInstance, tempDir, waitFor, waitForSameTrees, writeTree } from './helpers/instances.js';

after(cleanup);

describe('selection rules', () => {
  test('nested exclusions collapse into their ancestor', () => {
    assert.deepEqual(normalizeExclusions(['a/b', 'a', 'c/d', 'c/d/e', 'f']), ['a', 'c/d', 'f']);
  });

  test('the root cannot be excluded and bad paths are refused', () => {
    assert.throws(() => normalizeExclusions(['']), (error) => error.code === 'empty_selection');
    assert.throws(() => normalizeExclusions(['../x']), (error) => error.code === 'bad_selection');
    assert.throws(() => normalizeExclusions('a'), (error) => error.code === 'bad_selection');
    assert.deepEqual(normalizeExclusions(undefined), []);
  });

  test('unchecking a directory unchecks everything inside it, including future content', () => {
    const selection = new Selection(['photos/private']);
    assert.ok(selection.isExcluded('photos/private'));
    assert.ok(selection.isExcluded('photos/private/2024/x.jpg'));
    assert.ok(!selection.isExcluded('photos'));
    assert.ok(!selection.isExcluded('photos/public.jpg'));
    assert.ok(!selection.isExcluded('photos/private-not.jpg'));
    assert.ok(selection.hasExcludedAncestor('photos/private/x'));
    assert.ok(!selection.hasExcludedAncestor('photos/private'));
    assert.ok(selection.hasExclusionsInside('photos'));
  });

  test('five files, three unchecked: two are shared', () => {
    const selection = new Selection(['f1', 'f2', 'f3']);
    const shared = ['f1', 'f2', 'f3', 'f4', 'f5'].filter((name) => !selection.isExcluded(name));
    assert.deepEqual(shared, ['f4', 'f5']);
  });

  test('exclusions follow a rename of the item or of a directory containing it', () => {
    const selection = new Selection(['docs/secret.txt']);
    selection.applyRename('docs', 'papers');
    assert.ok(selection.isExcluded('papers/secret.txt'));
    selection.applyRename('papers/secret.txt', 'papers/old-secret.txt');
    assert.ok(selection.isExcluded('papers/old-secret.txt'));
  });

  test('an unchecked item that shows up elsewhere (same inode) stays unchecked', () => {
    const selection = new Selection(['secret.txt']);
    selection.bindIdentity('secret.txt', '1:42');
    assert.equal(selection.followIdentity('elsewhere/secret.txt', '1:42'), true);
    assert.ok(selection.isExcluded('elsewhere/secret.txt'));
    assert.equal(selection.followIdentity('unrelated.txt', '1:43'), false);
    assert.ok(!selection.isExcluded('unrelated.txt'));
  });
});

/** Host a directory and open a session straight through the hosting service. */
async function hostedSession(files, excluded) {
  const root = await tempDir('reptile-host-');
  await writeTree(root, files);
  const host = await startInstance();
  await host.app.modes.startHosting({ path: root, name: 'Test', pin: '1234', excluded });
  const { token } = host.app.hosting.connect({ pin: '1234', protocol: 'http', peer: { uuid: 'peer-1', hostname: 'peer' }, remoteAddress: '127.0.0.1' });
  return { root, host, hosting: host.app.hosting, token };
}

describe('the host enforces the selection on the peer API', () => {
  const files = { 'public.txt': 'hello', 'private.txt': 'secret', 'vault/key.pem': 'KEY', 'vault/sub/deep.txt': 'deep', 'mixed/ok.txt': 'ok', 'mixed/hidden.txt': 'hidden' };
  const excluded = ['private.txt', 'vault', 'mixed/hidden.txt'];

  test('the manifest lists only checked items', async () => {
    const { hosting, token } = await hostedSession(files, excluded);
    const { entries } = await hosting.manifest(token);
    assert.deepEqual(entries.map((entry) => entry.path).sort(), ['mixed', 'mixed/ok.txt', 'public.txt']);
  });

  test('an unchecked file cannot be downloaded', async () => {
    const { hosting, token } = await hostedSession(files, excluded);
    await assert.rejects(hosting.openFile(token, 'private.txt'), (error) => error.code === 'not_shared' && error.status === 403);
    await assert.rejects(hosting.openFile(token, 'vault/sub/deep.txt'), (error) => error.code === 'not_shared');
    const ok = await hosting.openFile(token, 'public.txt');
    assert.equal(ok.state.size, 5);
  });

  test('unchecked items cannot be written, deleted, renamed or created from the other side', async () => {
    const { root, hosting, token } = await hostedSession(files, excluded);
    await assert.rejects(hosting.prepareUpload(token, { path: 'private.txt', size: 1, mtimeMs: Date.now() }), (error) => error.code === 'not_shared');
    await assert.rejects(hosting.prepareUpload(token, { path: 'vault/new.txt', size: 1, mtimeMs: Date.now() }), (error) => error.code === 'not_shared');
    const { results } = await hosting.applyOps(token, [
      { op: 'unlink', path: 'private.txt' },
      { op: 'rmdir', path: 'vault' },
      { op: 'rename', from: 'mixed/hidden.txt', to: 'exposed.txt' },
      { op: 'rename', from: 'public.txt', to: 'vault/public.txt' },
      { op: 'mkdir', path: 'vault/new' },
    ]);
    assert.deepEqual(results.map((result) => result.code), ['not_shared', 'not_shared', 'not_shared', 'not_shared', 'not_shared']);
    assert.equal(await readFile(join(root, 'private.txt'), 'utf8'), 'secret');
    assert.equal(await readFile(join(root, 'vault/sub/deep.txt'), 'utf8'), 'deep');
    assert.equal(await readFile(join(root, 'mixed/hidden.txt'), 'utf8'), 'hidden');
    assert.equal(await readFile(join(root, 'public.txt'), 'utf8'), 'hello');
  });

  test('deleting a checked directory leaves its unchecked content in place', async () => {
    const { root, hosting, token } = await hostedSession(files, excluded);
    const { results } = await hosting.applyOps(token, [{ op: 'rmdir', path: 'mixed' }]);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].partial, true, 'the peer learns the directory could not go away');
    assert.deepEqual(await readdir(join(root, 'mixed')), ['hidden.txt']);
  });

  test('renaming a checked directory moves only its checked content', async () => {
    const { root, hosting, token } = await hostedSession(files, excluded);
    const { results } = await hosting.applyOps(token, [{ op: 'rename', from: 'mixed', to: 'renamed', kind: 'dir' }]);
    assert.equal(results[0].ok, true);
    assert.deepEqual(await readdir(join(root, 'renamed')), ['ok.txt']);
    assert.deepEqual(await readdir(join(root, 'mixed')), ['hidden.txt'], 'the unchecked file did not move');
  });

  test('a checked file can be uploaded next to unchecked ones', async () => {
    const { root, hosting, token } = await hostedSession(files, excluded);
    const prepared = await hosting.prepareUpload(token, { path: 'mixed/new.txt', size: 3, mtimeMs: 1_700_000_000_000 });
    await hosting.receiveFile(prepared, Readable.from([Buffer.from('new')]), { size: 3, mtimeMs: 1_700_000_000_000 });
    assert.equal(await readFile(join(root, 'mixed/new.txt'), 'utf8'), 'new');
  });
});

describe('selection in a live synchronisation', () => {
  test('unchecked items never reach the other side, before or after connecting', async () => {
    const { hostDir, syncDir } = await connectedPair({
      hostFiles: { 'shared.txt': 's', 'private.txt': 'p', 'vault/x.txt': 'x' },
      excluded: ['private.txt', 'vault'],
    });
    const skip = (path) => path === 'private.txt' || path === 'vault' || path.startsWith('vault/');
    await waitForSameTrees(hostDir, syncDir, { skipA: skip });
    // New content inside an unchecked directory stays private too.
    await writeFile(join(hostDir, 'vault', 'later.txt'), 'later');
    await writeFile(join(hostDir, 'later-shared.txt'), 'yes');
    await waitFor(async () => (await readdir(syncDir)).includes('later-shared.txt'));
    await sleep(500);
    assert.ok(!(await readdir(syncDir)).includes('vault'));
    await waitForSameTrees(hostDir, syncDir, { skipA: skip });
  });

  test('an unchecked file renamed on the host stays unchecked', async () => {
    const { hostDir, syncDir } = await connectedPair({ hostFiles: { 'shared.txt': 's', 'secret.txt': 'top secret' }, excluded: ['secret.txt'] });
    await rename(join(hostDir, 'secret.txt'), join(hostDir, 'renamed-secret.txt'));
    await writeFile(join(hostDir, 'marker.txt'), 'm');
    await waitFor(async () => (await readdir(syncDir)).includes('marker.txt'));
    await sleep(800);
    const names = await readdir(syncDir);
    assert.ok(!names.includes('renamed-secret.txt'), `leaked: ${names}`);
    assert.ok(!names.includes('secret.txt'));
  });

  test('an unchecked directory renamed on the host stays unchecked, content included', async () => {
    const { hostDir, syncDir } = await connectedPair({ hostFiles: { 'shared.txt': 's', 'private/a.txt': 'a', 'private/b/c.txt': 'c' }, excluded: ['private'] });
    await rename(join(hostDir, 'private'), join(hostDir, 'public-now'));
    await writeFile(join(hostDir, 'marker.txt'), 'm');
    await waitFor(async () => (await readdir(syncDir)).includes('marker.txt'));
    await sleep(800);
    assert.ok(!(await readdir(syncDir)).includes('public-now'));
  });

  test('a file the peer creates where the host has an unchecked directory is not synced, and the peer is told', async () => {
    const { client, hostDir, syncDir } = await connectedPair({ hostFiles: { 'shared.txt': 's', 'vault/x.txt': 'x' }, excluded: ['vault'] });
    await writeTree(syncDir, { 'vault/mine.txt': 'from the peer' });
    await waitFor(() => (client.app.syncing.status().rejected || []).length > 0, { message: 'the refusal to be reported' });
    assert.deepEqual(await readdir(join(hostDir, 'vault')), ['x.txt']);
    assert.ok(client.app.syncing.status().rejected.some((path) => path.startsWith('vault')));
  });
});
