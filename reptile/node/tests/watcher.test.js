/**
 * The change detector on top of fs.watch, against a real directory.
 *
 * What matters is the operations it derives, not the raw events: a rename
 * must come out as a rename (not a deletion plus an upload), a deleted tree as
 * one removal, and a change applied through the index as nothing at all.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readState } from '../src/fs/entry.js';
import { commitOp, FileIndex } from '../src/fs/fileIndex.js';
import { walkTree } from '../src/fs/walk.js';
import { createDirectoryWatcher } from '../src/fs/watcher.js';
import { cleanup, FAST_WATCHER, sleep, tempDir, waitFor, writeTree } from './helpers/instances.js';

after(cleanup);

/** A watcher over a fresh directory that commits every batch, like the host does. */
async function harness(files = {}, options = {}) {
  const root = await tempDir('reptile-watch-');
  await writeTree(root, files);
  const index = new FileIndex();
  const batches = [];
  const watcher = createDirectoryWatcher({
    root,
    index,
    ...FAST_WATCHER,
    ...options,
    onOps: (ops) => {
      batches.push(ops.map((op) => ({ ...op })));
      for (const op of ops) commitOp(index, op);
    },
  });
  await watcher.ready;
  index.replaceAll((await walkTree(root)).entries);
  const all = () => batches.flat().filter((op) => op.op !== 'reindex');
  const summary = () => all().map((op) => (op.op === 'rename' ? `rename ${op.from} -> ${op.to}` : `${op.op} ${op.path}`));
  after(() => watcher.close());
  return { root, index, watcher, batches, all, summary, reset: () => batches.splice(0) };
}

describe('change detection', () => {
  test('a new file is a write, a new directory a mkdir (parents first)', async () => {
    const h = await harness();
    await mkdir(join(h.root, 'x', 'y'), { recursive: true });
    await writeFile(join(h.root, 'x', 'y', 'z.txt'), 'zz');
    await waitFor(() => h.summary().includes('write x/y/z.txt'), { message: 'write x/y/z.txt' });
    const summary = h.summary();
    assert.ok(summary.indexOf('mkdir x') < summary.indexOf('mkdir x/y'));
    assert.ok(summary.indexOf('mkdir x/y') < summary.indexOf('write x/y/z.txt'));
    const write = h.all().find((op) => op.path === 'x/y/z.txt');
    assert.equal(write.state.size, 2);
    assert.equal(write.base, null);
  });

  test('a modification is a write carrying the previous state', async () => {
    const h = await harness({ 'a.txt': 'one' });
    const before = h.index.get('a.txt');
    await appendFile(join(h.root, 'a.txt'), ' two');
    await waitFor(() => h.summary().includes('write a.txt'));
    const op = h.all().find((entry) => entry.path === 'a.txt');
    assert.equal(op.state.size, 7);
    assert.equal(op.base.size, before.size);
  });

  test('renaming a file is ONE rename, not a deletion and an upload', async () => {
    const h = await harness({ 'old.txt': 'content' });
    await rename(join(h.root, 'old.txt'), join(h.root, 'new.txt'));
    await waitFor(() => h.summary().includes('rename old.txt -> new.txt'));
    await sleep(FAST_WATCHER.renameWindowMs + 200);
    assert.deepEqual(h.summary(), ['rename old.txt -> new.txt']);
  });

  test('renaming a directory moves its whole content in one operation', async () => {
    const h = await harness({ 'dir/a.txt': 'a', 'dir/sub/b.txt': 'b' });
    await rename(join(h.root, 'dir'), join(h.root, 'moved'));
    await waitFor(() => h.summary().includes('rename dir -> moved'));
    await sleep(FAST_WATCHER.renameWindowMs + 300);
    assert.deepEqual(h.summary(), ['rename dir -> moved']);
    assert.deepEqual([...h.index.entries.keys()].sort(), ['moved', 'moved/a.txt', 'moved/sub', 'moved/sub/b.txt']);
  });

  test('moving a file into another directory is a rename too', async () => {
    const h = await harness({ 'a.txt': 'a', 'box/': null });
    await rename(join(h.root, 'a.txt'), join(h.root, 'box', 'a.txt'));
    await waitFor(() => h.summary().includes('rename a.txt -> box/a.txt'));
  });

  test('deleting a file is reported after the rename window', async () => {
    const h = await harness({ 'gone.txt': 'bye' });
    const started = Date.now();
    await rm(join(h.root, 'gone.txt'));
    await waitFor(() => h.summary().includes('unlink gone.txt'));
    assert.ok(Date.now() - started >= FAST_WATCHER.renameWindowMs - 50, 'held back while a rename could still complete');
    const op = h.all().find((entry) => entry.op === 'unlink');
    assert.equal(op.base.size, 3, 'the deletion says which version was deleted');
  });

  test('deleting a tree is one rmdir, not one operation per file', async () => {
    const h = await harness({ 'tree/a': 'a', 'tree/b/c': 'c', 'tree/b/d/e': 'e' });
    await rm(join(h.root, 'tree'), { recursive: true });
    await waitFor(() => h.summary().includes('rmdir tree'));
    await sleep(200);
    assert.deepEqual(h.summary(), ['rmdir tree']);
    assert.equal(h.index.size, 0);
  });

  test('a file replaced by a directory: removal first, then creation', async () => {
    const h = await harness({ thing: 'file' });
    await rm(join(h.root, 'thing'));
    await mkdir(join(h.root, 'thing'));
    await waitFor(() => h.summary().includes('mkdir thing'));
    const summary = h.summary();
    assert.deepEqual(summary.slice(summary.indexOf('unlink thing')), ['unlink thing', 'mkdir thing']);
  });

  test('a change already recorded in the index is not reported (no echo)', async () => {
    const h = await harness();
    // Simulate a change applied on behalf of the peer: index first, disk second.
    await writeFile(join(h.root, 'from-peer.txt'), 'peer');
    h.index.set('from-peer.txt', await readState(join(h.root, 'from-peer.txt')));
    await sleep(FAST_WATCHER.stabilityMs + FAST_WATCHER.maxWaitMs + 300);
    assert.deepEqual(h.summary(), []);
  });

  test('ignored paths are never reported', async () => {
    const h = await harness({}, { ignore: (path) => path.startsWith('private') });
    await mkdir(join(h.root, 'private'));
    await writeFile(join(h.root, 'private', 'secret.txt'), 'x');
    await writeFile(join(h.root, 'public.txt'), 'y');
    await waitFor(() => h.summary().includes('write public.txt'));
    await sleep(300);
    assert.ok(!h.summary().some((line) => line.includes('private')));
  });

  test('a vanished root is never read as "everything was deleted"', async () => {
    let missing = 0;
    const h = await harness({ 'a.txt': 'a', 'b/c.txt': 'c' }, { onRootMissing: () => (missing += 1) });
    await rm(h.root, { recursive: true, force: true });
    await waitFor(() => missing > 0, { message: 'onRootMissing' });
    await sleep(FAST_WATCHER.renameWindowMs + 200);
    assert.ok(!h.summary().some((line) => line.startsWith('unlink') || line.startsWith('rmdir')));
  });

  test('a renamed directory is still watched at its new location', async () => {
    const h = await harness({ 'dir/a.txt': 'a', 'dir/sub/b.txt': 'b' });
    await rename(join(h.root, 'dir'), join(h.root, 'moved'));
    await waitFor(() => h.summary().includes('rename dir -> moved'));
    h.reset();
    await writeFile(join(h.root, 'moved', 'new.txt'), 'new');
    await appendFile(join(h.root, 'moved', 'sub', 'b.txt'), ' more');
    await waitFor(() => h.summary().includes('write moved/new.txt') && h.summary().includes('write moved/sub/b.txt'), {
      message: 'changes below the renamed directory',
    });
    assert.ok(!h.summary().some((line) => line.includes(' dir/')), 'nothing is attributed to the old name');
  });

  test('a directory recorded in the index first (made for the peer) is watched too', async () => {
    const h = await harness();
    // The owner creates a directory on the peer's behalf: index first, disk second.
    await mkdir(join(h.root, 'made'));
    h.index.set('made', await readState(join(h.root, 'made')));
    await sleep(FAST_WATCHER.maxWaitMs + 100);
    await writeFile(join(h.root, 'made', 'later.txt'), 'later');
    await waitFor(() => h.summary().includes('write made/later.txt'), { message: 'write made/later.txt' });
    assert.ok(!h.summary().includes('mkdir made'), 'the directory itself is not echoed');
  });

  test('deleted directories release their watchers', async () => {
    const h = await harness({ 'a/x.txt': 'x', 'a/b/y.txt': 'y', 'keep/z.txt': 'z' });
    if (h.watcher.recursive) {
      assert.equal(h.watcher.watching, 1, 'one recursive watcher covers the tree');
      return;
    }
    assert.equal(h.watcher.watching, 4, 'the root, a, a/b and keep');
    await rm(join(h.root, 'a'), { recursive: true });
    await waitFor(() => h.summary().includes('rmdir a'));
    await waitFor(() => h.watcher.watching === 2, { message: 'only the root and keep stay watched' });
  });

  test('the inside of an ignoreInside directory is never watched', async () => {
    const h = await harness(
      { 'private/secret.txt': 's', 'public/open.txt': 'o' },
      // Like an unchecked directory on the host, which stays unchecked when renamed.
      { ignore: (path) => /^(private|hidden)\//.test(path), ignoreInside: (path) => path === 'private' || path === 'hidden' },
    );
    if (!h.watcher.recursive) assert.equal(h.watcher.watching, 2, 'the root and public, not private');
    await writeFile(join(h.root, 'private', 'more.txt'), 'm');
    await rename(join(h.root, 'private'), join(h.root, 'hidden'));
    await waitFor(() => h.summary().includes('rename private -> hidden'), { message: 'the rename of the directory itself' });
    assert.ok(!h.summary().some((line) => line.includes('secret') || line.includes('more')));
  });

  test('a file still being written is looked at again after a pause, not in a busy loop', async () => {
    let batches = 0;
    const logger = { debug: (message) => String(message).startsWith('batch:') && (batches += 1), warn() {}, error() {} };
    const h = await harness({}, { logger });
    for (let index = 0; index < 30; index += 1) await writeFile(join(h.root, `young${index}.txt`), 'x');
    await waitFor(() => h.summary().filter((line) => line.startsWith('write')).length === 30, { message: '30 writes' });
    await sleep(200);
    assert.ok(batches <= 6, `30 fresh files took ${batches} batches`);
  });

  test('bursts are batched', async () => {
    const h = await harness();
    for (let index = 0; index < 20; index += 1) await writeFile(join(h.root, `f${index}.txt`), String(index));
    await waitFor(() => h.summary().filter((line) => line.startsWith('write')).length === 20);
    assert.ok(h.batches.length < 20, `20 files arrived in ${h.batches.length} batches`);
  });
});
