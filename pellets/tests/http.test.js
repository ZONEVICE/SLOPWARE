/**
 * HTTP layer: session bootstrap from client metadata, the REST surface, static
 * assets, range requests and the application-route fallback.
 *
 * Every test runs against a real server on an ephemeral port.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/server.js';

describe('HTTP', () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    await server.stop();
  });

  describe('session bootstrap from client metadata', () => {
    test('hitting the root creates a session and sets the cookie', async () => {
      const client = server.client('UA-root');
      const response = await client.fetch('/');
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);

      const cookie = response.headers.getSetCookie().join(';');
      assert.match(cookie, /pellets\.sid=/);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Lax/);
      assert.doesNotMatch(cookie, /Secure/, 'no Secure flag over plain HTTP');

      const body = await client.json('/api/session');
      assert.match(body.session.id, /^[0-9a-f-]{36}$/);
      assert.equal(body.session.identified, false);
      assert.equal(body.session.theme, 'dark');
    });

    test('the same client keeps its session across requests', async () => {
      const client = server.client('UA-stable');
      const first = (await client.json('/api/session')).session.id;
      const second = (await client.json('/api/session')).session.id;
      assert.equal(first, second);
    });

    test('a different client gets a different session', async () => {
      const a = server.client('UA-one');
      const b = server.client('UA-two');
      assert.notEqual((await a.json('/api/session')).session.id, (await b.json('/api/session')).session.id);
    });

    test('a cookie-less request is recognised by its metadata when enabled', async () => {
      // This server has the fingerprint fallback on, unlike the shared one.
      const fingerprinting = await startTestServer({ fingerprint: true });
      try {
        const client = fingerprinting.client('UA-metadata');
        const original = (await client.json('/api/session')).session.id;

        // A second client with an empty cookie jar but identical metadata:
        // same User-Agent, same headers, same address.
        const cookieless = fingerprinting.client('UA-metadata');
        const recovered = (await cookieless.json('/api/session')).session.id;
        assert.equal(recovered, original, 'the server recognised a returning client');

        // Different metadata means a different person.
        const other = fingerprinting.client('UA-somebody-else');
        assert.notEqual((await other.json('/api/session')).session.id, original);
      } finally {
        await fingerprinting.stop();
      }
    });

    test('the session response carries the limits the client needs', async () => {
      const body = await server.client('UA-limits').json('/api/session');
      assert.equal(typeof body.limits.maxMessageLength, 'number');
      assert.equal(typeof body.limits.maxUploadBytes, 'number');
      assert.equal(body.realtime.path, '/ws');
    });

    test('picking a username is a single request and assigns a colour', async () => {
      const client = server.client('UA-name');
      const session = await client.identify('Ana');
      assert.equal(session.displayName, 'Ana');
      assert.equal(typeof session.colorHue, 'number');
      assert.equal(session.identified, true);
      assert.match(session.colorHex, /^#[0-9a-f]{6}$/);
    });

    test('the UUID cannot be changed through the profile endpoint', async () => {
      const client = server.client('UA-uuid');
      const original = await client.identify('Ana');
      const updated = (await client.patch('/api/session', { id: 'hacked', displayName: 'Ana2' })).session;
      assert.equal(updated.id, original.id);
      assert.equal(updated.displayName, 'Ana2');
    });

    test('POST is accepted as an alias for PATCH', async () => {
      const client = server.client('UA-post-profile');
      await client.fetch('/');
      const body = await client.post('/api/session', { displayName: 'Vía POST' });
      assert.equal(body.session.displayName, 'Vía POST');
    });

    test('a malformed profile update is a 400 with a code', async () => {
      const client = server.client('UA-bad-profile');
      await client.fetch('/');
      await assert.rejects(() => client.patch('/api/session', { displayName: '' }), (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, 'bad_request');
        return true;
      });
    });
  });

  describe('rooms API', () => {
    test('create, read, list and delete', async () => {
      const client = server.client('UA-rooms');
      await client.identify('Ana');

      const created = (await client.post('/api/rooms', { name: 'General', topic: 'Anything' })).room;
      assert.match(created.id, /^[0-9a-f-]{36}$/);
      assert.equal(created.name, 'General');
      assert.equal(created.userCount, 0);

      const fetched = (await client.json(`/api/rooms/${created.id}`)).room;
      assert.equal(fetched.id, created.id);

      const list = (await client.json('/api/rooms')).rooms;
      assert.ok(list.some((room) => room.id === created.id));

      const response = await client.del(`/api/rooms/${created.id}`);
      assert.equal(response.status, 204);
      await assert.rejects(() => client.json(`/api/rooms/${created.id}`), (error) => error.status === 404);
    });

    test('creating a room requires a username', async () => {
      const client = server.client('UA-anon-room');
      await client.fetch('/');
      await assert.rejects(() => client.post('/api/rooms', { name: 'Nope' }), (error) => {
        assert.equal(error.status, 401);
        assert.equal(error.code, 'identity_required');
        return true;
      });
    });

    test('only the creator can delete a room', async () => {
      const owner = server.client('UA-owner');
      const stranger = server.client('UA-stranger');
      await owner.identify('Ana');
      await stranger.identify('Luis');

      const room = (await owner.post('/api/rooms', { name: 'Private' })).room;
      const denied = await stranger.del(`/api/rooms/${room.id}`);
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error.code, 'forbidden');

      assert.equal((await owner.del(`/api/rooms/${room.id}`)).status, 204);
    });

    test('messages can be posted and read back in order', async () => {
      const client = server.client('UA-messages');
      await client.identify('Ana');
      const room = (await client.post('/api/rooms', { name: 'History' })).room;

      for (const text of ['one', 'two', 'three']) {
        await client.post(`/api/rooms/${room.id}/messages`, { body: text });
      }

      const all = (await client.json(`/api/rooms/${room.id}/messages`)).messages;
      assert.deepEqual(all.map((message) => message.body), ['one', 'two', 'three']);

      const tail = (await client.json(`/api/rooms/${room.id}/messages?limit=2`)).messages;
      assert.deepEqual(tail.map((message) => message.body), ['two', 'three']);
    });

    test('unknown rooms and endpoints return structured JSON errors', async () => {
      const client = server.client('UA-404');
      const missing = await client.fetch('/api/rooms/11111111-1111-4111-8111-111111111111');
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, 'room_not_found');

      const unknown = await client.fetch('/api/does-not-exist');
      assert.equal(unknown.status, 404);
      assert.equal((await unknown.json()).error.code, 'not_found');
    });

    test('a wrong method on a known path is a 405', async () => {
      const client = server.client('UA-405');
      const response = await client.fetch('/api/session', { method: 'DELETE' });
      assert.equal(response.status, 405);
      assert.equal((await response.json()).error.code, 'method_not_allowed');
    });

    test('a malformed JSON body is a clean 400', async () => {
      const client = server.client('UA-badjson');
      await client.identify('Ana');
      const response = await client.fetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      });
      assert.equal(response.status, 400);
    });
  });

  describe('health', () => {
    test('reports in-memory counters', async () => {
      const fresh = await startTestServer();
      try {
        const client = fresh.client('UA-health');
        await client.identify('Ana');
        await client.post('/api/rooms', { name: 'Counted' });

        const body = await client.json('/api/health');
        assert.equal(body.status, 'ok');
        assert.equal(body.protocol, 'http');
        assert.equal(body.counts.rooms, 1);
        assert.equal(body.counts.messages, 0);
        assert.equal(body.counts.connections, 0);
      } finally {
        await fresh.stop();
      }
    });
  });

  describe('static assets', () => {
    test('serves the client application', async () => {
      const client = server.client('UA-static');
      const html = await client.fetch('/');
      const text = await html.text();
      assert.match(text, /<title>Pellets<\/title>/);
      assert.match(text, /data-theme="dark"/, 'dark mode is the default in the shell itself');

      const css = await client.fetch('/css/tokens.css');
      assert.equal(css.status, 200);
      assert.match(css.headers.get('content-type'), /text\/css/);

      const js = await client.fetch('/js/main.js');
      assert.equal(js.status, 200);
      assert.match(js.headers.get('content-type'), /javascript/);
    });

    test('sends security headers and supports conditional requests', async () => {
      const client = server.client('UA-cond');
      const first = await client.fetch('/css/base.css');
      assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
      const etag = first.headers.get('etag');
      assert.ok(etag);

      const second = await client.fetch('/css/base.css', { headers: { 'if-none-match': etag } });
      assert.equal(second.status, 304);
    });

    test('application routes fall back to the shell so links are shareable', async () => {
      const client = server.client('UA-spa');
      for (const path of ['/settings', '/room/11111111-1111-4111-8111-111111111111', '/anything/deep']) {
        const response = await client.fetch(path, { headers: { accept: 'text/html' } });
        assert.equal(response.status, 200, `${path} should serve the application shell`);
        assert.match(await response.text(), /<title>Pellets<\/title>/);
      }
    });

    test('a missing asset is a 404, not the shell', async () => {
      const client = server.client('UA-missing-asset');
      const response = await client.fetch('/css/does-not-exist.css');
      assert.equal(response.status, 404);
    });

    test('path traversal cannot escape the public directory', async () => {
      const client = server.client('UA-traversal');
      for (const path of ['/../package.json', '/..%2fpackage.json', '/css/../../package.json']) {
        const response = await client.fetch(path);
        const text = await response.text();
        assert.doesNotMatch(text, /"name": "pellets"/, `${path} must not expose package.json`);
      }
    });

    test('HEAD returns headers without a body', async () => {
      const client = server.client('UA-head');
      const response = await client.fetch('/css/base.css', { method: 'HEAD' });
      assert.equal(response.status, 200);
      assert.ok(Number(response.headers.get('content-length')) > 0);
      assert.equal((await response.text()).length, 0);
    });
  });

  describe('range requests', () => {
    // Range support is what lets a browser seek inside a <video> attachment.
    test('serves a byte range with 206 and Content-Range', async () => {
      const client = server.client('UA-range');
      const full = await (await client.fetch('/css/base.css')).text();

      const response = await client.fetch('/css/base.css', { headers: { range: 'bytes=0-9' } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), `bytes 0-9/${Buffer.byteLength(full)}`);
      assert.equal(await response.text(), full.slice(0, 10));
    });

    test('supports an open-ended range and a suffix range', async () => {
      const client = server.client('UA-range2');
      const full = await (await client.fetch('/css/base.css')).text();
      const size = Buffer.byteLength(full);

      const open = await client.fetch('/css/base.css', { headers: { range: 'bytes=10-' } });
      assert.equal(open.headers.get('content-range'), `bytes 10-${size - 1}/${size}`);

      const suffix = await client.fetch('/css/base.css', { headers: { range: 'bytes=-20' } });
      assert.equal(suffix.headers.get('content-range'), `bytes ${size - 20}-${size - 1}/${size}`);
    });

    test('an unsatisfiable range is a 416', async () => {
      const client = server.client('UA-range3');
      const response = await client.fetch('/css/base.css', { headers: { range: 'bytes=99999999-' } });
      assert.equal(response.status, 416);
      assert.match(response.headers.get('content-range'), /^bytes \*\//);
    });

    test('advertises range support on normal responses', async () => {
      const client = server.client('UA-range4');
      const response = await client.fetch('/css/base.css');
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
    });
  });
});
