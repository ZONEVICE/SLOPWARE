/**
 * Connection rules.
 *
 *  - one hosted directory, one connected instance: a second one is refused
 *    with a clear message, whatever PIN it brings;
 *  - HTTP only talks to HTTP and HTTPS only to HTTPS;
 *  - stopping hosting disconnects the peer and tells it why;
 *  - an instance is in one mode at a time, and switching to sync only stops
 *    hosting once the target and the PIN have been verified.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPeerClient } from '../src/peer/client.js';
import { cleanup, connectedPair, startInstance, tempDir, waitFor, waitForSameTrees } from './helpers/instances.js';

after(cleanup);

async function hosting({ protocol = 'http', pin = '1234', name = 'Shared' } = {}) {
  const root = await tempDir('reptile-host-');
  await writeFile(join(root, 'file.txt'), 'content');
  const host = await startInstance({ protocol });
  await host.app.modes.startHosting({ path: root, name, pin });
  return { host, root };
}

describe('one connection per hosted directory', () => {
  test('a second instance is refused with a clear message, even with the right PIN', async () => {
    const { host, client } = await connectedPair({ hostFiles: { 'a.txt': 'a' } });
    const intruder = await startInstance();
    const answer = await intruder.api('POST', '/api/sync', { address: '127.0.0.1', port: host.port, localPath: join(await tempDir(), 'x'), pin: '1234' });
    assert.equal(answer.status, 409);
    assert.equal(answer.data.error.code, 'busy');
    assert.match(answer.data.error.message, /already being synced by/);
    assert.match(answer.data.error.message, /only one connected instance/);
    assert.equal(intruder.app.modes.mode, 'idle');
    assert.equal(client.syncState(), 'live', 'the connected peer is not disturbed');
  });

  test('the discovery answer says the directory is busy', async () => {
    const { host } = await connectedPair();
    const ping = await host.api('GET', '/api/ping');
    assert.equal(ping.data.hosting.connected, true);
  });

  test('once the peer leaves, another instance can connect', async () => {
    const { host, client } = await connectedPair();
    await client.api('DELETE', '/api/sync');
    await waitFor(() => host.app.hosting.status().session === null, { message: 'the host to free the slot' });
    const next = await startInstance();
    const answer = await next.api('POST', '/api/sync', { address: '127.0.0.1', port: host.port, localPath: join(await tempDir(), 'n'), pin: '1234' });
    assert.equal(answer.status, 201);
  });

  test('a peer that vanishes without saying goodbye frees the slot after a timeout', async () => {
    const { host } = await hosting();
    const identity = { uuid: 'ghost', hostname: 'ghost', protocol: 'http', machine: 'elsewhere' };
    const ghost = createPeerClient({ address: '127.0.0.1', port: host.port, protocol: 'http', identity });
    await ghost.connect({ pin: '1234', localPath: '/nowhere' });
    assert.ok(host.app.hosting.status().session);
    ghost.close(); // no heartbeats, no disconnect
    await waitFor(() => host.app.hosting.status().session === null, { timeoutMs: 6000, message: 'the silent peer to be dropped' });
  });

  test('the same instance reconnecting replaces its own previous session', async () => {
    const { host } = await hosting();
    const identity = { uuid: 'same-peer', hostname: 'laptop', protocol: 'http', machine: 'm' };
    const first = createPeerClient({ address: '127.0.0.1', port: host.port, protocol: 'http', identity });
    const second = createPeerClient({ address: '127.0.0.1', port: host.port, protocol: 'http', identity });
    const a = await first.connect({ pin: '1234', localPath: '/a' });
    const b = await second.connect({ pin: '1234', localPath: '/a' });
    assert.notEqual(a.token, b.token);
    await assert.rejects(first.manifest(), (error) => error.status === 401);
    assert.ok((await second.manifest()).entries.length > 0);
    first.close();
    second.close();
  });
});

describe('protocols must match', () => {
  test('an HTTP instance cannot sync from an HTTPS one', async () => {
    const { host } = await hosting({ protocol: 'https' });
    const client = await startInstance({ protocol: 'http' });
    const answer = await client.api('POST', '/api/sync', { address: '127.0.0.1', port: host.port, localPath: join(await tempDir(), 'x'), pin: '1234' });
    assert.equal(answer.status, 400);
    assert.equal(answer.data.error.code, 'protocol_mismatch');
    assert.match(answer.data.error.message, /HTTPS/);
    const inspect = await client.api('POST', '/api/sync/inspect', { address: '127.0.0.1', port: host.port });
    assert.equal(inspect.data.compatible, false);
  });

  test('an HTTPS instance cannot sync from an HTTP one', async () => {
    const { host } = await hosting({ protocol: 'http' });
    const client = await startInstance({ protocol: 'https' });
    const answer = await client.api('POST', '/api/sync', { address: '127.0.0.1', port: host.port, localPath: join(await tempDir(), 'x'), pin: '1234' });
    assert.equal(answer.status, 400);
    assert.equal(answer.data.error.code, 'protocol_mismatch');
  });

  test('the host refuses a peer that declares another protocol', async () => {
    const { host } = await hosting();
    assert.throws(
      () => host.app.hosting.connect({ pin: '1234', protocol: 'https', peer: { uuid: 'x', hostname: 'x' } }),
      (error) => error.code === 'protocol_mismatch',
    );
  });
});

describe('ending a session', () => {
  test('stopping hosting disconnects the peer and tells it why', async () => {
    const { host, client, hostDir, syncDir } = await connectedPair({ hostFiles: { 'a.txt': 'a' } });
    await waitForSameTrees(hostDir, syncDir);
    await host.api('DELETE', '/api/host');
    await waitFor(() => client.syncState() === 'stopped', { message: 'the peer to learn hosting stopped' });
    assert.match(client.app.syncing.status().notice.message, /stopped hosting/);
    assert.equal(client.app.modes.mode, 'syncing', 'the notice stays visible until the user leaves');
    // No further changes flow, and nothing local was deleted.
    await writeFile(join(hostDir, 'after-stop.txt'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual((await readdir(syncDir)).sort(), ['a.txt']);
    const back = await client.api('DELETE', '/api/sync');
    assert.equal(back.status, 200);
    assert.equal(client.app.modes.mode, 'idle');
  });

  test('a host process that shuts down cleanly says goodbye', async () => {
    const { host, client } = await connectedPair();
    await host.close();
    await waitFor(() => client.syncState() === 'stopped', { message: 'the peer to be told' });
  });

  test('a peer notices a host that crashes and keeps trying to reconnect', async () => {
    const { host, client } = await connectedPair();
    // No goodbye: the server just vanishes, as with a crash or a pulled cable.
    host.app.server.close();
    host.app.server.closeAllConnections();
    await waitFor(() => client.syncState() === 'reconnecting', { message: 'the peer to notice' });
    await waitFor(() => client.app.syncing.status().reconnect?.attempt >= 2, { message: 'repeated attempts', timeoutMs: 8000 });
    assert.match(client.app.syncing.status().notice.message, /Retrying|Reconnecting/);
  });

  test('a reconciliation pending from before a drop does not stall the new connection', async () => {
    const { host, client } = await connectedPair({ hostFiles: { 'a.txt': 'a' } });
    // A retry scheduled far in the future, as after a conflict...
    client.app.syncing.engine.scheduleReconcile(60_000);
    // ...then the connection drops and comes back.
    host.app.server.closeAllConnections();
    await waitFor(() => client.syncState() !== 'live', { message: 'the drop to be noticed' });
    await waitFor(() => client.syncState() === 'live', { timeoutMs: 8000, message: 'live again without waiting for the old timer' });
  });

  test('a peer resumes on its own after a network interruption', async () => {
    const { host, client, hostDir, syncDir } = await connectedPair({ hostFiles: { 'a.txt': 'a' } });
    // Cut every connection the host has, as a flaky network would.
    host.app.server.closeAllConnections();
    await waitFor(() => client.syncState() === 'reconnecting' || client.syncState() === 'syncing', { message: 'the drop to be noticed' });
    await waitFor(() => client.syncState() === 'live', { timeoutMs: 10_000, message: 'the automatic reconnection' });
    await writeFile(join(hostDir, 'after-reconnect.txt'), 'ok');
    await waitForSameTrees(hostDir, syncDir);
  });
});

describe('one mode at a time', () => {
  test('an instance cannot sync from itself', async () => {
    const { host } = await hosting();
    const answer = await host.api('POST', '/api/sync', { address: '127.0.0.1', port: host.port, localPath: join(await tempDir(), 'x'), pin: '1234' });
    assert.equal(answer.data.error.code, 'self');
    assert.equal(host.app.modes.mode, 'hosting');
  });

  test('switching to sync stops hosting, but only after the PIN was accepted', async () => {
    const { host: target } = await hosting({ name: 'Target' });
    const { host: switcher } = await hosting({ name: 'Mine' });
    const localPath = join(await tempDir(), 'copy');

    const refused = await switcher.api('POST', '/api/sync', { address: '127.0.0.1', port: target.port, localPath, pin: '0000' });
    assert.equal(refused.status, 403);
    assert.equal(switcher.app.modes.mode, 'hosting', 'a wrong PIN leaves hosting untouched');

    const accepted = await switcher.api('POST', '/api/sync', { address: '127.0.0.1', port: target.port, localPath, pin: '1234' });
    assert.equal(accepted.status, 201);
    assert.equal(switcher.app.modes.mode, 'syncing');
    assert.equal(switcher.app.hosting.active, false, 'hosting was cancelled');
    const ping = await switcher.api('GET', '/api/ping');
    assert.equal(ping.data.hosting, null);
  });

  test('hosting while syncing stops syncing first', async () => {
    const { host, client } = await connectedPair();
    const answer = await client.api('POST', '/api/host', { path: await tempDir(), name: 'New', pin: '1111' });
    assert.equal(answer.status, 201);
    assert.equal(client.app.modes.mode, 'hosting');
    assert.equal(client.app.syncing.active, false);
    await waitFor(() => host.app.hosting.status().session === null, { message: 'the old host to see the peer leave' });
  });

  test('hosting another directory requires cancelling the current one first', async () => {
    const { host } = await hosting();
    const again = await host.api('POST', '/api/host', { path: await tempDir(), pin: '1111' });
    assert.equal(again.status, 409);
    assert.equal(again.data.error.code, 'already_hosting');
    await host.api('DELETE', '/api/host');
    const now = await host.api('POST', '/api/host', { path: await tempDir(), pin: '1111' });
    assert.equal(now.status, 201);
  });

  test('a directory cannot be synced into itself on the same computer', async () => {
    const { host, root } = await hosting();
    const client = await startInstance();
    const answer = await client.api('POST', '/api/sync', { address: '127.0.0.1', port: host.port, localPath: join(root, 'inside'), pin: '1234' });
    assert.equal(answer.data.error.code, 'same_directory');
  });

  test('syncing needs a target that is actually hosting', async () => {
    const idle = await startInstance();
    const client = await startInstance();
    const answer = await client.api('POST', '/api/sync', { address: '127.0.0.1', port: idle.port, localPath: join(await tempDir(), 'x'), pin: '1234' });
    assert.equal(answer.status, 409);
    assert.equal(answer.data.error.code, 'not_hosting');
  });
});
