/**
 * Path validation (while the user types) and the content tree.
 *
 * Hosting needs an absolute path to an existing, readable directory. Syncing
 * needs an absolute path that is, or can become, a writable directory.
 */
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkHostDirectory, checkSyncDirectory, pathsOverlap } from '../src/fs/pathCheck.js';
import { buildTree, walkTree } from '../src/fs/walk.js';
import { cleanup, startInstance, tempDir, writeTree } from './helpers/instances.js';

after(cleanup);

const isRoot = process.getuid?.() === 0;

describe('directory to host', () => {
  let root;
  before(async () => {
    root = await tempDir();
    await writeTree(root, { 'a.txt': 'a', 'b/': null, 'c/d.txt': 'd' });
  });

  test('an empty value asks for a path', async () => {
    const result = await checkHostDirectory('  ');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'empty');
  });

  test('a relative path is refused', async () => {
    const result = await checkHostDirectory('Documents/photos');
    assert.equal(result.code, 'not_absolute');
    assert.match(result.message, /absolute/);
  });

  test('a path that does not exist is reported', async () => {
    const result = await checkHostDirectory(join(root, 'missing'));
    assert.equal(result.code, 'not_found');
  });

  test('a file is not a directory', async () => {
    const result = await checkHostDirectory(join(root, 'a.txt'));
    assert.equal(result.code, 'not_directory');
  });

  test('a readable directory is accepted, with its size', async () => {
    const result = await checkHostDirectory(root);
    assert.equal(result.ok, true);
    assert.equal(result.entries, 3);
    assert.match(result.message, /3 items/);
    assert.equal(result.path, root);
  });

  test('a directory whose content cannot be read is refused', { skip: isRoot && 'root can read anything' }, async () => {
    const locked = join(root, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const result = await checkHostDirectory(locked);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'unreadable');
    } finally {
      await chmod(locked, 0o755);
    }
  });

  test('the check is available to the control panel while typing', async () => {
    const instance = await startInstance();
    const good = await instance.api('POST', '/api/paths/check', { path: root, purpose: 'host' });
    assert.equal(good.status, 200);
    assert.equal(good.data.ok, true);
    const bad = await instance.api('POST', '/api/paths/check', { path: 'relative', purpose: 'host' });
    assert.equal(bad.data.ok, false);
    const unknown = await instance.api('POST', '/api/paths/check', { path: root, purpose: 'nope' });
    assert.equal(unknown.status, 400);
  });
});

describe('directory to sync into', () => {
  test('a missing directory will be created when its parent is writable', async () => {
    const parent = await tempDir();
    const result = await checkSyncDirectory(join(parent, 'new', 'deeper'));
    assert.equal(result.ok, true);
    assert.equal(result.code, 'will_create');
    assert.equal(result.exists, false);
  });

  test('an empty existing directory is fine', async () => {
    const directory = await tempDir();
    const result = await checkSyncDirectory(directory);
    assert.equal(result.code, 'empty_directory');
    assert.equal(result.empty, true);
  });

  test('a non-empty directory is accepted with a merge warning', async () => {
    const directory = await tempDir();
    await writeFile(join(directory, 'x'), 'x');
    const result = await checkSyncDirectory(directory);
    assert.equal(result.ok, true);
    assert.equal(result.code, 'existing_directory');
    assert.match(result.message, /merged/);
  });

  test('a file, a relative path and the filesystem root are refused', async () => {
    const directory = await tempDir();
    await writeFile(join(directory, 'f'), 'f');
    assert.equal((await checkSyncDirectory(join(directory, 'f'))).code, 'not_directory');
    assert.equal((await checkSyncDirectory(join(directory, 'f', 'below'))).code, 'parent_not_directory');
    assert.equal((await checkSyncDirectory('relative/dir')).code, 'not_absolute');
    assert.equal((await checkSyncDirectory('/')).code, 'root');
  });

  test('a directory that cannot be written is refused', { skip: isRoot && 'root can write anything' }, async () => {
    const directory = await tempDir();
    await chmod(directory, 0o555);
    try {
      assert.equal((await checkSyncDirectory(directory)).code, 'not_writable');
      assert.equal((await checkSyncDirectory(join(directory, 'child'))).code, 'not_writable');
    } finally {
      await chmod(directory, 0o755);
    }
  });

  test('overlapping paths are detected', () => {
    assert.ok(pathsOverlap('/a/b', '/a/b'));
    assert.ok(pathsOverlap('/a/b', '/a/b/c'));
    assert.ok(pathsOverlap('/a/b/c', '/a/b'));
    assert.ok(!pathsOverlap('/a/b', '/a/bc'));
  });
});

describe('content tree', () => {
  test('lists everything, directories first, in natural order, flagging links', async () => {
    const root = await tempDir();
    await writeTree(root, { 'file10.txt': '10', 'file2.txt': '2', 'Zeta/': null, 'alpha/inner.txt': 'abc', 'beta/': null });
    await symlink('/etc/hostname', join(root, 'link'));
    const { tree, total } = await buildTree(root);
    assert.equal(total, 7);
    assert.deepEqual(
      tree.children.map((node) => [node.name, node.kind]),
      [
        ['alpha', 'dir'],
        ['beta', 'dir'],
        ['Zeta', 'dir'],
        ['file2.txt', 'file'],
        ['file10.txt', 'file'],
        ['link', 'other'],
      ],
    );
    assert.equal(tree.children[0].children[0].path, 'alpha/inner.txt');
    assert.equal(tree.children[0].children[0].size, 3);
  });

  test('an unreadable subdirectory is listed with an error instead of failing', { skip: isRoot && 'root can read anything' }, async () => {
    const root = await tempDir();
    await writeTree(root, { 'open/x': 'x', 'closed/y': 'y' });
    await chmod(join(root, 'closed'), 0o000);
    try {
      const { tree } = await buildTree(root);
      const closed = tree.children.find((node) => node.name === 'closed');
      assert.match(closed.error, /Permission denied/);
    } finally {
      await chmod(join(root, 'closed'), 0o755);
    }
  });

  test('the walk never reports symlinks or temporary transfer files', async () => {
    const root = await tempDir();
    await writeTree(root, { 'real.txt': 'r', '.reptile-0123456789abcdef.tmp': 'partial' });
    await symlink(join(root, 'real.txt'), join(root, 'alias'));
    const { entries } = await walkTree(root);
    assert.deepEqual([...entries.keys()], ['real.txt']);
  });

  test('the control panel receives the tree of a verified directory', async () => {
    const root = await tempDir();
    await writeTree(root, { 'docs/a.md': '#' });
    const instance = await startInstance();
    const answer = await instance.api('POST', '/api/paths/tree', { path: root });
    assert.equal(answer.status, 200);
    assert.equal(answer.data.total, 2);
    assert.equal(answer.data.tree.children[0].path, 'docs');
    const refused = await instance.api('POST', '/api/paths/tree', { path: join(root, 'nope') });
    assert.equal(refused.status, 400);
  });
});
