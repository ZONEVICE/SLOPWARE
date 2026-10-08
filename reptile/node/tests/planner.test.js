/**
 * The three-way reconciliation planner: who wins, path by path.
 *
 * The planner is pure, so every rule of the initial synchronisation (and of
 * every resynchronisation after a reconnect) is checked here without a disk.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashCandidates, planSync } from '../src/domain/planner.js';

const file = (size, mtimeMs) => ({ kind: 'file', size, mtimeMs });
const dir = () => ({ kind: 'dir', size: 0, mtimeMs: 1 });
const map = (object) => new Map(Object.entries(object));

/** Plan and return `{ path: type }` plus the conflicts. */
function plan({ local = {}, remote = {}, base = {}, rejected = [], equal = [] }) {
  const result = planSync({
    local: map(local),
    remote: map(remote),
    base: map(base),
    isRejected: (path) => rejected.some((r) => path === r || path.startsWith(`${r}/`)),
    equalContent: new Set(equal),
  });
  return { types: Object.fromEntries(result.actions.map((action) => [action.path, action.type])), conflicts: result.conflicts.map((c) => c.path) };
}

describe('first synchronisation (no base): a merge that never deletes', () => {
  test('everything the host has is downloaded into an empty directory', () => {
    const { types } = plan({ remote: { docs: dir(), 'docs/a.txt': file(3, 10), 'b.bin': file(9, 11) } });
    assert.deepEqual(types, { docs: 'local-mkdir', 'docs/a.txt': 'download', 'b.bin': 'download' });
  });

  test('what only the peer has is uploaded to the host', () => {
    const { types } = plan({ local: { mine: dir(), 'mine/x': file(1, 5) } });
    assert.deepEqual(types, { mine: 'remote-mkdir', 'mine/x': 'upload' });
  });

  test('identical files are left alone and become the base', () => {
    const { types } = plan({ local: { a: file(3, 10) }, remote: { a: file(3, 10) } });
    assert.deepEqual(types, { a: 'in-sync' });
  });

  test('different versions: the newer one wins', () => {
    assert.deepEqual(plan({ local: { a: file(3, 20) }, remote: { a: file(4, 10) } }).types, { a: 'upload' });
    assert.deepEqual(plan({ local: { a: file(3, 10) }, remote: { a: file(4, 20) } }).types, { a: 'download' });
  });

  test('a tie goes to the host', () => {
    assert.deepEqual(plan({ local: { a: file(3, 10) }, remote: { a: file(4, 10) } }).types, { a: 'download' });
  });

  test('same bytes with different mtimes are not copied, the mtime is aligned', () => {
    const { types } = plan({ local: { a: file(3, 10) }, remote: { a: file(3, 99) }, equal: ['a'] });
    assert.deepEqual(types, { a: 'adopt-mtime' });
  });

  test('a file on one side and a directory on the other is a conflict, left alone with its content', () => {
    const { types, conflicts } = plan({ local: { x: file(1, 1) }, remote: { x: dir(), 'x/inside': file(2, 2) } });
    assert.deepEqual(conflicts, ['x']);
    assert.deepEqual(types, {});
  });

  test('paths the host refused are not pushed again', () => {
    const { types } = plan({ local: { secret: dir(), 'secret/pw': file(1, 1), ok: file(2, 2) }, rejected: ['secret'] });
    assert.deepEqual(types, { ok: 'upload' });
  });
});

describe('resynchronisation (with a base): deletions are understood', () => {
  const base = { a: file(3, 10), d: dir(), 'd/x': file(1, 10) };

  test('nothing changed: nothing to do', () => {
    const { types } = plan({ local: base, remote: base, base });
    assert.deepEqual(new Set(Object.values(types)), new Set(['in-sync']));
  });

  test('deleted here while disconnected: deleted on the host', () => {
    const { types } = plan({ local: { d: dir(), 'd/x': file(1, 10) }, remote: base, base });
    assert.equal(types.a, 'remote-delete');
  });

  test('deleted on the host while disconnected: deleted here', () => {
    const { types } = plan({ local: base, remote: { d: dir(), 'd/x': file(1, 10) }, base });
    assert.equal(types.a, 'local-delete');
  });

  test('modified on one side only: that side wins', () => {
    assert.equal(plan({ local: { ...base, a: file(5, 50) }, remote: base, base }).types.a, 'upload');
    assert.equal(plan({ local: base, remote: { ...base, a: file(5, 50) }, base }).types.a, 'download');
  });

  test('modified on both sides: the newer wins', () => {
    assert.equal(plan({ local: { ...base, a: file(5, 50) }, remote: { ...base, a: file(6, 60) }, base }).types.a, 'download');
    assert.equal(plan({ local: { ...base, a: file(5, 70) }, remote: { ...base, a: file(6, 60) }, base }).types.a, 'upload');
  });

  test('a modification beats a deletion, in both directions', () => {
    assert.equal(plan({ local: { d: dir(), 'd/x': file(1, 10) }, remote: { ...base, a: file(9, 90) }, base }).types.a, 'download');
    assert.equal(plan({ local: { ...base, a: file(9, 90) }, remote: { d: dir(), 'd/x': file(1, 10) }, base }).types.a, 'upload');
  });

  test('a directory deleted on the host keeps living here if it received a new file', () => {
    const { types } = plan({
      local: { ...base, 'd/new': file(4, 40) },
      remote: { a: file(3, 10) },
      base,
    });
    assert.equal(types['d/x'], 'local-delete');
    assert.equal(types['d/new'], 'upload');
    assert.equal(types.d, 'remote-mkdir', 'the directory is recreated on the host instead of deleted here');
  });

  test('a directory deleted here is recreated here if the host added a file to it', () => {
    const { types } = plan({
      local: { a: file(3, 10) },
      remote: { ...base, 'd/new': file(4, 40) },
      base,
    });
    assert.equal(types['d/x'], 'remote-delete');
    assert.equal(types['d/new'], 'download');
    assert.equal(types.d, 'local-mkdir');
  });

  test('a whole tree deleted on one side is deleted on the other', () => {
    const { types } = plan({ local: { a: file(3, 10) }, remote: base, base });
    assert.equal(types.d, 'remote-delete');
    assert.equal(types['d/x'], 'remote-delete');
  });

  test('both sides deleted: the base entry is forgotten', () => {
    const { types } = plan({ local: { d: dir(), 'd/x': file(1, 10) }, remote: { d: dir(), 'd/x': file(1, 10) }, base });
    assert.equal(types.a, 'forget');
  });

  test('a directory replaced by a file on the host, untouched here, becomes a file here', () => {
    const { types } = plan({ local: { d: dir(), 'd/x': file(1, 10) }, remote: { d: file(7, 70) }, base: { d: dir(), 'd/x': file(1, 10) } });
    assert.equal(types['d/x'], 'local-delete');
    assert.equal(types.d, 'download');
  });

  test('...but not when something here must stay inside it', () => {
    const { types, conflicts } = plan({
      local: { d: dir(), 'd/x': file(1, 10), 'd/mine': file(2, 20) },
      remote: { d: file(7, 70) },
      base: { d: dir(), 'd/x': file(1, 10) },
    });
    assert.deepEqual(conflicts, ['d']);
    assert.equal(types.d, undefined);
  });
});

describe('hash candidates', () => {
  test('only same-size files whose difference the base cannot explain', () => {
    const local = map({ a: file(3, 10), b: file(3, 10), c: file(4, 10), d: file(3, 10) });
    const remote = map({ a: file(3, 20), b: file(3, 10), c: file(5, 20), d: file(3, 30) });
    const base = map({ d: file(3, 10) });
    assert.deepEqual(hashCandidates({ local, remote, base }), ['a']);
  });
});
