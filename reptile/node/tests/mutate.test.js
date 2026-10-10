import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { stageFile } from '../src/fs/mutate.js';

// On Windows a read-only target makes the rename fail; commit must clear the
// attribute and retry, or a read-only file on the peer would never be updated.
// POSIX replaces a file in a writable directory regardless, so this is win32 only.
test(
  'commit replaces a read-only file (Windows)',
  { skip: process.platform !== 'win32' ? 'read-only replace only fails on Windows' : false },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'reptile-mutate-'));
    try {
      const target = join(root, 'readme.txt');
      await writeFile(target, 'old');
      await chmod(target, 0o444); // read-only on Windows

      const staged = await stageFile(root, 'readme.txt', Readable.from(Buffer.from('new content')), {
        size: 11,
        mtimeMs: 1_600_000_000_000,
      });
      await staged.commit();
      assert.equal(await readFile(target, 'utf8'), 'new content');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// On POSIX a failed rename has another cause (here the directory became
// read-only after staging); the read-only retry must not grant the owner write
// access to the user's file on its way to failing anyway.
test(
  'a failed commit leaves the target file permissions alone (POSIX)',
  {
    skip:
      process.platform === 'win32'
        ? 'POSIX permissions only'
        : process.getuid?.() === 0
          ? 'root ignores directory permissions'
          : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'reptile-mutate-'));
    try {
      const target = join(root, 'readme.txt');
      await writeFile(target, 'old');
      await chmod(target, 0o444);

      const staged = await stageFile(root, 'readme.txt', Readable.from(Buffer.from('new content')), {
        size: 11,
        mtimeMs: 1_600_000_000_000,
      });
      await chmod(root, 0o555);
      await assert.rejects(staged.commit(), { code: 'EACCES' });
      assert.equal((await stat(target)).mode & 0o777, 0o444);
      assert.equal(await readFile(target, 'utf8'), 'old');
    } finally {
      await chmod(root, 0o755);
      await rm(root, { recursive: true, force: true });
    }
  },
);
