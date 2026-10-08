/**
 * HTTPS end to end: two instances, each with its own brand-new self-signed
 * certificate, accept each other's certificate and synchronise exactly as over
 * HTTP. The certificate seen when the session opens is pinned for the rest of
 * the session.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPeerClient } from '../src/peer/client.js';
import { cleanup, connectedPair, startInstance, tempDir, waitFor, waitForSameTrees } from './helpers/instances.js';

after(cleanup);

describe('synchronisation over HTTPS', () => {
  test('initial and live synchronisation work in both directions', async () => {
    const { host, client, hostDir, syncDir } = await connectedPair({
      protocol: 'https',
      hostFiles: { 'a.txt': 'alpha', 'docs/b.md': 'bravo', 'private.txt': 'no' },
      syncFiles: { 'from-peer.txt': 'peer' },
      excluded: ['private.txt'],
    });
    assert.equal(host.app.identity.protocol, 'https');
    assert.equal(client.app.syncing.status().protocol, 'https');
    const skip = (path) => path === 'private.txt';
    await waitForSameTrees(hostDir, syncDir, { skipA: skip });

    await writeFile(join(hostDir, 'host-new.txt'), 'h');
    await writeFile(join(syncDir, 'peer-new.txt'), 'p');
    await rename(join(syncDir, 'docs'), join(syncDir, 'documents'));
    await rm(join(hostDir, 'a.txt'));
    await waitForSameTrees(hostDir, syncDir, { skipA: skip });
    assert.equal(await readFile(join(hostDir, 'documents/b.md'), 'utf8'), 'bravo');
    assert.equal(await readFile(join(syncDir, 'private.txt'), 'utf8').catch(() => null), null);
  });

  test('the PIN change flow works over HTTPS too', async () => {
    const { host, client, hostDir, syncDir } = await connectedPair({ protocol: 'https', hostFiles: { 'x.txt': 'x' } });
    await host.api('POST', '/api/host/pin', { pin: '8888' });
    await waitFor(() => client.syncState() === 'pin_required');
    const resumed = await client.api('POST', '/api/sync/pin', { pin: '8888' });
    assert.equal(resumed.status, 200);
    await waitFor(() => client.syncState() === 'live');
    await writeFile(join(hostDir, 'y.txt'), 'y');
    await waitForSameTrees(hostDir, syncDir);
  });

  test('the host certificate is pinned for the whole session', async () => {
    const root = await tempDir();
    await writeFile(join(root, 'f.txt'), 'f');
    const host = await startInstance({ protocol: 'https' });
    await host.app.modes.startHosting({ path: root, name: 'Pinned', pin: '1234' });
    const identity = { uuid: 'pinning-peer', hostname: 'peer', protocol: 'https', machine: 'other' };
    const peer = createPeerClient({ address: '127.0.0.1', port: host.port, protocol: 'https', identity });
    await peer.connect({ pin: '1234', localPath: '/elsewhere' });
    assert.equal(peer.fingerprint, host.app.tls.fingerprint256);
    assert.equal((await peer.manifest()).entries.length, 1);
    peer.close();
  });

  test('a certificate change mid-session is refused', async () => {
    const { httpRequest } = await import('../src/lib/httpRequest.js');
    const host = await startInstance({ protocol: 'https' });
    const other = await startInstance({ protocol: 'https' });
    await assert.rejects(
      httpRequest({ protocol: 'https', host: '127.0.0.1', port: host.port, path: '/api/ping', fingerprint: other.app.tls.fingerprint256 }),
      (error) => error.code === 'certificate_changed',
    );
    const ok = await httpRequest({ protocol: 'https', host: '127.0.0.1', port: host.port, path: '/api/ping', fingerprint: host.app.tls.fingerprint256 });
    assert.equal(ok.data.protocol, 'https');
  });
});
