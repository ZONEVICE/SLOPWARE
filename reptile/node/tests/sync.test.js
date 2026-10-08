/**
 * Synchronisation between two real instances, in both directions.
 *
 * Initial synchronisation: host content reaches an empty directory, peer
 * content reaches the host, conflicts resolve to the newer version, identical
 * content is not copied again.
 *
 * Live synchronisation, host -> peer AND peer -> host: create, modify, rename
 * and delete, for files and for directories. A rename must arrive as a rename:
 * the receiving side keeps the same inode, which proves the content was moved
 * rather than deleted and transferred again.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, connectedPair, sleep, snapshotTree, waitFor, waitForSameTrees } from './helpers/instances.js';

after(cleanup);

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

describe('initial synchronisation', () => {
  test('the host’s content is copied into an empty local directory', async () => {
    const { hostDir, syncDir } = await connectedPair({
      hostFiles: { 'readme.txt': 'hello', 'docs/a.md': '# A', 'docs/deep/b.md': '# B', 'empty/': null },
    });
    await waitForSameTrees(hostDir, syncDir);
    assert.equal(await readFile(join(syncDir, 'docs/deep/b.md'), 'utf8'), '# B');
    assert.ok((await stat(join(syncDir, 'empty'))).isDirectory(), 'empty directories are synced too');
  });

  test('modification times travel with the content', async () => {
    const { hostDir, syncDir } = await connectedPair({ hostFiles: { 'a.txt': 'a' } });
    const when = new Date('2021-06-01T10:00:00.123Z');
    await utimes(join(hostDir, 'a.txt'), when, when);
    await appendFile(join(hostDir, 'b.txt'), 'b');
    await waitFor(() => exists(join(syncDir, 'b.txt')));
    await waitForSameTrees(hostDir, syncDir);
    const host = await stat(join(hostDir, 'b.txt'));
    const peer = await stat(join(syncDir, 'b.txt'));
    assert.equal(Math.round(peer.mtimeMs), Math.round(host.mtimeMs));
  });

  test('what only the peer has is sent to the host (the two copies are merged)', async () => {
    const { hostDir, syncDir } = await connectedPair({
      hostFiles: { 'host-only.txt': 'h' },
      syncFiles: { 'peer-only.txt': 'p', 'peer-dir/inner.txt': 'i' },
    });
    await waitForSameTrees(hostDir, syncDir);
    assert.equal(await readFile(join(hostDir, 'peer-dir/inner.txt'), 'utf8'), 'i');
  });

  test('when both have a different version, the newer one wins', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    const recent = new Date('2024-01-01T00:00:00Z');
    const { hostDir: preHost } = { hostDir: null };
    void preHost;
    // Build both sides before connecting, with controlled mtimes.
    const { host, client, hostDir, syncDir } = await (async () => {
      const pair = await import('./helpers/instances.js');
      const hostDirectory = await pair.tempDir('reptile-host-');
      const syncParent = await pair.tempDir('reptile-sync-');
      const syncDirectory = join(syncParent, 'copy');
      await pair.writeTree(hostDirectory, { 'newer-on-host.txt': 'HOST VERSION', 'newer-on-peer.txt': 'host version' });
      await pair.writeTree(syncDirectory, { 'newer-on-host.txt': 'peer version', 'newer-on-peer.txt': 'PEER VERSION' });
      await utimes(join(hostDirectory, 'newer-on-host.txt'), recent, recent);
      await utimes(join(syncDirectory, 'newer-on-host.txt'), old, old);
      await utimes(join(hostDirectory, 'newer-on-peer.txt'), old, old);
      await utimes(join(syncDirectory, 'newer-on-peer.txt'), recent, recent);
      const h = await pair.startInstance();
      const c = await pair.startInstance();
      await h.app.modes.startHosting({ path: hostDirectory, name: 'X', pin: '1234' });
      await c.app.modes.startSyncing({ address: '127.0.0.1', port: h.port, localPath: syncDirectory, pin: '1234' });
      await pair.waitFor(() => c.syncState() === 'live');
      return { host: h, client: c, hostDir: hostDirectory, syncDir: syncDirectory };
    })();
    void host;
    void client;
    await waitForSameTrees(hostDir, syncDir);
    assert.equal(await readFile(join(syncDir, 'newer-on-host.txt'), 'utf8'), 'HOST VERSION');
    assert.equal(await readFile(join(hostDir, 'newer-on-peer.txt'), 'utf8'), 'PEER VERSION');
  });

  test('identical content with different mtimes is compared by hash, not copied', async () => {
    const pair = await import('./helpers/instances.js');
    const hostDirectory = await pair.tempDir('reptile-host-');
    const syncParent = await pair.tempDir('reptile-sync-');
    const syncDirectory = join(syncParent, 'copy');
    const bytes = randomBytes(64 * 1024);
    await pair.writeTree(hostDirectory, { 'same.bin': bytes });
    await pair.writeTree(syncDirectory, { 'same.bin': bytes });
    await utimes(join(syncDirectory, 'same.bin'), new Date('2019-05-05'), new Date('2019-05-05'));
    const inodeBefore = (await stat(join(syncDirectory, 'same.bin'))).ino;
    const host = await pair.startInstance();
    const client = await pair.startInstance();
    await host.app.modes.startHosting({ path: hostDirectory, name: 'X', pin: '1234' });
    await client.app.modes.startSyncing({ address: '127.0.0.1', port: host.port, localPath: syncDirectory, pin: '1234' });
    await waitFor(() => client.syncState() === 'live');
    const after = await stat(join(syncDirectory, 'same.bin'));
    assert.equal(after.ino, inodeBefore, 'the local file was not replaced');
    assert.equal(Math.round(after.mtimeMs), Math.round((await stat(join(hostDirectory, 'same.bin'))).mtimeMs), 'its mtime was aligned');
    const received = client.app.syncing.status().activity.filter((entry) => entry.kind === 'received' && entry.op === 'write');
    assert.equal(received.length, 0);
  });

  test('large and binary files arrive intact, and odd names too', async () => {
    const big = randomBytes(6 * 1024 * 1024 + 123);
    const { hostDir, syncDir } = await connectedPair({
      hostFiles: { 'big.bin': big, 'ünïcödé ñame.txt': 'ñ', 'with spaces/and (parens).md': 'x', 'emoji 🦎.txt': '🦎', 'empty-file': '' },
    });
    await waitForSameTrees(hostDir, syncDir, { timeoutMs: 20_000 });
    assert.ok((await readFile(join(syncDir, 'big.bin'))).equals(big));
    assert.equal((await stat(join(syncDir, 'empty-file'))).size, 0);
  });
});

/**
 * Run the same live scenario in both directions: `from` is where the user
 * works, `to` is where the change must appear.
 */
function bothDirections(name, scenario) {
  describe(name, () => {
    test('host -> peer', async () => {
      const pair = await connectedPair({ hostFiles: scenario.files || {} });
      await waitForSameTrees(pair.hostDir, pair.syncDir);
      await scenario.run({ from: pair.hostDir, to: pair.syncDir, pair });
    });
    test('peer -> host', async () => {
      const pair = await connectedPair({ hostFiles: scenario.files || {} });
      await waitForSameTrees(pair.hostDir, pair.syncDir);
      await scenario.run({ from: pair.syncDir, to: pair.hostDir, pair });
    });
  });
}

describe('live synchronisation', () => {
  bothDirections('creating a file', {
    run: async ({ from, to }) => {
      await writeFile(join(from, 'new.txt'), 'brand new');
      await waitFor(async () => (await readFile(join(to, 'new.txt'), 'utf8').catch(() => '')) === 'brand new', { message: 'the new file' });
      await waitForSameTrees(from, to);
    },
  });

  bothDirections('creating nested directories with files', {
    run: async ({ from, to }) => {
      await mkdir(join(from, 'a', 'b', 'c'), { recursive: true });
      await writeFile(join(from, 'a', 'b', 'c', 'leaf.txt'), 'leaf');
      await mkdir(join(from, 'a', 'empty'));
      await waitForSameTrees(from, to);
    },
  });

  bothDirections('modifying a file', {
    files: { 'doc.txt': 'version 1' },
    run: async ({ from, to }) => {
      await writeFile(join(from, 'doc.txt'), 'version 2, longer');
      await waitFor(async () => (await readFile(join(to, 'doc.txt'), 'utf8')) === 'version 2, longer', { message: 'the modification' });
      await appendFile(join(from, 'doc.txt'), ' + appended');
      await waitFor(async () => (await readFile(join(to, 'doc.txt'), 'utf8')).endsWith('+ appended'), { message: 'the append' });
      await waitForSameTrees(from, to);
    },
  });

  bothDirections('renaming a file', {
    files: { 'before.txt': 'keep my bytes' },
    run: async ({ from, to }) => {
      const inode = (await stat(join(to, 'before.txt'))).ino;
      await rename(join(from, 'before.txt'), join(from, 'after.txt'));
      await waitFor(() => exists(join(to, 'after.txt')), { message: 'the renamed file' });
      await waitForSameTrees(from, to);
      assert.equal((await stat(join(to, 'after.txt'))).ino, inode, 'renamed in place, not transferred again');
      assert.equal(await exists(join(to, 'before.txt')), false);
    },
  });

  bothDirections('moving a file to another directory', {
    files: { 'inbox/letter.txt': 'dear', 'archive/': null },
    run: async ({ from, to }) => {
      const inode = (await stat(join(to, 'inbox/letter.txt'))).ino;
      await rename(join(from, 'inbox/letter.txt'), join(from, 'archive/letter.txt'));
      await waitFor(() => exists(join(to, 'archive/letter.txt')));
      await waitForSameTrees(from, to);
      assert.equal((await stat(join(to, 'archive/letter.txt'))).ino, inode);
    },
  });

  bothDirections('renaming a directory', {
    files: { 'project/src/main.js': 'code', 'project/README.md': 'readme', 'project/empty/': null },
    run: async ({ from, to }) => {
      const inodes = [(await stat(join(to, 'project'))).ino, (await stat(join(to, 'project/src/main.js'))).ino];
      await rename(join(from, 'project'), join(from, 'renamed-project'));
      await waitFor(() => exists(join(to, 'renamed-project/src/main.js')), { message: 'the renamed directory' });
      await waitForSameTrees(from, to);
      assert.deepEqual([(await stat(join(to, 'renamed-project'))).ino, (await stat(join(to, 'renamed-project/src/main.js'))).ino], inodes);
    },
  });

  bothDirections('deleting a file', {
    files: { 'keep.txt': 'k', 'remove.txt': 'r' },
    run: async ({ from, to }) => {
      await rm(join(from, 'remove.txt'));
      await waitFor(async () => !(await exists(join(to, 'remove.txt'))), { message: 'the deletion' });
      await waitForSameTrees(from, to);
      assert.equal(await readFile(join(to, 'keep.txt'), 'utf8'), 'k');
    },
  });

  bothDirections('deleting a directory tree', {
    files: { 'tree/a.txt': 'a', 'tree/sub/b.txt': 'b', 'tree/sub/deeper/c.txt': 'c', 'other.txt': 'o' },
    run: async ({ from, to }) => {
      await rm(join(from, 'tree'), { recursive: true });
      await waitFor(async () => !(await exists(join(to, 'tree'))), { message: 'the tree deletion' });
      await waitForSameTrees(from, to);
    },
  });

  bothDirections('replacing a file with a directory of the same name', {
    files: { thing: 'I am a file' },
    run: async ({ from, to }) => {
      await rm(join(from, 'thing'));
      await mkdir(join(from, 'thing'));
      await writeFile(join(from, 'thing', 'inside.txt'), 'now a directory');
      await waitFor(async () => (await stat(join(to, 'thing')).catch(() => null))?.isDirectory(), { message: 'the directory' });
      await waitForSameTrees(from, to);
    },
  });

  test('a burst of changes on both sides at once converges', async () => {
    const { hostDir, syncDir } = await connectedPair({ hostFiles: { 'shared/a.txt': 'a' } });
    await Promise.all([
      ...Array.from({ length: 15 }, (_, index) => writeFile(join(hostDir, `host-${index}.txt`), `h${index}`)),
      ...Array.from({ length: 15 }, (_, index) => writeFile(join(syncDir, `peer-${index}.txt`), `p${index}`)),
    ]);
    await waitForSameTrees(hostDir, syncDir, { timeoutMs: 15_000 });
    const names = await readdir(hostDir);
    assert.equal(names.filter((name) => name.startsWith('peer-')).length, 15);
  });

  test('both sides editing the same file end with the same, newer, version', async () => {
    const { hostDir, syncDir } = await connectedPair({ hostFiles: { 'contested.txt': 'original' } });
    await writeFile(join(syncDir, 'contested.txt'), 'peer edit');
    await sleep(30);
    await writeFile(join(hostDir, 'contested.txt'), 'host edit, a bit later');
    await waitForSameTrees(hostDir, syncDir, { timeoutMs: 15_000 });
    const final = await readFile(join(hostDir, 'contested.txt'), 'utf8');
    assert.equal(final, 'host edit, a bit later');
  });

  test('nothing bounces back: a change produces one transfer, not a loop', async () => {
    const { client, host, hostDir, syncDir } = await connectedPair({ hostFiles: {} });
    await writeFile(join(hostDir, 'once.txt'), 'once');
    await waitFor(() => exists(join(syncDir, 'once.txt')));
    await sleep(1200);
    const hostSent = host.app.hosting.status().activity.filter((entry) => entry.kind === 'sent' && entry.path === 'once.txt');
    const peerSent = client.app.syncing.status().activity.filter((entry) => entry.kind === 'sent' && entry.path === 'once.txt');
    assert.equal(hostSent.length, 1, 'downloaded once');
    assert.equal(peerSent.length, 0, 'never echoed back to the host');
    assert.deepEqual(await snapshotTree(hostDir), await snapshotTree(syncDir));
  });
});

describe('safety', () => {
  test('if the local copy disappears, syncing stops and nothing is deleted on the host', async () => {
    const { client, hostDir, syncDir } = await connectedPair({ hostFiles: { 'precious.txt': 'keep me', 'dir/also.txt': 'me too' } });
    await waitForSameTrees(hostDir, syncDir);
    await rm(syncDir, { recursive: true, force: true });
    await waitFor(() => client.syncState() === 'error', { message: 'the peer to stop' });
    assert.match(client.app.syncing.status().notice.message, /disappeared/);
    await sleep(800);
    assert.equal(await readFile(join(hostDir, 'precious.txt'), 'utf8'), 'keep me');
    assert.equal(await readFile(join(hostDir, 'dir/also.txt'), 'utf8'), 'me too');
  });

  test('if the hosted directory disappears, hosting stops and nothing is deleted on the peer', async () => {
    const { host, client, hostDir, syncDir } = await connectedPair({ hostFiles: { 'precious.txt': 'keep me' } });
    await waitForSameTrees(hostDir, syncDir);
    await rm(hostDir, { recursive: true, force: true });
    await waitFor(() => host.app.modes.mode === 'idle', { message: 'hosting to stop' });
    assert.match(host.app.hosting.status().notice.message, /disappeared/);
    await waitFor(() => client.syncState() === 'stopped', { message: 'the peer to be told' });
    assert.equal(await readFile(join(syncDir, 'precious.txt'), 'utf8'), 'keep me');
  });

  test('temporary transfer files never show up on either side', async () => {
    const { hostDir, syncDir } = await connectedPair({ hostFiles: { 'big.bin': randomBytes(2 * 1024 * 1024) } });
    await waitForSameTrees(hostDir, syncDir);
    for (const directory of [hostDir, syncDir]) {
      assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.reptile-')), directory);
    }
  });
});
