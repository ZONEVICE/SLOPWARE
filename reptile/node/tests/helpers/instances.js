/**
 * Test helpers: isolated Reptile instances, temporary directories, polling,
 * and tree snapshots for comparing both sides of a synchronisation.
 *
 * Every instance listens on 127.0.0.1 with an ephemeral port, writes its
 * certificate to a temporary directory, and has discovery switched off unless
 * a test turns it on with explicit hosts and ports. Nothing touches the real
 * `cert/` directory or scans the real network, so the suite can run while a
 * real Reptile is running on the same machine.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createApp } from '../../src/app.js';
import { createConfig } from '../../src/config.js';
import { httpRequest } from '../../src/lib/httpRequest.js';
import { createLogger } from '../../src/lib/logger.js';

/** Change detection tuned for tests: fast, but still exercising every stage. */
export const FAST_WATCHER = Object.freeze({ quietMs: 40, maxWaitMs: 300, renameWindowMs: 350, stabilityMs: 80 });

/** Heartbeats in hundreds of milliseconds instead of seconds. */
export const FAST_TIMING = Object.freeze({ streamHeartbeatMs: 200, streamSilenceMs: 1500, peerHeartbeatMs: 200, peerSilenceMs: 1500 });

const cleanups = [];

/** A temporary directory removed by `cleanup()`. */
export async function tempDir(prefix = 'reptile-test-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Stop every instance and remove every temporary directory created so far. */
export async function cleanup() {
  for (const fn of cleanups.splice(0).reverse()) await fn().catch(() => {});
}

/**
 * Start an isolated instance.
 * @param {object} [options] Any `createConfig` override, plus `protocol`.
 */
export async function startInstance({
  protocol = 'http',
  discovery = { enabled: false },
  timing = FAST_TIMING,
  watcher = FAST_WATCHER,
  ...overrides
} = {}) {
  const certDir = await tempDir('reptile-cert-');
  const config = createConfig([], {
    protocol,
    port: 0,
    host: '127.0.0.1',
    logLevel: process.env.REPTILE_TEST_LOG || 'silent',
    certDir,
    discovery,
    timing,
    watcher,
    ...overrides,
  });
  const app = await createApp({ config, logger: createLogger('test', { level: config.logLevel }) });
  const { port } = await app.listen();

  const instance = {
    app,
    port,
    protocol,
    config,
    certDir,
    base: `${protocol}://127.0.0.1:${port}`,

    /**
     * Call this instance's HTTP API as the control panel would.
     * Resolves with `{ status, data }`; never throws on error statuses.
     */
    async api(method, path, body, headers = {}) {
      try {
        const response = await httpRequest({
          protocol,
          host: '127.0.0.1',
          port,
          method,
          path,
          headers,
          ...(body !== undefined ? { json: body } : {}),
          timeoutMs: 15_000,
        });
        return { status: response.status, data: response.data, headers: response.headers };
      } catch (error) {
        if (error.status) return { status: error.status, data: { error: { code: error.code, message: error.message } } };
        throw error;
      }
    },

    /** The syncing engine's state, or null. */
    syncState() {
      return app.syncing.status()?.state ?? null;
    },

    async close() {
      await app.close();
    },
  };
  cleanups.push(() => instance.close());
  return instance;
}

/**
 * Poll until `fn` returns something truthy.
 * @template T
 * @param {() => Promise<T>|T} fn
 * @param {{ timeoutMs?: number, intervalMs?: number, message?: string }} [options]
 * @returns {Promise<T>}
 */
export async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 40, message = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${message} (last value: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

/** Resolve after `ms`. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create files and directories from a plain object:
 * `{ 'a.txt': 'content', 'docs/b.txt': Buffer, 'empty/': null }`.
 */
export async function writeTree(root, spec) {
  for (const [path, content] of Object.entries(spec)) {
    const absolute = join(root, ...path.split('/').filter(Boolean));
    if (path.endsWith('/')) {
      await mkdir(absolute, { recursive: true });
      continue;
    }
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

/**
 * Snapshot a tree as `{ 'dir/': 'dir', 'dir/file': 'sha256…' }`, skipping
 * Reptile's temporary files, symlinks, and anything `skip` matches.
 * @param {string} root
 * @param {{ skip?: (path: string) => boolean }} [options]
 */
export async function snapshotTree(root, { skip = () => false } = {}) {
  const out = {};
  const visit = async (directory, prefix) => {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      if (/^\.reptile-[0-9a-f]+\.tmp$/.test(name)) continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      if (skip(rel)) continue;
      const absolute = join(directory, name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        out[`${rel}/`] = 'dir';
        await visit(absolute, rel);
      } else if (info.isFile()) {
        out[rel] = createHash('sha256').update(await readFile(absolute)).digest('hex').slice(0, 16);
      }
    }
  };
  await visit(root, '');
  return out;
}

/** Wait until two trees are identical (after `skip` on the first one). */
export async function waitForSameTrees(a, b, { skipA, timeoutMs = 10_000 } = {}) {
  let left;
  let right;
  try {
    return await waitFor(
      async () => {
        left = await snapshotTree(a, { skip: skipA });
        right = await snapshotTree(b);
        return JSON.stringify(left) === JSON.stringify(right);
      },
      { timeoutMs, message: 'both trees to converge' },
    );
  } catch (error) {
    error.message += `\n  first:  ${JSON.stringify(left)}\n  second: ${JSON.stringify(right)}`;
    throw error;
  }
}

/**
 * A host and a syncing peer, connected and live.
 *
 * @param {object} [options]
 * @param {'http'|'https'} [options.protocol]
 * @param {Record<string, any>} [options.hostFiles] Initial content of the hosted directory.
 * @param {Record<string, any>} [options.syncFiles] Initial content of the local directory.
 * @param {string[]} [options.excluded]
 * @param {string} [options.pin]
 */
export async function connectedPair({ protocol = 'http', hostFiles = {}, syncFiles = null, excluded = [], pin = '1234' } = {}) {
  const hostDir = await tempDir('reptile-host-');
  const syncParent = await tempDir('reptile-sync-');
  const syncDir = join(syncParent, 'copy');
  await writeTree(hostDir, hostFiles);
  if (syncFiles) await writeTree(syncDir, syncFiles);

  const host = await startInstance({ protocol });
  const client = await startInstance({ protocol });
  await host.app.modes.startHosting({ path: hostDir, name: 'Shared', pin, excluded });
  await client.app.modes.startSyncing({ address: '127.0.0.1', port: host.port, localPath: syncDir, pin });
  await waitFor(() => client.syncState() === 'live', { message: 'the peer to go live' });
  return { host, client, hostDir, syncDir };
}
