/**
 * The PIN: the only protection, openly symbolic.
 *
 *  - the right PIN connects; a wrong one is refused, as often as needed;
 *  - the host can change it at any time;
 *  - changing it while a peer is connected cuts that peer off immediately,
 *    the peer is told and asked for the new PIN, and typing it resumes the
 *    synchronisation, including changes made on either side in the meantime.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, connectedPair, sleep, startInstance, tempDir, waitFor, waitForSameTrees } from './helpers/instances.js';

after(cleanup);

async function hostWithPin(pin = '4321') {
  const root = await tempDir('reptile-host-');
  await writeFile(join(root, 'a.txt'), 'a');
  const host = await startInstance();
  await host.app.modes.startHosting({ path: root, name: 'Guarded', pin });
  return { host, root };
}

describe('connecting with a PIN', () => {
  test('the correct PIN connects', async () => {
    const { host } = await hostWithPin('4321');
    const client = await startInstance();
    const answer = await client.api('POST', '/api/sync', { address: '127.0.0.1', port: host.port, localPath: join(await tempDir(), 'copy'), pin: '4321' });
    assert.equal(answer.status, 201);
    await waitFor(() => client.syncState() === 'live');
  });

  test('a wrong PIN is refused, and can be retried without limit', async () => {
    const { host } = await hostWithPin('4321');
    const client = await startInstance();
    const localPath = join(await tempDir(), 'copy');
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const answer = await client.api('POST', '/api/sync', { address: '127.0.0.1', port: host.port, localPath, pin: String(1000 + attempt) });
      assert.equal(answer.status, 403);
      assert.equal(answer.data.error.code, 'pin_invalid');
      assert.match(answer.data.error.message, /Wrong PIN/);
    }
    assert.equal(client.app.modes.mode, 'idle', 'a refused PIN changes nothing');
    const ok = await client.api('POST', '/api/sync', { address: '127.0.0.1', port: host.port, localPath, pin: '4321' });
    assert.equal(ok.status, 201);
  });

  test('a PIN must be exactly four digits', async () => {
    const { host } = await hostWithPin();
    const client = await startInstance();
    const answer = await client.api('POST', '/api/sync', { address: '127.0.0.1', port: host.port, localPath: join(await tempDir(), 'c'), pin: '12a4' });
    assert.equal(answer.status, 400);
    assert.equal(answer.data.error.code, 'pin_format');
    const hosting = await startInstance();
    const bad = await hosting.api('POST', '/api/host', { path: await tempDir(), pin: '12345' });
    assert.equal(bad.data.error.code, 'pin_format');
  });

  test('hosting generates a PIN when none is given, and suggests one', async () => {
    const instance = await startInstance();
    const started = await instance.api('POST', '/api/host', { path: await tempDir() });
    assert.equal(started.status, 201);
    assert.match(started.data.pin, /^\d{4}$/);
    const suggestion = await instance.api('GET', '/api/host/pin/suggest');
    assert.match(suggestion.data.pin, /^\d{4}$/);
  });
});

describe('changing the PIN', () => {
  test('without a peer connected, it simply changes', async () => {
    const { host } = await hostWithPin('1111');
    const answer = await host.api('POST', '/api/host/pin', { pin: '2222' });
    assert.deepEqual(answer.data, { pin: '2222', changed: true, disconnected: false });
    assert.equal(host.app.hosting.status().pin, '2222');
  });

  test('a random new PIN is always different from the current one', async () => {
    const { host } = await hostWithPin('1111');
    for (let index = 0; index < 20; index += 1) {
      const before = host.app.hosting.status().pin;
      const answer = await host.api('POST', '/api/host/pin', {});
      assert.notEqual(answer.data.pin, before);
    }
  });

  test('the old PIN stops working, the new one works', async () => {
    const { host } = await hostWithPin('1111');
    await host.api('POST', '/api/host/pin', { pin: '9999' });
    const client = await startInstance();
    const localPath = join(await tempDir(), 'copy');
    const old = await client.api('POST', '/api/sync', { address: '127.0.0.1', port: host.port, localPath, pin: '1111' });
    assert.equal(old.data.error.code, 'pin_invalid');
    const fresh = await client.api('POST', '/api/sync', { address: '127.0.0.1', port: host.port, localPath, pin: '9999' });
    assert.equal(fresh.status, 201);
  });

  test('with a peer connected: it is cut off at once, asked for the new PIN, and resumes with it', async () => {
    const { host, client, hostDir, syncDir } = await connectedPair({ hostFiles: { 'a.txt': 'a' }, pin: '1234' });
    await waitForSameTrees(hostDir, syncDir);

    const changed = await host.api('POST', '/api/host/pin', { pin: '5678' });
    assert.equal(changed.data.disconnected, true);
    assert.equal(host.app.hosting.status().session, null, 'the host dropped the session immediately');

    await waitFor(() => client.syncState() === 'pin_required', { message: 'the peer to ask for the PIN' });
    const status = client.app.syncing.status();
    assert.match(status.notice.message, /changed the PIN/);

    // While paused, nothing flows.
    await writeFile(join(hostDir, 'during-pause-host.txt'), 'h');
    await writeFile(join(syncDir, 'during-pause-peer.txt'), 'p');
    await rm(join(syncDir, 'a.txt'));
    await sleep(700);
    assert.equal(await readFile(join(syncDir, 'during-pause-host.txt'), 'utf8').catch(() => null), null);

    // The old PIN is refused, repeatedly if need be.
    for (const wrong of ['1234', '0000']) {
      const refused = await client.api('POST', '/api/sync/pin', { pin: wrong });
      assert.equal(refused.status, 403);
      assert.equal(refused.data.error.code, 'pin_invalid');
      assert.equal(client.syncState(), 'pin_required');
    }

    const accepted = await client.api('POST', '/api/sync/pin', { pin: '5678' });
    assert.equal(accepted.status, 200);
    await waitFor(() => client.syncState() === 'live', { message: 'the sync to resume' });

    // Changes made on both sides during the pause are exchanged, and the
    // deletion made here is understood as a deletion, not undone.
    await waitForSameTrees(hostDir, syncDir);
    assert.equal(await readFile(join(hostDir, 'during-pause-peer.txt'), 'utf8'), 'p');
    assert.equal(await readFile(join(syncDir, 'during-pause-host.txt'), 'utf8'), 'h');
    assert.equal(await readFile(join(hostDir, 'a.txt'), 'utf8').catch(() => null), null);

    // And live sync continues afterwards.
    await writeFile(join(hostDir, 'after.txt'), 'after');
    await waitFor(async () => (await readFile(join(syncDir, 'after.txt'), 'utf8').catch(() => '')) === 'after');
  });

  test('a PIN is only asked for when one is needed', async () => {
    const { client } = await connectedPair({ hostFiles: { 'a.txt': 'a' } });
    const answer = await client.api('POST', '/api/sync/pin', { pin: '1234' });
    assert.equal(answer.status, 409);
    assert.equal(answer.data.error.code, 'pin_not_needed');
  });
});
