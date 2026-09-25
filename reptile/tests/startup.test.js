/**
 * Startup: command-line flags and the free-port search.
 *
 * A busy port must never stop Reptile from starting: it walks upwards
 * (55667 -> 55668 -> 55669...) until a bind succeeds, and that applies to an
 * explicit --port too. The tests hold real ports with placeholder servers
 * chosen by the OS, so they never depend on 55667 itself being free (a real
 * Reptile may well be running on this machine).
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { createConfig, DEFAULT_PORT, parseArgs, SCAN_PORT_COUNT } from '../src/config.js';
import { listenWithFallback } from '../src/lib/listen.js';
import { createLogger } from '../src/lib/logger.js';
import { cleanup, tempDir } from './helpers/instances.js';

after(cleanup);

function hold(port) {
  return new Promise((resolve, reject) => {
    const server = createServer(() => {});
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const release = (server) => new Promise((resolve) => server.close(resolve));

/** Reserve `count` consecutive free ports, retrying from different OS-chosen bases. */
async function reserveRun(count) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = await hold(0);
    const base = probe.address().port;
    await release(probe);
    if (base + count > 65535) continue;
    const servers = [];
    let complete = true;
    for (let offset = 0; offset < count; offset += 1) {
      try {
        servers.push(await hold(base + offset));
      } catch {
        complete = false;
        break;
      }
    }
    if (complete) {
      return {
        base,
        async releaseFrom(index) {
          for (const server of servers.splice(index)) await release(server);
        },
        async releaseAll() {
          for (const server of servers.splice(0)) await release(server);
        },
      };
    }
    for (const server of servers) await release(server);
  }
  throw new Error('could not reserve a run of consecutive free ports');
}

async function makeApp(overrides = {}) {
  const certDir = await tempDir();
  const config = createConfig([], { host: '127.0.0.1', logLevel: 'silent', certDir, discovery: { enabled: false }, ...overrides });
  const app = await createApp({ config, logger: createLogger('test', { level: 'silent' }) });
  return app;
}

describe('command line', () => {
  test('HTTP is the default, --http and --https select the protocol', () => {
    assert.equal(createConfig([]).protocol, 'http');
    assert.equal(createConfig(['--http']).protocol, 'http');
    assert.equal(createConfig(['--https']).protocol, 'https');
  });

  test('the default port is 55667 and --port changes it', () => {
    assert.equal(DEFAULT_PORT, 55667);
    assert.equal(createConfig([]).port, 55667);
    assert.equal(createConfig(['--port', '8080']).port, 8080);
    assert.equal(createConfig(['--port=9000']).port, 9000);
    assert.equal(createConfig(['-p', '7000', '--https']).protocol, 'https');
  });

  test('npm passes flags after "--" untouched, in any order', () => {
    const args = parseArgs(['--https', '--port', '8443', '--no-scan', '--remote-ui', '--bogus']);
    assert.equal(args.protocol, 'https');
    assert.equal(args.port, 8443);
    assert.equal(args.scan, false);
    assert.equal(args.remoteUi, true);
    assert.deepEqual(args.unknown, ['--bogus']);
  });

  test('discovery scans the default port and the following ones', () => {
    const { ports } = createConfig([]).discovery;
    assert.equal(ports.length, SCAN_PORT_COUNT);
    assert.equal(ports[0], 55667);
    assert.equal(ports.at(-1), 55667 + SCAN_PORT_COUNT - 1);
  });

  test('an instance started on another port also scans that neighbourhood', () => {
    const { ports } = createConfig(['--port', '8080']).discovery;
    assert.ok(ports.includes(55667));
    assert.ok(ports.includes(8080));
    assert.ok(ports.includes(8080 + SCAN_PORT_COUNT - 1));
  });

  test('scan targets can be given explicitly', () => {
    const config = createConfig(['--scan-hosts', '10.1.2.3,127.0.0.1', '--scan-ports', '5000-5002']);
    assert.deepEqual(config.discovery.hosts, ['10.1.2.3', '127.0.0.1']);
    assert.deepEqual(config.discovery.ports, [5000, 5001, 5002]);
    assert.equal(createConfig(['--no-scan']).discovery.enabled, false);
  });

  test('the control panel is local-only unless --remote-ui', () => {
    assert.equal(createConfig([]).allowRemoteUi, false);
    assert.equal(createConfig(['--remote-ui']).allowRemoteUi, true);
  });
});

describe('free port search', () => {
  test('a busy port moves the server to the next one', async () => {
    const run = await reserveRun(2);
    await run.releaseFrom(1);
    try {
      const app = await makeApp({ port: run.base });
      const result = await app.listen();
      assert.equal(result.port, run.base + 1);
      assert.equal(app.identity.port, run.base + 1, 'the identity reports the real port');
      const ping = await (await fetch(`http://127.0.0.1:${result.port}/api/ping`)).json();
      assert.equal(ping.port, run.base + 1);
      await app.close();
    } finally {
      await run.releaseAll();
    }
  });

  test('it keeps walking while consecutive ports are busy', async () => {
    const run = await reserveRun(4);
    await run.releaseFrom(3);
    try {
      const app = await makeApp({ port: run.base });
      assert.equal((await app.listen()).port, run.base + 3);
      await app.close();
    } finally {
      await run.releaseAll();
    }
  });

  test('starting twice on the same port gives two instances', async () => {
    const run = await reserveRun(3);
    await run.releaseAll();
    const first = await makeApp({ port: run.base });
    const second = await makeApp({ port: run.base });
    const a = await first.listen();
    const b = await second.listen();
    assert.equal(a.port, run.base);
    assert.equal(b.port, run.base + 1);
    const pingA = await (await fetch(`http://127.0.0.1:${a.port}/api/ping`)).json();
    const pingB = await (await fetch(`http://127.0.0.1:${b.port}/api/ping`)).json();
    assert.notEqual(pingA.uuid, pingB.uuid, 'each process is a different session');
    await first.close();
    await second.close();
  });

  test('the walk is bounded and says which range it searched', async () => {
    const run = await reserveRun(2);
    try {
      const server = createServer();
      await assert.rejects(listenWithFallback(server, { port: run.base, host: '127.0.0.1', attempts: 2 }), (error) => {
        assert.equal(error.code, 'EADDRINUSE');
        assert.match(error.message, new RegExp(`${run.base} through ${run.base + 1}`));
        assert.match(error.message, /--port/);
        return true;
      });
    } finally {
      await run.releaseAll();
    }
  });

  test('port 0 means "any free port" and is never incremented', async () => {
    const app = await makeApp({ port: 0 });
    const { port } = await app.listen();
    assert.ok(port > 0);
    await app.close();
  });

  test('a failure other than a busy port is reported as is', async () => {
    // TEST-NET-1 is not an address of this machine: EADDRNOTAVAIL, no walking.
    const server = createServer();
    await assert.rejects(listenWithFallback(server, { port: 45000, host: '192.0.2.1', attempts: 64 }), (error) => {
      assert.notEqual(error.code, 'EADDRINUSE');
      return true;
    });
  });
});
