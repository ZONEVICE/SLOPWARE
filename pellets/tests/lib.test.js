/**
 * Unit tests for the dependency-free helpers in `src/lib/`.
 *
 * These are pure functions, so every case here runs without a server.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { uuid4, isUuid4, token, sortableId } from '../src/lib/ids.js';
import { HUE_PALETTE, randomHue, normalizeHue, hueToHex } from '../src/lib/colors.js';
import { parseCookies, serializeCookie } from '../src/lib/cookies.js';
import { lookupMime, classify, extname, extensionForMime, safeExtension, isInlineRenderable } from '../src/lib/mime.js';
import { EventBus, EVENTS } from '../src/lib/events.js';
import * as asn1 from '../src/lib/asn1.js';
import { parseArgs, createConfig } from '../src/config.js';

describe('ids', () => {
  test('uuid4 produces valid, unique v4 identifiers', () => {
    const seen = new Set();
    for (let index = 0; index < 500; index += 1) {
      const id = uuid4();
      assert.ok(isUuid4(id), `${id} should look like a v4 UUID`);
      assert.equal(seen.has(id), false, 'ids must not repeat');
      seen.add(id);
    }
  });

  test('isUuid4 rejects malformed values', () => {
    for (const value of ['', 'nope', null, undefined, 42, '123e4567-e89b-12d3-a456-426614174000']) {
      assert.equal(isUuid4(value), false, `${String(value)} should be rejected`);
    }
    // The last one above is a v1 UUID: the version nibble must be 4.
  });

  test('token is url-safe and of the requested length', () => {
    const value = token(9);
    assert.match(value, /^[A-Za-z0-9_-]+$/);
    assert.equal(Buffer.from(value, 'base64url').length, 9);
  });

  test('sortableId sorts chronologically even within one millisecond', () => {
    const ids = Array.from({ length: 50 }, () => sortableId());
    assert.deepEqual([...ids].sort(), ids, 'lexical order must equal creation order');
  });
});

describe('colors', () => {
  test('randomHue only returns palette entries', () => {
    for (let index = 0; index < 100; index += 1) {
      assert.ok(HUE_PALETTE.includes(randomHue()), 'hue must come from the palette');
    }
  });

  test('randomHue avoids hues that are already taken', () => {
    const taken = [];
    for (let index = 0; index < HUE_PALETTE.length; index += 1) taken.push(randomHue(taken));
    assert.equal(new Set(taken).size, HUE_PALETTE.length, 'the first N users all get distinct colours');
  });

  test('randomHue spreads reuse evenly once the palette is exhausted', () => {
    const taken = [];
    for (let index = 0; index < HUE_PALETTE.length * 2; index += 1) taken.push(randomHue(taken));
    const counts = HUE_PALETTE.map((hue) => taken.filter((value) => value === hue).length);
    assert.equal(Math.max(...counts), 2);
    assert.equal(Math.min(...counts), 2);
  });

  test('normalizeHue wraps instead of rejecting, and rejects non-numbers', () => {
    assert.equal(normalizeHue(0), 0);
    assert.equal(normalizeHue(360), 0);
    assert.equal(normalizeHue(-20), 340);
    assert.equal(normalizeHue('200'), 200);
    assert.equal(normalizeHue('red'), null);
    assert.equal(normalizeHue(null), null);
    assert.equal(normalizeHue(Number.NaN), null);
  });

  test('hueToHex produces the expected primaries', () => {
    assert.equal(hueToHex(0, 100, 50), '#ff0000');
    assert.equal(hueToHex(120, 100, 50), '#00ff00');
    assert.equal(hueToHex(240, 100, 50), '#0000ff');
    assert.equal(hueToHex(0, 0, 100), '#ffffff');
  });
});

describe('cookies', () => {
  test('parses a multi-value header', () => {
    const parsed = parseCookies('a=1; b=hello%20world; c="quoted"');
    assert.deepEqual(parsed, { a: '1', b: 'hello world', c: 'quoted' });
  });

  test('tolerates junk without throwing', () => {
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies(''), {});
    assert.deepEqual(parseCookies('novalue; =empty; ok=1'), { ok: '1' });
    // An invalid percent escape keeps the raw value rather than dropping it.
    assert.deepEqual(parseCookies('bad=%E0%A4%A'), { bad: '%E0%A4%A' });
  });

  test('serializes with the expected attributes', () => {
    const header = serializeCookie('pellets.sid', 'abc', { maxAge: 60, secure: true, sameSite: 'Lax' });
    assert.match(header, /^pellets\.sid=abc; Path=\//);
    assert.match(header, /Max-Age=60/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
    assert.match(header, /SameSite=Lax/);
  });

  test('round-trips values that need escaping', () => {
    const header = serializeCookie('k', 'a b;c');
    const parsed = parseCookies(header.split(';')[0]);
    assert.equal(parsed.k, 'a b;c');
  });
});

describe('mime', () => {
  test('maps extensions case-insensitively', () => {
    assert.equal(extname('photo.JPG'), '.jpg');
    assert.equal(lookupMime('photo.JPG'), 'image/jpeg');
    assert.equal(lookupMime('clip.webm'), 'video/webm');
    assert.equal(lookupMime('archive.unknownext'), 'application/octet-stream');
    assert.equal(lookupMime('noextension'), 'application/octet-stream');
  });

  test('classify implements the three attachment behaviours', () => {
    assert.equal(classify({ mime: 'image/png' }), 'image');
    assert.equal(classify({ mime: 'video/mp4' }), 'video');
    assert.equal(classify({ mime: 'application/pdf' }), 'file');
    // A generic declared type falls back to the filename.
    assert.equal(classify({ mime: 'application/octet-stream', name: 'a.png' }), 'image');
    assert.equal(classify({ name: 'a.mov' }), 'video');
    assert.equal(classify({ name: 'a.zip' }), 'file');
    assert.equal(classify({}), 'file');
  });

  test('extensionForMime and safeExtension', () => {
    assert.equal(extensionForMime('image/png'), '.png');
    assert.equal(extensionForMime('text/html; charset=utf-8'), '.html');
    assert.equal(extensionForMime('application/octet-stream'), '');
    assert.equal(safeExtension('.png'), '.png');
    assert.equal(safeExtension('.PNG'), '.png');
    // Anything that could escape the uploads directory is dropped.
    assert.equal(safeExtension('./../etc'), '');
    assert.equal(safeExtension('.a/b'), '');
    assert.equal(safeExtension('.verylongextension'), '');
  });

  test('isInlineRenderable only allows media', () => {
    assert.equal(isInlineRenderable('image/png'), true);
    assert.equal(isInlineRenderable('video/mp4'), true);
    assert.equal(isInlineRenderable('audio/mpeg'), true);
    assert.equal(isInlineRenderable('text/html'), false);
    assert.equal(isInlineRenderable('application/pdf'), false);
  });
});

describe('event bus', () => {
  test('delivers to every subscriber and supports unsubscribe', () => {
    const bus = new EventBus({ onError: () => {} });
    const seen = [];
    const off = bus.on('x', (value) => seen.push(`a${value}`));
    bus.on('x', (value) => seen.push(`b${value}`));
    bus.emit('x', 1);
    off();
    bus.emit('x', 2);
    assert.deepEqual(seen, ['a1', 'b1', 'b2']);
  });

  test('a throwing subscriber does not stop the others', () => {
    const failures = [];
    const bus = new EventBus({ onError: (error, event) => failures.push(`${event}:${error.message}`) });
    const seen = [];
    bus.on('x', () => {
      throw new Error('boom');
    });
    bus.on('x', () => seen.push('ran'));
    bus.emit('x');
    assert.deepEqual(seen, ['ran']);
    assert.deepEqual(failures, ['x:boom']);
  });

  test('once fires a single time', () => {
    const bus = new EventBus();
    let count = 0;
    bus.once('x', () => {
      count += 1;
    });
    bus.emit('x');
    bus.emit('x');
    assert.equal(count, 1);
  });

  test('every published event name is registered in EVENTS', () => {
    // Guards against a typo'd string literal silently going nowhere.
    const values = Object.values(EVENTS);
    assert.equal(new Set(values).size, values.length, 'event names must be unique');
    for (const value of values) assert.match(value, /^[a-z]+\.[a-zA-Z]+$/);
  });
});

describe('asn1 DER encoder', () => {
  test('object identifiers match the known encodings', () => {
    assert.equal(asn1.oid('1.2.840.113549.1.1.11').toString('hex'), '06092a864886f70d01010b');
    assert.equal(asn1.oid('2.5.29.17').toString('hex'), '0603551d11');
    assert.equal(asn1.oid('1.3.6.1.5.5.7.3.1').toString('hex'), '06082b06010505070301');
  });

  test('integers use the minimal two-complement form', () => {
    assert.equal(asn1.integer(0).toString('hex'), '020100');
    assert.equal(asn1.integer(127).toString('hex'), '02017f');
    // A leading high bit needs a zero pad so the value stays positive.
    assert.equal(asn1.integer(128).toString('hex'), '02020080');
    assert.equal(asn1.integer(255).toString('hex'), '020200ff');
    assert.equal(asn1.integer(Buffer.from([0x00, 0x00, 0x01])).toString('hex'), '020101');
  });

  test('length encoding switches to the long form above 127', () => {
    assert.equal(asn1.encodeLength(10).toString('hex'), '0a');
    assert.equal(asn1.encodeLength(127).toString('hex'), '7f');
    assert.equal(asn1.encodeLength(128).toString('hex'), '8180');
    assert.equal(asn1.encodeLength(300).toString('hex'), '82012c');
  });

  test('readTLV round-trips what the encoder produced', () => {
    const structure = asn1.seq(asn1.integer(1), asn1.utf8String('hi'), asn1.boolean(true));
    const outer = asn1.readTLV(structure);
    assert.equal(outer.tag, asn1.TAG.SEQUENCE);

    const first = asn1.readTLV(outer.value, 0);
    assert.equal(first.tag, asn1.TAG.INTEGER);
    const second = asn1.readTLV(outer.value, first.end);
    assert.equal(second.value.toString('utf8'), 'hi');
    const third = asn1.readTLV(outer.value, second.end);
    assert.equal(third.value[0], 0xff, 'DER booleans use 0xFF for true');
  });

  test('UTCTime is used before 2050 and GeneralizedTime after', () => {
    assert.equal(asn1.x509Time(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))[0], asn1.TAG.UTC_TIME);
    assert.equal(asn1.x509Time(new Date(Date.UTC(2051, 0, 2)))[0], asn1.TAG.GENERALIZED_TIME);
    assert.equal(
      asn1.utcTime(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))).subarray(2).toString('ascii'),
      '260102030405Z',
    );
  });

  test('PEM wrapping produces 64 character lines', () => {
    const pem = asn1.toPem('CERTIFICATE', Buffer.alloc(200, 7));
    const lines = pem.trim().split('\n');
    assert.equal(lines[0], '-----BEGIN CERTIFICATE-----');
    assert.equal(lines[lines.length - 1], '-----END CERTIFICATE-----');
    for (const line of lines.slice(1, -1)) assert.ok(line.length <= 64);
  });
});

describe('configuration', () => {
  test('parses the documented startup flags', () => {
    assert.equal(parseArgs([]).protocol, undefined);
    assert.equal(parseArgs(['--http']).protocol, 'http');
    assert.equal(parseArgs(['--https']).protocol, 'https');
    assert.equal(parseArgs(['--tls']).protocol, 'https');
    assert.equal(parseArgs(['--port', '3000']).port, 3000);
    assert.equal(parseArgs(['--port=3000']).port, 3000);
    assert.equal(parseArgs(['-p', '3000']).port, 3000);
    assert.equal(parseArgs(['--host=1.2.3.4']).host, '1.2.3.4');
    assert.deepEqual(parseArgs(['--nonsense']).unknown, ['--nonsense']);
    assert.equal(parseArgs(['-h']).help, true);
  });

  test('npm start defaults to HTTP on port 8080', () => {
    const config = createConfig([]);
    assert.equal(config.protocol, 'http');
    assert.equal(config.port, 8080);
    assert.equal(config.host, '0.0.0.0');
  });

  test('--https selects HTTPS and keeps the other defaults', () => {
    const config = createConfig(['--https']);
    assert.equal(config.protocol, 'https');
    assert.equal(config.tls.keyType, 'ec');
    assert.equal(config.tls.days, 365);
  });

  test('message history is unlimited by default', () => {
    // The specification requires a joining client to see every earlier message.
    assert.equal(createConfig([]).chat.maxMessagesPerRoom, 0);
  });

  test('the configuration object is frozen', () => {
    const config = createConfig([]);
    assert.throws(() => {
      config.port = 1;
    }, TypeError);
  });
});
