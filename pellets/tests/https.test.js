/**
 * HTTPS mode.
 *
 * `npm start -- --https` must mint a brand new self-signed certificate on every
 * run - even when `cert/` already holds one - install it on itself, and serve
 * both the application and the WebSocket over TLS (`wss://`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startTestServer } from './helpers/server.js';

describe('HTTPS', () => {
  test('serves the application over TLS with a freshly generated certificate', async () => {
    const server = await startTestServer({ protocol: 'https' });
    try {
      assert.equal(server.config.protocol, 'https');
      assert.ok(server.tls, 'certificate metadata is exposed by the app');
      assert.equal(server.tls.generator, 'in-process');

      // The certificate really was written into the configured directory.
      const onDisk = await readFile(server.tls.certPath, 'utf8');
      assert.equal(onDisk, server.tls.cert);
      const parsed = new X509Certificate(onDisk);
      assert.equal(parsed.checkIP('127.0.0.1'), '127.0.0.1');

      const client = server.client('UA-https');
      const response = await client.fetch('/');
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<title>Pellets<\/title>/);

      // Over TLS the session cookie must carry the Secure flag.
      const cookie = response.headers.getSetCookie().join(';');
      assert.match(cookie, /Secure/);

      const health = await client.json('/api/health');
      assert.equal(health.protocol, 'https');
    } finally {
      await server.stop();
    }
  });

  test('a chat works end to end over wss://', async () => {
    const server = await startTestServer({ protocol: 'https' });
    try {
      assert.match(server.wsBase, /^wss:\/\//);

      const ana = server.client('UA-wss-ana');
      const luis = server.client('UA-wss-luis');
      await ana.identify('Ana');
      await luis.identify('Luis');

      const anaSocket = await ana.connect().ready();
      const luisSocket = await luis.connect().ready();
      await anaSocket.waitFor('session:state');
      await luisSocket.waitFor('session:state');

      const room = (await anaSocket.request('room:create', { name: 'Segura' })).room;
      await anaSocket.request('room:join', { roomId: room.id });
      await luisSocket.request('room:join', { roomId: room.id });

      luisSocket.reset();
      await anaSocket.request('message:send', { roomId: room.id, body: 'cifrado' });
      const frame = await luisSocket.waitFor('message:new');
      assert.equal(frame.payload.message.body, 'cifrado');

      await anaSocket.close();
      await luisSocket.close();
    } finally {
      await server.stop();
    }
  });

  test('every start produces a different certificate', async () => {
    const first = await startTestServer({ protocol: 'https' });
    const certDir = first.certDir;
    const firstSerial = first.tls.serial;
    await first.app.close();

    // Same cert/ directory, which already holds a valid certificate.
    const second = await startTestServer({ protocol: 'https', overrides: { certDir } });
    try {
      assert.notEqual(second.tls.serial, firstSerial, 'the existing certificate is not reused');
      assert.equal(await readFile(second.tls.certPath, 'utf8'), second.tls.cert);
    } finally {
      await second.app.close();
      await first.stop();
    }
  });

  test('an RSA certificate also works, for maximum client compatibility', async () => {
    const server = await startTestServer({ protocol: 'https', overrides: { keyType: 'rsa' } });
    try {
      assert.equal(server.tls.keyType, 'rsa');
      const response = await server.client('UA-rsa').fetch('/api/health');
      assert.equal(response.status, 200);
    } finally {
      await server.stop();
    }
  });
});
