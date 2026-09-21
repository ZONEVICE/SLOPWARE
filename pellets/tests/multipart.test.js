/**
 * Streaming multipart/form-data parser.
 *
 * The parser has to be byte-exact regardless of how the network splits the
 * body, so most of these tests feed the same payload at several chunk sizes,
 * including one byte at a time.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MultipartParser, getBoundary, parseContentType, parseContentDisposition } from '../src/http/multipart.js';

const BOUNDARY = '----PelletsTestBoundary9f2';

/** Assemble a multipart body from a declarative description. */
function buildBody(parts) {
  const chunks = [];
  for (const part of parts) {
    let headers = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) headers += `; filename="${part.filename}"`;
    headers += '\r\n';
    if (part.type) headers += `Content-Type: ${part.type}\r\n`;
    headers += '\r\n';
    chunks.push(Buffer.from(headers, 'utf8'));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(String(part.body), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

/** Run a body through the parser at a given chunk size. */
function parse(body, chunkSize = body.length) {
  return new Promise((resolve, reject) => {
    const parser = new MultipartParser(BOUNDARY);
    const fields = {};
    const files = [];

    parser.on('field', ({ name, value }) => {
      fields[name] = value;
    });

    parser.on('part', (part) => {
      const chunks = [];
      part.stream.on('data', (chunk) => chunks.push(chunk));
      part.stream.on('end', () =>
        files.push({ name: part.name, filename: part.filename, mime: part.mime, data: Buffer.concat(chunks) }),
      );
    });

    parser.on('error', reject);
    // `finish` fires when the closing boundary is seen; part streams end first.
    parser.on('finish', () => setImmediate(() => resolve({ fields, files })));

    for (let offset = 0; offset < body.length; offset += chunkSize) {
      parser.write(body.subarray(offset, offset + chunkSize));
    }
    parser.end();
  });
}

describe('header parsing', () => {
  test('getBoundary reads quoted and bare boundaries', () => {
    assert.equal(getBoundary('multipart/form-data; boundary="abc"'), 'abc');
    assert.equal(getBoundary('multipart/form-data; boundary=abc'), 'abc');
    assert.equal(getBoundary('MULTIPART/FORM-DATA; BOUNDARY=abc'), 'abc');
    assert.equal(getBoundary('application/json'), null);
    assert.equal(getBoundary(undefined), null);
  });

  test('parseContentType splits type and parameters', () => {
    const result = parseContentType('text/plain; charset=UTF-8');
    assert.equal(result.type, 'text/plain');
    assert.equal(result.parameters.charset, 'UTF-8');
  });

  test('parseContentDisposition does not confuse name with filename', () => {
    // A naive regex for `name` happily matches the tail of `filename`.
    assert.deepEqual(parseContentDisposition('form-data; name="file"; filename="a.mp4"'), {
      name: 'file',
      filename: 'a.mp4',
    });
    assert.deepEqual(parseContentDisposition('form-data; filename="only.png"'), {
      name: null,
      filename: 'only.png',
    });
    assert.deepEqual(parseContentDisposition('form-data; name="roomId"'), { name: 'roomId', filename: null });
  });

  test('parseContentDisposition understands RFC 5987 encoding', () => {
    const result = parseContentDisposition("form-data; name=f; filename*=UTF-8''h%C3%A9llo.png");
    assert.equal(result.name, 'f');
    assert.equal(result.filename, 'héllo.png');
  });
});

describe('body parsing', () => {
  const body = buildBody([
    { name: 'roomId', body: 'a-room-id' },
    { name: 'note', body: 'línea 1\nlínea 2' },
    {
      name: 'file',
      filename: 'café vídeo.mp4',
      type: 'video/mp4',
      // Deliberately contains "\r\n--" so a naive scanner would cut early.
      body: Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0d, 0x0a, 0x2d, 0x2d, 0x41, 0x42]),
    },
  ]);

  for (const chunkSize of [body.length, 64, 7, 3, 1]) {
    test(`is byte-exact when fed ${chunkSize} byte(s) at a time`, async () => {
      const { fields, files } = await parse(body, chunkSize);
      assert.equal(fields.roomId, 'a-room-id');
      assert.equal(fields.note, 'línea 1\nlínea 2');
      assert.equal(files.length, 1);
      assert.equal(files[0].filename, 'café vídeo.mp4');
      assert.equal(files[0].mime, 'video/mp4');
      assert.equal(files[0].data.toString('hex'), '0001fffe0d0a2d2d4142');
    });
  }

  test('handles several file parts in one request', async () => {
    const multi = buildBody([
      { name: 'file', filename: 'a.txt', type: 'text/plain', body: 'first' },
      { name: 'file', filename: 'b.txt', type: 'text/plain', body: 'second' },
    ]);
    const { files } = await parse(multi, 5);
    assert.deepEqual(
      files.map((file) => [file.filename, file.data.toString('utf8')]),
      [
        ['a.txt', 'first'],
        ['b.txt', 'second'],
      ],
    );
  });

  test('handles an empty file part', async () => {
    const { files } = await parse(buildBody([{ name: 'file', filename: 'empty.bin', body: Buffer.alloc(0) }]), 4);
    assert.equal(files.length, 1);
    assert.equal(files[0].data.length, 0);
  });

  test('preserves a large binary payload exactly', async () => {
    const payload = Buffer.alloc(300 * 1024);
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31) % 256;
    const { files } = await parse(buildBody([{ name: 'file', filename: 'big.bin', body: payload }]), 8191);
    assert.equal(files[0].data.length, payload.length);
    assert.ok(files[0].data.equals(payload));
  });

  test('ignores a preamble before the first boundary', async () => {
    const withPreamble = Buffer.concat([
      Buffer.from('This is a MIME preamble that clients sometimes send.\r\n', 'utf8'),
      buildBody([{ name: 'a', body: '1' }]),
    ]);
    const { fields } = await parse(withPreamble, 9);
    assert.equal(fields.a, '1');
  });

  test('rejects a truncated body instead of reporting success', async () => {
    const truncated = buildBody([{ name: 'file', filename: 'a.bin', body: 'xxxx' }]).subarray(0, 60);
    await assert.rejects(() => parse(truncated, 8), /Unexpected end of multipart body|Truncated/);
  });

  test('rejects oversized part headers', async () => {
    const parser = new MultipartParser(BOUNDARY, { maxHeaderBytes: 64 });
    const failed = new Promise((resolve) => parser.on('error', resolve));
    parser.write(Buffer.from(`--${BOUNDARY}\r\n`));
    parser.write(Buffer.from(`X-Long: ${'a'.repeat(200)}\r\n`));
    const error = await failed;
    assert.match(error.message, /headers too large/);
  });

  test('rejects an oversized non-file field', async () => {
    const parser = new MultipartParser(BOUNDARY, { maxFieldBytes: 16 });
    const failed = new Promise((resolve) => parser.on('error', resolve));
    parser.write(buildBody([{ name: 'big', body: 'x'.repeat(200) }]));
    const error = await failed;
    assert.match(error.message, /field too large/);
  });

  test('applies backpressure when a consumer stalls', async () => {
    const parser = new MultipartParser(BOUNDARY);
    let paused = false;
    parser.on('part', (part) => {
      // Never read the stream: its buffer fills and the parser must pause.
      part.stream.pause();
    });
    const body = buildBody([{ name: 'file', filename: 'big.bin', body: Buffer.alloc(200 * 1024, 9) }]);
    for (let offset = 0; offset < body.length && !paused; offset += 4096) {
      if (!parser.write(body.subarray(offset, offset + 4096))) paused = true;
    }
    assert.equal(paused, true, 'write() must report backpressure');
  });
});
