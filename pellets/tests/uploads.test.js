/**
 * Attachment upload and delivery.
 *
 * Covers the specification's file rules end to end:
 *  - images, videos and other binaries are classified for the three UI
 *    behaviours (preview, preview+play, download)
 *  - files are written to `uploads/` in the application directory
 *  - those files survive a restart, while their chat context does not
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startTestServer } from './helpers/server.js';

/** Build a multipart body the way a browser's FormData would. */
function multipart(files, fields = {}) {
  const boundary = `----pellets${Math.random().toString(36).slice(2)}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
          `Content-Type: ${file.type}\r\n\r\n`,
      ),
    );
    chunks.push(file.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** A tiny but genuinely valid PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('uploads', () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  let client;

  before(async () => {
    server = await startTestServer();
    client = server.client('UA-uploads');
    await client.identify('Ana');
  });

  after(async () => {
    await server.stop();
  });

  /** Upload one file through the multipart endpoint. */
  async function upload(file, fields = {}) {
    const { body, contentType } = multipart([file], fields);
    return (await client.json('/api/uploads', { method: 'POST', headers: { 'content-type': contentType }, body }))
      .uploads[0];
  }

  test('an image is stored, classified and served inline', async () => {
    const view = await upload({ name: 'photo.png', type: 'image/png', data: PNG });

    assert.equal(view.kind, 'image');
    assert.equal(view.mime, 'image/png');
    assert.equal(view.name, 'photo.png');
    assert.equal(view.size, PNG.length);
    assert.match(view.url, /^\/uploads\/[0-9a-f-]{36}\.png$/);

    const response = await client.fetch(view.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.match(response.headers.get('content-disposition') || 'inline', /inline|^$/);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(PNG));
  });

  test('a video is classified for the play-on-click behaviour', async () => {
    const view = await upload({ name: 'clip.mp4', type: 'video/mp4', data: Buffer.alloc(2048, 3) });
    assert.equal(view.kind, 'video');
    assert.equal(view.mime, 'video/mp4');

    // Seeking a video needs range support on the stored file.
    const ranged = await client.fetch(view.url, { headers: { range: 'bytes=0-99' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), 'bytes 0-99/2048');
  });

  test('any other binary becomes a downloadable file card', async () => {
    const view = await upload({ name: 'report.pdf', type: 'application/pdf', data: Buffer.alloc(64, 1) });
    assert.equal(view.kind, 'file');

    // A non-media attachment downloads even without the explicit query.
    const plain = await client.fetch(view.url);
    assert.match(plain.headers.get('content-disposition'), /^attachment/);

    const forced = await client.fetch(view.downloadUrl);
    assert.match(forced.headers.get('content-disposition'), /filename="report\.pdf"/);
  });

  test('a non-ASCII filename survives the round trip', async () => {
    const view = await upload({ name: 'informe año ñ.txt', type: 'text/plain', data: Buffer.from('x') });
    assert.equal(view.name, 'informe año ñ.txt');
    const response = await client.fetch(view.downloadUrl);
    const disposition = response.headers.get('content-disposition');
    assert.match(disposition, /filename\*=UTF-8''/);
    assert.equal(decodeURIComponent(disposition.split("UTF-8''")[1]), 'informe año ñ.txt');
  });

  test('user content is served with scripting disabled', async () => {
    const view = await upload({
      name: 'evil.svg',
      type: 'image/svg+xml',
      data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    });
    const response = await client.fetch(view.url);
    assert.match(response.headers.get('content-security-policy'), /sandbox/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  test('several files can be uploaded in one request', async () => {
    const { body, contentType } = multipart([
      { name: 'a.png', type: 'image/png', data: PNG },
      { name: 'b.txt', type: 'text/plain', data: Buffer.from('hello') },
    ]);
    const result = await client.json('/api/uploads', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });
    assert.equal(result.uploads.length, 2);
    assert.deepEqual(result.uploads.map((view) => view.kind), ['image', 'file']);
  });

  test('a raw body upload works for scripts and curl', async () => {
    const result = await client.json('/api/uploads', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-pellets-filename': encodeURIComponent('notas.txt') },
      body: 'contenido',
    });
    const view = result.uploads[0];
    assert.equal(view.name, 'notas.txt');
    assert.equal(await (await client.fetch(view.url)).text(), 'contenido');
  });

  test('a raw upload without a filename is refused', async () => {
    const response = await client.fetch('/api/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'data',
    });
    assert.equal(response.status, 400);
  });

  test('uploading requires a username', async () => {
    const anonymous = server.client('UA-anon-upload');
    await anonymous.fetch('/');
    const { body, contentType } = multipart([{ name: 'a.txt', type: 'text/plain', data: Buffer.from('x') }]);
    const response = await anonymous.fetch('/api/uploads', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'identity_required');
  });

  test('an oversized upload is refused, by declared size and while streaming', async () => {
    // A 1 MB cap, so the test can exceed it without moving real volume.
    const previous = process.env.PELLETS_MAX_UPLOAD_MB;
    process.env.PELLETS_MAX_UPLOAD_MB = '1';
    const limited = await startTestServer();
    try {
      assert.equal(limited.config.uploads.maxBytes, 1024 * 1024);
      const uploader = limited.client('UA-toobig');
      await uploader.identify('Ana');
      const oversized = Buffer.alloc(2 * 1024 * 1024, 7);

      // 1. Content-Length already exceeds the limit: refused before any write.
      const declared = await uploader.fetch('/api/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-pellets-filename': 'big.bin' },
        body: oversized,
      });
      assert.equal(declared.status, 413);
      assert.equal((await declared.json()).error.code, 'payload_too_large');

      // 2. No Content-Length (chunked): the streaming counter has to catch it.
      const chunked = await uploader.fetch('/api/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-pellets-filename': 'big2.bin' },
        duplex: 'half',
        body: new ReadableStream({
          start(controller) {
            for (let index = 0; index < 16; index += 1) controller.enqueue(new Uint8Array(128 * 1024));
            controller.close();
          },
        }),
      }).catch((error) => ({ status: 0, error }));
      assert.ok(chunked.status === 413 || chunked.status === 0, 'the request is refused one way or another');

      // Nothing oversized was left behind in either case.
      const entries = await readdir(limited.uploadsDir);
      assert.deepEqual(entries, [], `uploads/ should be empty, found ${entries.join(', ')}`);
    } finally {
      await limited.stop();
      if (previous === undefined) delete process.env.PELLETS_MAX_UPLOAD_MB;
      else process.env.PELLETS_MAX_UPLOAD_MB = previous;
    }
  });

  test('an unknown stored file is a 404 and traversal is impossible', async () => {
    assert.equal((await client.fetch('/uploads/nope.png')).status, 404);
    assert.equal((await client.fetch('/uploads/../package.json')).status, 404);
    const escaped = await client.fetch('/uploads/..%2f..%2fpackage.json');
    assert.notEqual(escaped.status, 200);
  });

  test('files land in the uploads directory under UUID names', async () => {
    const isolated = await startTestServer();
    try {
      const uploader = isolated.client('UA-disk');
      await uploader.identify('Ana');
      const { body, contentType } = multipart([{ name: 'secret name.txt', type: 'text/plain', data: Buffer.from('on disk') }]);
      const view = (
        await uploader.json('/api/uploads', { method: 'POST', headers: { 'content-type': contentType }, body })
      ).uploads[0];

      const entries = await readdir(isolated.uploadsDir);
      assert.deepEqual(entries, [view.storedName ?? view.url.split('/').pop()]);
      assert.match(entries[0], /^[0-9a-f-]{36}\.txt$/, 'the original name never reaches the filesystem');
      assert.equal(await readFile(join(isolated.uploadsDir, entries[0]), 'utf8'), 'on disk');
    } finally {
      await isolated.stop();
    }
  });

  test('uploaded files outlive a restart while the chat around them does not', async () => {
    const first = await startTestServer();
    const uploader = first.client('UA-restart');
    await uploader.identify('Ana');
    const room = (await uploader.post('/api/rooms', { name: 'Ephemeral' })).room;

    const { body, contentType } = multipart([{ name: 'keep.txt', type: 'text/plain', data: Buffer.from('persisted') }]);
    const view = (
      await uploader.json('/api/uploads', { method: 'POST', headers: { 'content-type': contentType }, body })
    ).uploads[0];
    await uploader.post(`/api/rooms/${room.id}/messages`, { body: 'see attachment', attachmentIds: [view.id] });

    const uploadsDir = first.uploadsDir;
    await first.app.close();

    // A brand new process pointed at the same uploads directory.
    const second = await startTestServer({ overrides: { uploadsDir } });
    try {
      const reader = second.client('UA-restart-2');
      await reader.fetch('/');

      // The bytes are still there and still served.
      const response = await reader.fetch(view.url);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'persisted');

      // The chat that referenced it is gone, and nothing lists the file.
      assert.deepEqual((await reader.json('/api/rooms')).rooms, []);
      assert.equal((await reader.json('/api/health')).counts.uploads, 0);
    } finally {
      // `second` shares the directory with `first`; remove it once.
      await second.app.close();
      await first.stop();
    }
  });
});
