/**
 * The HTTP surface: the control panel's files and API, the live event stream,
 * the peer API's authentication, and the guard that keeps the control panel
 * to this computer and away from other websites.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGuard } from '../src/http/guard.js';
import { cleanup, startInstance, tempDir } from './helpers/instances.js';

after(cleanup);

/** A raw GET that returns status, headers and body text. */
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Read server-sent events until `count` state events arrived. */
function readEvents(port, count) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events', agent: false }, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (block.includes('event: state') && data) events.push(JSON.parse(data.slice(6)));
          if (events.length >= count) {
            req.destroy();
            resolve({ events, headers: res.headers });
            return;
          }
          split = buffer.indexOf('\n\n');
        }
      });
    });
    req.on('error', (error) => (events.length >= count ? null : reject(error)));
    req.end();
  });
}

describe('control panel files', () => {
  test('the page, its styles and its scripts are served', async () => {
    const instance = await startInstance();
    const page = await get(instance.port, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /<title>Reptile<\/title>/);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    for (const asset of ['/css/base.css', '/js/main.js', '/js/views/index.js', '/icons/favicon.svg']) {
      const response = await get(instance.port, asset);
      assert.equal(response.status, 200, asset);
    }
    assert.match((await get(instance.port, '/js/main.js')).headers['content-type'], /javascript/);
  });

  test('unknown paths are 404, API ones as JSON', async () => {
    const instance = await startInstance();
    assert.equal((await get(instance.port, '/nope.html')).status, 404);
    const api = await get(instance.port, '/api/nope');
    assert.equal(api.status, 404);
    assert.equal(JSON.parse(api.body).error.code, 'not_found');
    const traversal = await get(instance.port, '/..%2f..%2fetc%2fpasswd');
    assert.equal(traversal.status, 404);
  });

  test('a wrong method is 405', async () => {
    const instance = await startInstance();
    const answer = await instance.api('PUT', '/api/state', {});
    assert.equal(answer.status, 405);
  });
});

describe('control panel API', () => {
  test('the state snapshot has everything the status bar needs', async () => {
    const instance = await startInstance();
    const { data } = await instance.api('GET', '/api/state');
    assert.equal(data.identity.uuid, instance.app.identity.uuid);
    assert.equal(data.identity.port, instance.port);
    assert.equal(data.identity.protocol, 'http');
    assert.ok(data.identity.hostname);
    assert.ok(data.identity.address);
    assert.equal(data.mode, 'idle');
    assert.equal(typeof data.discovery.enabled, 'boolean');
  });

  test('state changes are pushed over server-sent events', async () => {
    const instance = await startInstance();
    const root = await tempDir();
    const listening = readEvents(instance.port, 2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await instance.api('POST', '/api/host', { path: root, name: 'Live', pin: '1234' });
    const { events, headers } = await listening;
    assert.match(headers['content-type'], /text\/event-stream/);
    assert.equal(events[0].mode, 'idle');
    assert.equal(events.at(-1).mode, 'hosting');
    assert.equal(events.at(-1).hosting.name, 'Live');
  });

  test('bodies must be JSON objects', async () => {
    const instance = await startInstance();
    const answer = await instance.api('POST', '/api/host', 'just a string');
    assert.equal(answer.status, 400);
  });
});

describe('peer API authentication', () => {
  test('everything but ping and connect needs a session token', async () => {
    const instance = await startInstance();
    await instance.app.modes.startHosting({ path: await tempDir(), name: 'Locked', pin: '1234' });
    for (const [method, path, body] of [
      ['GET', '/api/peer/manifest'],
      ['GET', '/api/peer/file?path=a'],
      ['POST', '/api/peer/ops', { ops: [] }],
      ['POST', '/api/peer/hashes', { paths: [] }],
      ['POST', '/api/peer/heartbeat', {}],
    ]) {
      const answer = await instance.api(method, path, body, { Authorization: 'Bearer not-a-token' });
      assert.equal(answer.status, 401, `${method} ${path}`);
    }
    const stream = await get(instance.port, '/api/peer/stream');
    assert.equal(stream.status, 401);
    assert.equal((await instance.api('GET', '/api/ping')).status, 200);
  });

  test('connect needs the PIN, and hands out a token that works', async () => {
    const instance = await startInstance();
    await instance.app.modes.startHosting({ path: await tempDir(), name: 'Locked', pin: '1234' });
    const peer = { uuid: 'p', hostname: 'p' };
    const wrong = await instance.api('POST', '/api/peer/connect', { pin: '9999', protocol: 'http', peer });
    assert.equal(wrong.status, 403);
    const right = await instance.api('POST', '/api/peer/connect', { pin: '1234', protocol: 'http', peer });
    assert.equal(right.status, 200);
    const manifest = await instance.api('GET', '/api/peer/manifest', undefined, { Authorization: `Bearer ${right.data.token}` });
    assert.equal(manifest.status, 200);
    assert.deepEqual(manifest.data.entries, []);
  });
});

describe('control panel guard', () => {
  const guard = createGuard({ allowRemote: false, hostname: 'box', interfaces: () => ({ eth0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }] }) });
  const request = ({ remote = '127.0.0.1', method = 'GET', headers = {} } = {}) => ({
    method,
    socket: { remoteAddress: remote },
    headers: { host: '127.0.0.1:55667', ...headers },
  });

  test('requests from this computer are allowed, from elsewhere refused', () => {
    assert.equal(guard.checkUi(request()), null);
    assert.equal(guard.checkUi(request({ remote: '::ffff:127.0.0.1' })), null);
    assert.equal(guard.checkUi(request({ remote: '192.168.1.10' })), null, 'our own LAN address');
    const refused = guard.checkUi(request({ remote: '192.168.1.99' }));
    assert.equal(refused.status, 403);
    assert.equal(refused.code, 'remote_ui_disabled');
    assert.match(refused.message, /--remote-ui/);
  });

  test('--remote-ui opens the panel to the network', () => {
    const open = createGuard({ allowRemote: true, hostname: 'box' });
    assert.equal(open.checkUi(request({ remote: '192.168.1.99' })), null);
  });

  test('a foreign Host header is refused (DNS rebinding)', () => {
    assert.equal(guard.checkUi(request({ headers: { host: 'evil.example:55667' } })).code, 'bad_host');
    assert.equal(guard.checkUi(request({ headers: { host: 'localhost:55667' } })), null);
    assert.equal(guard.checkUi(request({ headers: { host: 'BOX.local:55667' } })), null);
    assert.equal(guard.checkUi(request({ headers: { host: '[::1]:55667' } })), null);
  });

  test('cross-site writes are refused', () => {
    const json = { 'content-type': 'application/json' };
    assert.equal(guard.checkUi(request({ method: 'POST', headers: { ...json, origin: 'http://127.0.0.1:55667' } })), null);
    assert.equal(guard.checkUi(request({ method: 'POST', headers: { ...json, origin: 'http://evil.example' } })).code, 'cross_site');
    assert.equal(guard.checkUi(request({ method: 'POST', headers: { ...json, 'sec-fetch-site': 'cross-site' } })).code, 'cross_site');
    assert.equal(guard.checkUi(request({ method: 'POST', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal(guard.checkUi(request({ method: 'DELETE' })), null);
  });

  test('the running server applies the guard to the panel but not to peers', async () => {
    const instance = await startInstance();
    const cross = await instance.api('POST', '/api/discovery', { enabled: false }, { Origin: 'http://evil.example' });
    assert.equal(cross.status, 403);
    const ping = await get(instance.port, '/api/ping', { Host: 'anything.example' });
    assert.equal(ping.status, 200, 'peers may use any Host header');
  });
});
