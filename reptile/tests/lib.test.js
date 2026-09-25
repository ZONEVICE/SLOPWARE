/**
 * Pure helpers: addresses and subnets, wire paths, NDJSON framing, the
 * concurrency primitives, the event bus, PIN rules, entry states and the
 * file index.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/lib/events.js';
import { safeEqual } from '../src/lib/ids.js';
import {
  defaultScanHosts,
  formatPortRanges,
  intToIpv4,
  ipv4ToInt,
  isLoopbackAddress,
  isPrivateIpv4,
  lanAddresses,
  localAddresses,
  machineFingerprint,
  normalizeAddress,
  parseHostSpec,
  parsePortSpec,
  prefixFromNetmask,
  primaryAddress,
  subnetHosts,
} from '../src/lib/net.js';
import { createLineParser, encodeLine } from '../src/lib/ndjson.js';
import { backoffDelay, Mutex, runPool, SerialQueue, sleep } from '../src/lib/queue.js';
import {
  ancestorsOf,
  compareWirePaths,
  depthOf,
  isSameOrInside,
  isStrictlyInside,
  normalizeWirePath,
  parentOf,
  rebase,
  resolveWirePath,
  sortWirePaths,
  wirePathOf,
} from '../src/lib/wirePath.js';
import { assertPin, generatePin, pinMatches } from '../src/domain/pin.js';
import { AppError, toAppError } from '../src/domain/errors.js';
import { identityKey, isTempName, roundMtime, sameState, tempName } from '../src/fs/entry.js';
import { commitOp, FileIndex } from '../src/fs/fileIndex.js';

/** A fake `os.networkInterfaces()` with a LAN card, Docker and loopback. */
const fakeInterfaces = () => ({
  lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00', cidr: '127.0.0.1/8' }],
  docker0: [{ address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', internal: false, mac: '02:42:aa:bb:cc:dd', cidr: '172.17.0.1/16' }],
  wlp0s20f3: [
    { address: '192.168.0.246', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: 'aa:bb:cc:dd:ee:ff', cidr: '192.168.0.246/24' },
    { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false, mac: 'aa:bb:cc:dd:ee:ff', cidr: 'fe80::1/64' },
  ],
});

describe('IPv4 arithmetic', () => {
  test('dotted quads convert both ways', () => {
    assert.equal(ipv4ToInt('192.168.0.1'), 0xc0a80001);
    assert.equal(intToIpv4(0xc0a80001), '192.168.0.1');
    assert.equal(ipv4ToInt('255.255.255.255'), 0xffffffff);
    assert.equal(ipv4ToInt('256.1.1.1'), null);
    assert.equal(ipv4ToInt('1.2.3'), null);
    assert.equal(ipv4ToInt('a.b.c.d'), null);
  });

  test('netmasks become prefix lengths', () => {
    assert.equal(prefixFromNetmask('255.255.255.0'), 24);
    assert.equal(prefixFromNetmask('255.255.0.0'), 16);
    assert.equal(prefixFromNetmask('255.255.255.252'), 30);
  });

  test('a /24 lists its 254 usable hosts', () => {
    const hosts = subnetHosts('192.168.1.77', 24);
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], '192.168.1.1');
    assert.equal(hosts.at(-1), '192.168.1.254');
  });

  test('wider subnets are narrowed to the /24 around the address', () => {
    const hosts = subnetHosts('10.20.30.40', 16);
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], '10.20.30.1');
  });

  test('narrower subnets are respected', () => {
    assert.deepEqual(subnetHosts('192.168.1.5', 30), ['192.168.1.5', '192.168.1.6']);
    assert.deepEqual(subnetHosts('192.168.1.5', 32), ['192.168.1.5']);
  });

  test('private ranges and loopback are recognised', () => {
    assert.ok(isPrivateIpv4('192.168.3.4'));
    assert.ok(isPrivateIpv4('10.0.0.1'));
    assert.ok(isPrivateIpv4('172.20.1.1'));
    assert.ok(!isPrivateIpv4('8.8.8.8'));
    assert.ok(isLoopbackAddress('127.0.0.1'));
    assert.ok(isLoopbackAddress('::ffff:127.0.0.1'));
    assert.ok(isLoopbackAddress('::1'));
    assert.ok(!isLoopbackAddress('192.168.0.2'));
    assert.equal(normalizeAddress('::ffff:192.168.0.9'), '192.168.0.9');
  });
});

describe('local interfaces', () => {
  test('virtual interfaces (Docker, VPNs) are not the LAN', () => {
    assert.deepEqual(lanAddresses(fakeInterfaces), ['192.168.0.246']);
    assert.equal(primaryAddress(fakeInterfaces), '192.168.0.246');
  });

  test('with no LAN at all, loopback is the primary address', () => {
    assert.equal(primaryAddress(() => ({ lo: fakeInterfaces().lo })), '127.0.0.1');
  });

  test('scan targets are the LAN /24 plus loopback, never the Docker /16', () => {
    const hosts = defaultScanHosts(fakeInterfaces);
    assert.ok(hosts.includes('127.0.0.1'));
    assert.ok(hosts.includes('192.168.0.1'));
    assert.ok(hosts.includes('192.168.0.254'));
    assert.ok(!hosts.some((host) => host.startsWith('172.17.')));
    assert.equal(hosts.length, 255);
  });

  test('every own address is recognised, IPv6 included', () => {
    const own = localAddresses(fakeInterfaces);
    for (const address of ['127.0.0.1', '::1', '192.168.0.246', '172.17.0.1', 'fe80::1']) assert.ok(own.has(address), address);
  });

  test('the machine fingerprint is stable and depends on the hardware', () => {
    assert.equal(machineFingerprint(fakeInterfaces), machineFingerprint(fakeInterfaces));
    assert.notEqual(machineFingerprint(fakeInterfaces), machineFingerprint(() => ({})));
  });

  test('port lists are described as ranges', () => {
    assert.equal(formatPortRanges([55669, 55667, 55668, 8080, 8081, 9000]), '8080-8081, 9000, 55667-55669');
    assert.equal(formatPortRanges([]), '');
  });

  test('host and port specifications expand', () => {
    assert.deepEqual(parseHostSpec('10.0.0.7, 127.0.0.1'), ['10.0.0.7', '127.0.0.1']);
    assert.equal(parseHostSpec('192.168.5.0/24').length, 254);
    assert.deepEqual(parseHostSpec('nonsense,300.1.1.1'), []);
    assert.deepEqual(parsePortSpec('55667-55669,8080'), [55667, 55668, 55669, 8080]);
    assert.deepEqual(parsePortSpec('70000,x,0'), []);
  });
});

describe('wire paths', () => {
  test('valid paths are canonicalised', () => {
    assert.equal(normalizeWirePath('a/b/c.txt'), 'a/b/c.txt');
    assert.equal(normalizeWirePath('/a/b/'), 'a/b');
    assert.equal(normalizeWirePath('', { allowRoot: true }), '');
    assert.equal(normalizeWirePath(''), null);
  });

  test('anything that could escape the root is refused', () => {
    for (const bad of ['../etc/passwd', 'a/../../b', 'a//b', './a', 'a/./b', 'a\0b', 42, null]) {
      assert.equal(normalizeWirePath(bad), null, String(bad));
    }
  });

  test('joining onto the root re-checks containment', () => {
    assert.equal(resolveWirePath('/srv/share', 'a/b'), '/srv/share/a/b');
    assert.equal(resolveWirePath('/srv/share', ''), '/srv/share');
    assert.throws(() => resolveWirePath('/srv/share', '../x'), /escapes/);
    assert.equal(wirePathOf('/srv/share', '/srv/share/a/b'), 'a/b');
    assert.equal(wirePathOf('/srv/share', '/srv/other'), null);
  });

  test('family relations', () => {
    assert.equal(parentOf('a/b/c'), 'a/b');
    assert.equal(parentOf('a'), '');
    assert.deepEqual(ancestorsOf('a/b/c'), ['a/b', 'a']);
    assert.equal(depthOf(''), 0);
    assert.equal(depthOf('a/b'), 2);
    assert.ok(isSameOrInside('a', 'a'));
    assert.ok(isSameOrInside('a', 'a/b'));
    assert.ok(!isSameOrInside('a', 'ab'));
    assert.ok(isStrictlyInside('', 'a'));
    assert.ok(!isStrictlyInside('a', 'a'));
    assert.equal(rebase('a/b/c', 'a/b', 'x'), 'x/c');
    assert.equal(rebase('a/b', 'a/b', 'x/y'), 'x/y');
  });

  test('sorting keeps every parent before its children', () => {
    const sorted = ['a/b', 'a-b', 'a', 'a/b/c', 'b'].sort(compareWirePaths);
    assert.deepEqual(sorted, ['a', 'a/b', 'a/b/c', 'a-b', 'b']);
  });

  test('the fast sort agrees with the comparator', () => {
    const paths = ['z', 'a/b', 'a-b', 'a', 'a/b/c', 'b', 'a.b/c', 'a/a', 'A', 'ä/x', 'a b', 'a/b-c', 'a/b/c/d'];
    assert.deepEqual(sortWirePaths(paths), [...paths].sort(compareWirePaths));
  });
});

describe('NDJSON framing', () => {
  test('messages survive arbitrary chunking', () => {
    const received = [];
    const parse = createLineParser((message) => received.push(message));
    const wire = encodeLine({ a: 1 }) + encodeLine({ b: 'x\ny' }) + encodeLine({ c: [1, 2] });
    for (let index = 0; index < wire.length; index += 3) parse(wire.slice(index, index + 3));
    assert.deepEqual(received, [{ a: 1 }, { b: 'x\ny' }, { c: [1, 2] }]);
  });

  test('a malformed line is reported and skipped', () => {
    const received = [];
    const errors = [];
    const parse = createLineParser((message) => received.push(message), { onError: (error) => errors.push(error) });
    parse('{"ok":1}\nnot json\n{"ok":2}\n');
    assert.deepEqual(received, [{ ok: 1 }, { ok: 2 }]);
    assert.equal(errors.length, 1);
  });
});

describe('concurrency primitives', () => {
  test('a serial queue runs one task at a time, in order', async () => {
    const queue = new SerialQueue();
    const log = [];
    let running = 0;
    const task = (name, ms) => async () => {
      running += 1;
      assert.equal(running, 1);
      await sleep(ms);
      log.push(name);
      running -= 1;
      return name;
    };
    const results = await Promise.all([queue.push(task('a', 20)), queue.push(task('b', 5)), queue.push(task('c', 1))]);
    assert.deepEqual(log, ['a', 'b', 'c']);
    assert.deepEqual(results, ['a', 'b', 'c']);
  });

  test('clearing a queue drops tasks that have not started', async () => {
    const queue = new SerialQueue();
    const log = [];
    const first = queue.push(async () => {
      await sleep(20);
      log.push('first');
    });
    const second = queue.push(async () => log.push('second'));
    queue.clear();
    await Promise.all([first, second]);
    await queue.idle();
    assert.deepEqual(log, ['first']);
  });

  test('a failing task rejects its own promise only', async () => {
    const queue = new SerialQueue();
    await assert.rejects(queue.push(async () => {
      throw new Error('boom');
    }));
    assert.equal(await queue.push(async () => 'still works'), 'still works');
  });

  test('a mutex serialises sections', async () => {
    const mutex = new Mutex();
    let inside = 0;
    let maximum = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        mutex.run(async () => {
          inside += 1;
          maximum = Math.max(maximum, inside);
          await sleep(2);
          inside -= 1;
        }),
      ),
    );
    assert.equal(maximum, 1);
  });

  test('a pool bounds concurrency and collects failures', async () => {
    let inFlight = 0;
    let maximum = 0;
    const failures = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      inFlight += 1;
      maximum = Math.max(maximum, inFlight);
      await sleep(5);
      inFlight -= 1;
      if (item === 4) throw new Error('four');
    });
    assert.equal(maximum, 3);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].item, 4);
  });

  test('backoff grows and is capped', () => {
    assert.equal(backoffDelay(0, { baseMs: 100, maxMs: 1000 }), 100);
    assert.equal(backoffDelay(3, { baseMs: 100, maxMs: 1000 }), 800);
    assert.equal(backoffDelay(10, { baseMs: 100, maxMs: 1000 }), 1000);
  });
});

describe('event bus', () => {
  test('delivers in order and survives a throwing listener', () => {
    const errors = [];
    const bus = new EventBus({ onError: (error) => errors.push(error) });
    const seen = [];
    bus.on('x', () => {
      throw new Error('broken listener');
    });
    const off = bus.on('x', (payload) => seen.push(payload));
    bus.emit('x', 1);
    off();
    bus.emit('x', 2);
    assert.deepEqual(seen, [1]);
    assert.equal(errors.length, 2);
  });
});

describe('PIN rules', () => {
  test('generated PINs are four digits, zero padded', () => {
    for (let index = 0; index < 200; index += 1) assert.match(generatePin(), /^\d{4}$/);
  });

  test('only exactly four digits are accepted', () => {
    assert.equal(assertPin('0042'), '0042');
    assert.equal(assertPin(' 1234 '), '1234');
    for (const bad of ['123', '12345', 'abcd', '12 4', '', null, undefined]) {
      assert.throws(() => assertPin(bad), (error) => error.code === 'pin_format');
    }
  });

  test('comparison is exact', () => {
    assert.ok(pinMatches('1234', '1234'));
    assert.ok(!pinMatches('1235', '1234'));
    assert.ok(!pinMatches(1234, '1234'));
    assert.ok(safeEqual('a', 'a'));
    assert.ok(!safeEqual('a', 'ab'));
  });
});

describe('errors', () => {
  test('unknown errors become opaque 500s', () => {
    const wrapped = toAppError(new Error('secret internals'));
    assert.equal(wrapped.status, 500);
    assert.equal(wrapped.toJSON().message, 'Something went wrong.');
    const known = new AppError('busy', 'Busy.', { status: 409 });
    assert.equal(toAppError(known), known);
  });
});

describe('entry states and the file index', () => {
  test('states compare by kind, size and mtime', () => {
    const file = { kind: 'file', size: 3, mtimeMs: 1000 };
    assert.ok(sameState(file, { ...file, ino: 99 }));
    assert.ok(!sameState(file, { ...file, size: 4 }));
    assert.ok(!sameState(file, { ...file, mtimeMs: 1001 }));
    assert.ok(sameState({ kind: 'dir', size: 0, mtimeMs: 1 }, { kind: 'dir', size: 0, mtimeMs: 2 }));
    assert.ok(sameState(null, undefined));
    assert.ok(!sameState(file, null));
    assert.ok(!sameState(file, { kind: 'dir', size: 0, mtimeMs: 1000 }));
  });

  test('mtimes are rounded, not truncated', () => {
    assert.equal(roundMtime(1695555555122.9999), 1695555555123);
    assert.equal(roundMtime(1695555555123.2), 1695555555123);
  });

  test('temporary names are recognised', () => {
    assert.ok(isTempName(tempName()));
    assert.ok(!isTempName('.reptile-notes.txt'));
    assert.ok(!isTempName('report.tmp'));
  });

  test('the index follows renames with every descendant and keeps identities', () => {
    const index = new FileIndex();
    index.set('a', { kind: 'dir', size: 0, mtimeMs: 1, ino: 1, dev: 1 });
    index.set('a/x', { kind: 'file', size: 5, mtimeMs: 2, ino: 2, dev: 1 });
    index.set('a/y/z', { kind: 'file', size: 6, mtimeMs: 3, ino: 3, dev: 1 });
    index.set('ab', { kind: 'file', size: 7, mtimeMs: 4, ino: 4, dev: 1 });
    index.rekey('a', 'b');
    assert.deepEqual([...index.entries.keys()].sort(), ['ab', 'b', 'b/x', 'b/y/z']);
    assert.equal(index.pathForIdentity(identityKey({ ino: 3, dev: 1 })), 'b/y/z');
    assert.equal(index.pathForIdentity('1:999'), null);
    index.deleteTree('b');
    assert.deepEqual([...index.entries.keys()], ['ab']);
  });

  test('committing operations updates the index like the disk', () => {
    const index = new FileIndex();
    commitOp(index, { op: 'mkdir', path: 'd', state: { kind: 'dir', size: 0, mtimeMs: 1, ino: 1, dev: 1 } });
    commitOp(index, { op: 'write', path: 'd/f', state: { kind: 'file', size: 1, mtimeMs: 1, ino: 2, dev: 1 } });
    commitOp(index, { op: 'rename', from: 'd', to: 'e', state: { kind: 'dir', size: 0, mtimeMs: 1, ino: 1, dev: 1 } });
    assert.deepEqual([...index.entries.keys()].sort(), ['e', 'e/f']);
    commitOp(index, { op: 'unlink', path: 'e/f' });
    commitOp(index, { op: 'rmdir', path: 'e' });
    assert.equal(index.size, 0);
  });
});

describe('reporters', () => {
  test('the console reporter narrates events and detaches cleanly', async () => {
    const { attachReporters } = await import('../src/reporters/index.js');
    const { EVENTS } = await import('../src/lib/events.js');
    const lines = [];
    const logger = { child: () => ({ info: (line) => lines.push(line), warn: (line) => lines.push(`WARN ${line}`) }) };
    const bus = new EventBus();
    const detach = attachReporters({ bus, logger });
    bus.emit(EVENTS.HOSTING_PEER_CONNECTED, { peer: { hostname: 'laptop', address: '10.0.0.2' } });
    bus.emit(EVENTS.HOSTING_PIN_CHANGED, { disconnected: true });
    bus.emit(EVENTS.SYNC_STATE, { state: 'pin_required' });
    bus.emit(EVENTS.HOSTING_STOPPED, { name: 'X', reason: 'root_missing' });
    assert.deepEqual(lines, [
      'laptop (10.0.0.2) connected',
      'the PIN was changed; the connected instance was disconnected',
      'sync: the host changed the PIN; enter the new one in the control panel',
      'WARN stopped hosting "X": the directory disappeared',
    ]);
    detach();
    bus.emit(EVENTS.SYNC_STATE, { state: 'live' });
    assert.equal(lines.length, 4);
  });
});

describe('file index structure', () => {
  test('descendants are found even when intermediate directories are not indexed', () => {
    const index = new FileIndex();
    index.set('a/b/c/d.txt', { kind: 'file', size: 1, mtimeMs: 1, ino: 1, dev: 1 });
    index.set('a/e.txt', { kind: 'file', size: 1, mtimeMs: 1, ino: 2, dev: 1 });
    assert.deepEqual([...index.descendants('a')].map(([path]) => path).sort(), ['a/b/c/d.txt', 'a/e.txt']);
    assert.deepEqual([...index.descendants('')].map(([path]) => path).sort(), ['a/b/c/d.txt', 'a/e.txt']);
    index.delete('a/b/c/d.txt');
    assert.deepEqual([...index.descendants('a')].map(([path]) => path), ['a/e.txt']);
    assert.equal(index.children.has('a/b'), false, 'empty virtual nodes are cleaned up');
  });

  test('deleting a directory entry keeps its children reachable until they go too', () => {
    const index = new FileIndex();
    index.set('d', { kind: 'dir', size: 0, mtimeMs: 1, ino: 1, dev: 1 });
    index.set('d/f', { kind: 'file', size: 1, mtimeMs: 1, ino: 2, dev: 1 });
    index.delete('d');
    assert.deepEqual([...index.descendants('d')].map(([path]) => path), ['d/f']);
    index.deleteTree('d');
    assert.equal(index.size, 0);
    assert.equal(index.children.size, 0);
  });

  test('subtree operations scale with the subtree, not the index', () => {
    const index = new FileIndex();
    for (let dir = 0; dir < 2000; dir += 1) {
      index.set(`p${dir}`, { kind: 'dir', size: 0, mtimeMs: 1, ino: dir * 10, dev: 1 });
      for (let file = 0; file < 10; file += 1) index.set(`p${dir}/f${file}`, { kind: 'file', size: 1, mtimeMs: 1, ino: dir * 10 + file + 1, dev: 9 });
    }
    const started = process.hrtime.bigint();
    for (let dir = 0; dir < 2000; dir += 1) index.deleteTree(`p${dir}`);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(index.size, 0);
    assert.ok(ms < 500, `2000 subtree deletions took ${ms.toFixed(0)} ms`);
  });
});
