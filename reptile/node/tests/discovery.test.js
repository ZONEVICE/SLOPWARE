/**
 * The ping-pong endpoint and discovery.
 *
 * Discovery is pointed at 127.0.0.1 and at the ports of the instances each
 * test starts, so it never scans the real network and never sees an unrelated
 * Reptile running on this machine.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { probe, tcpCheck } from '../src/peer/probe.js';
import { cleanup, startInstance, tempDir, waitFor } from './helpers/instances.js';

after(cleanup);

/** Discovery settings that scan only `ports` on loopback, quickly. */
const scanOnly = (ports, extra = {}) => ({
  enabled: true,
  hosts: ['127.0.0.1'],
  ports,
  sweepIntervalMs: 300,
  refreshIntervalMs: 200,
  staleMs: 1200,
  connectTimeoutMs: 300,
  requestTimeoutMs: 1500,
  ...extra,
});

/** A port nobody listens on (bound, read, released). */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('ping endpoint', () => {
  test('identifies the instance as Reptile, with hostname, UUID and protocol', async () => {
    const instance = await startInstance();
    const { status, data } = await instance.api('GET', '/api/ping');
    assert.equal(status, 200);
    assert.equal(data.app, 'reptile');
    assert.equal(data.uuid, instance.app.identity.uuid);
    assert.match(data.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a UUIDv4');
    assert.equal(data.hostname, instance.app.identity.hostname);
    assert.equal(data.protocol, 'http');
    assert.equal(data.port, instance.port);
    assert.equal(data.hosting, null);
    assert.equal(data.mode, 'idle');
  });

  test('says whether it is hosting, and which directory, never where it is on disk', async () => {
    const instance = await startInstance();
    const root = await tempDir();
    await instance.app.modes.startHosting({ path: root, name: 'Holiday photos', pin: '1234' });
    const { data } = await instance.api('GET', '/api/ping');
    assert.equal(data.mode, 'hosting');
    assert.equal(data.hosting.name, 'Holiday photos');
    assert.equal(data.hosting.connected, false);
    assert.ok(!JSON.stringify(data).includes(root), 'no local path');
    assert.ok(!JSON.stringify(data).includes('1234'), 'no PIN');
  });

  test('every process has its own session UUID', async () => {
    const a = await startInstance();
    const b = await startInstance();
    assert.notEqual(a.app.identity.uuid, b.app.identity.uuid);
  });
});

describe('probe', () => {
  test('a closed port is recognised as such, quickly', async () => {
    const port = await freePort();
    assert.equal(await tcpCheck('127.0.0.1', port, 500), 'closed');
    const result = await probe({ host: '127.0.0.1', port, preferProtocol: 'http' });
    assert.equal(result.status, 'closed');
    assert.equal(result.reachable, true);
  });

  test('an HTTP server that is not Reptile is ignored', async () => {
    const server = createServer((req, res) => res.end(JSON.stringify({ app: 'something-else' })));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await probe({ host: '127.0.0.1', port: server.address().port, preferProtocol: 'http' });
      assert.equal(result.status, 'not_reptile');
    } finally {
      server.close();
    }
  });

  test('finds an instance whatever protocol it speaks', async () => {
    const plain = await startInstance();
    const secure = await startInstance({ protocol: 'https' });
    const fromHttp = await probe({ host: '127.0.0.1', port: secure.port, preferProtocol: 'http' });
    assert.equal(fromHttp.status, 'found');
    assert.equal(fromHttp.info.protocol, 'https');
    const fromHttps = await probe({ host: '127.0.0.1', port: plain.port, preferProtocol: 'https' });
    assert.equal(fromHttps.status, 'found');
    assert.equal(fromHttps.info.protocol, 'http');
  });
});

describe('discovery', () => {
  test('finds the other instances on the scanned ports', async () => {
    const other = await startInstance();
    const scanner = await startInstance({ discovery: scanOnly([other.port, await freePort()]) });
    const found = await waitFor(() => scanner.app.discovery.list().find((instance) => instance.uuid === other.app.identity.uuid), {
      message: 'the other instance to be discovered',
    });
    assert.equal(found.port, other.port);
    assert.equal(found.hostname, other.app.identity.hostname);
    assert.equal(found.protocol, 'http');
    assert.equal(found.compatible, true);
    assert.equal(found.hosting, null);
    assert.equal(scanner.app.discovery.list().length, 1);
  });

  test('an instance never lists itself, even when it scans its own port', async () => {
    const port = await freePort();
    const other = await startInstance();
    const scanner = await startInstance({ port, discovery: scanOnly([port, other.port]) });
    assert.equal(scanner.port, port, 'listening on the scanned port');
    await waitFor(() => scanner.app.discovery.status().sweeps > 1);
    const listed = scanner.app.discovery.list().map((instance) => instance.uuid);
    assert.deepEqual(listed, [other.app.identity.uuid]);
  });

  test('shows which directory an instance hosts, and updates it quickly', async () => {
    const host = await startInstance();
    const scanner = await startInstance({ discovery: scanOnly([host.port]) });
    await waitFor(() => scanner.app.discovery.list().length === 1);
    assert.equal(scanner.app.discovery.list()[0].hosting, null);

    await host.app.modes.startHosting({ path: await tempDir(), name: 'Music', pin: '1111' });
    const hosting = await waitFor(() => scanner.app.discovery.list()[0]?.hosting, { message: 'hosting to show up' });
    assert.equal(hosting.name, 'Music');

    await host.app.modes.stopHosting();
    await waitFor(() => scanner.app.discovery.list()[0]?.hosting === null, { message: 'hosting to disappear' });
  });

  test('instances of the other protocol are listed as incompatible', async () => {
    const secure = await startInstance({ protocol: 'https' });
    const plain = await startInstance();
    const httpScanner = await startInstance({ discovery: scanOnly([secure.port, plain.port]) });
    const httpsScanner = await startInstance({ protocol: 'https', discovery: scanOnly([secure.port, plain.port]) });

    await waitFor(() => httpScanner.app.discovery.list().length === 2, { message: 'two instances from the HTTP scanner' });
    const fromHttp = Object.fromEntries(httpScanner.app.discovery.list().map((instance) => [instance.protocol, instance.compatible]));
    assert.deepEqual(fromHttp, { http: true, https: false });

    await waitFor(() => httpsScanner.app.discovery.list().length === 2, { message: 'two instances from the HTTPS scanner' });
    const fromHttps = Object.fromEntries(httpsScanner.app.discovery.list().map((instance) => [instance.protocol, instance.compatible]));
    assert.deepEqual(fromHttps, { http: false, https: true });
  });

  test('an instance that stops is forgotten', async () => {
    const other = await startInstance();
    const scanner = await startInstance({ discovery: scanOnly([other.port]) });
    await waitFor(() => scanner.app.discovery.list().length === 1);
    await other.close();
    await waitFor(() => scanner.app.discovery.list().length === 0, { message: 'the stopped instance to be forgotten', timeoutMs: 8000 });
  });

  test('the scan can be switched off and on from the status bar', async () => {
    const other = await startInstance();
    const scanner = await startInstance({ discovery: scanOnly([other.port]) });
    await waitFor(() => scanner.app.discovery.status().sweeps > 0);

    const off = await scanner.api('POST', '/api/discovery', { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.data.enabled, false);
    const sweepsWhenOff = scanner.app.discovery.status().sweeps;
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(scanner.app.discovery.status().sweeps, sweepsWhenOff, 'no sweep while switched off');
    assert.equal(scanner.app.discovery.status().scanning, false);

    const on = await scanner.api('POST', '/api/discovery', { enabled: true });
    assert.equal(on.data.enabled, true);
    await waitFor(() => scanner.app.discovery.status().sweeps > sweepsWhenOff, { message: 'scanning to resume' });

    const bad = await scanner.api('POST', '/api/discovery', { enabled: 'yes' });
    assert.equal(bad.status, 400);
  });

  test('scanning can start switched off (--no-scan)', async () => {
    const scanner = await startInstance({ discovery: scanOnly([1], { enabled: false }) });
    assert.equal(scanner.app.discovery.status().enabled, false);
    const state = await scanner.api('GET', '/api/state');
    assert.equal(state.data.discovery.enabled, false);
  });

  test('a manual address is verified on request', async () => {
    const host = await startInstance();
    await host.app.modes.startHosting({ path: await tempDir(), name: 'Manual', pin: '1234' });
    const client = await startInstance();
    const found = await client.api('POST', '/api/sync/inspect', { address: '127.0.0.1', port: host.port });
    assert.equal(found.status, 200);
    assert.equal(found.data.compatible, true);
    assert.equal(found.data.info.hosting.name, 'Manual');

    const nothing = await client.api('POST', '/api/sync/inspect', { address: '127.0.0.1', port: await freePort() });
    assert.equal(nothing.status, 400);
    assert.equal(nothing.data.error.code, 'unreachable');

    const badPort = await client.api('POST', '/api/sync/inspect', { address: '127.0.0.1', port: 70000 });
    assert.equal(badPort.data.error.code, 'bad_port');
  });
});
