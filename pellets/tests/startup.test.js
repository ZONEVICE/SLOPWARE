/**
 * Port selection at startup.
 *
 * A busy port must never stop the server from starting: it walks upwards until
 * it finds a free one. This applies both to the default 8080 and to an explicit
 * `--port`, so `npm start` twice in a row simply gives you two servers.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { createLogger } from '../src/lib/logger.js';

/** Temporary directories and apps to clean up when the file finishes. */
const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});

/** Build an app that has NOT been told to listen yet. */
async function makeApp(overrides = {}) {
  const uploadsDir = await mkdtemp(join(tmpdir(), 'pellets-startup-'));
  const config = createConfig([], {
    port: 0,
    host: '127.0.0.1',
    logLevel: process.env.PELLETS_TEST_LOG || 'silent',
    uploadsDir,
    certDir: uploadsDir,
    ...overrides,
  });
  const app = await createApp({ config, logger: createLogger('test', { level: config.logLevel }) });
  cleanups.push(async () => {
    await app.close();
    await rm(uploadsDir, { recursive: true, force: true });
  });
  return app;
}

/** Bind a placeholder server to one specific port. */
function hold(port) {
  return new Promise((resolve, reject) => {
    const server = createServer(() => {});
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function release(server) {
  return new Promise((resolve) => server.close(resolve));
}

/**
 * Reserve `count` consecutive ports starting at a base the OS chose.
 *
 * Retries with a different base until it finds a run that is entirely free, so
 * the test never depends on which ports happen to be busy on this machine.
 * @param {number} count
 */
async function reserveRun(count) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // Ask the OS for a free port, then immediately release it to use as a base.
    const probe = await hold(0);
    const base = probe.address().port;
    await release(probe);

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
        servers,
        /** Free the ports from `index` onwards, keeping the earlier ones busy. */
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

describe('port selection', () => {
  test('a busy port moves the server to the next one', async () => {
    // base is held; base + 1 was verified free and released a moment ago.
    const run = await reserveRun(2);
    await run.releaseFrom(1);

    try {
      const app = await makeApp({ port: run.base });
      const result = await app.listen();
      assert.equal(result.port, run.base + 1, 'the server stepped up by exactly one port');
      assert.equal(result.url, `http://127.0.0.1:${run.base + 1}`);

      // And it really is serving there.
      const response = await fetch(`${result.url}/api/health`);
      assert.equal(response.status, 200);
    } finally {
      await run.releaseAll();
    }
  });

  test('it keeps walking while consecutive ports are busy', async () => {
    // base, base + 1 and base + 2 are held; base + 3 is free.
    const run = await reserveRun(4);
    await run.releaseFrom(3);

    try {
      const app = await makeApp({ port: run.base });
      const result = await app.listen();
      assert.equal(result.port, run.base + 3, 'three busy ports were skipped');
    } finally {
      await run.releaseAll();
    }
  });

  test('an explicit --port gets the same treatment as the default', async () => {
    const run = await reserveRun(2);
    await run.releaseFrom(1);

    try {
      // Exactly what `npm start -- --port <busy>` produces.
      const config = createConfig(['--port', String(run.base)]);
      assert.equal(config.port, run.base);

      const app = await makeApp({ port: config.port });
      const result = await app.listen();
      assert.equal(result.port, run.base + 1);
    } finally {
      await run.releaseAll();
    }
  });

  test('the walk can be switched off, and then a busy port is an error', async () => {
    const run = await reserveRun(1);

    try {
      const app = await makeApp({ port: run.base, portAttempts: 1 });
      await assert.rejects(() => app.listen(), (error) => {
        assert.equal(error.code, 'EADDRINUSE');
        return true;
      });
    } finally {
      await run.releaseAll();
    }
  });

  test('giving up reports which range was searched', async () => {
    const run = await reserveRun(2);

    try {
      const app = await makeApp({ port: run.base, portAttempts: 2 });
      await assert.rejects(() => app.listen(), (error) => {
        assert.equal(error.code, 'EADDRINUSE');
        assert.match(error.message, new RegExp(`${run.base} through ${run.base + 1}`));
        assert.match(error.message, /--port/);
        return true;
      });
    } finally {
      await run.releaseAll();
    }
  });

  test('port 0 still means "any free port" and is never incremented', async () => {
    const app = await makeApp({ port: 0 });
    const result = await app.listen();
    assert.ok(result.port > 0);
    assert.equal((await (await fetch(`${result.url}/api/health`)).json()).status, 'ok');
  });

  test('a failure that is not a busy port is reported as is', async () => {
    // TEST-NET-1: a routable-looking address that is not on this machine, so
    // the bind fails with EADDRNOTAVAIL. Walking ports would never help.
    const app = await makeApp({ port: 8080, host: '192.0.2.1', portAttempts: 64 });
    await assert.rejects(() => app.listen(), (error) => {
      assert.notEqual(error.code, 'EADDRINUSE', 'it must not be mistaken for a busy port');
      return true;
    });
  });

  test('the default configuration allows a generous walk', () => {
    assert.equal(createConfig([]).port, 8080);
    assert.ok(createConfig([]).portAttempts >= 16);
  });
});
