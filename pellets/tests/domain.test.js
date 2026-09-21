/**
 * Domain services, exercised without any HTTP or WebSocket transport.
 *
 * This is where the specification's rules are asserted directly:
 *  - a username is the only step, and anything is allowed as a username
 *  - a colour is assigned at random when the username is first chosen
 *  - the UUID never changes
 *  - messages cannot be edited or deleted
 *  - only a room's creator can delete it
 *  - a room stays open when it is empty
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { EventBus, EVENTS } from '../src/lib/events.js';
import { createStore } from '../src/store/index.js';
import { createDomain } from '../src/domain/index.js';
import { createConfig } from '../src/config.js';
import { isUuid4 } from '../src/lib/ids.js';

let context;

beforeEach(async () => {
  const uploadsDir = await mkdtemp(join(tmpdir(), 'pellets-domain-'));
  const config = createConfig([], { uploadsDir, logLevel: 'silent' });
  const bus = new EventBus({ onError: () => {} });
  const store = createStore();
  const domain = createDomain({ store, bus, config });
  await domain.uploads.ensureDirectory();

  /** Record every published event so tests can assert on the side effects. */
  const events = [];
  for (const name of Object.values(EVENTS)) bus.on(name, (payload) => events.push({ name, payload }));

  context = { config, bus, store, domain, events, uploadsDir };
});

afterEach(async () => {
  context.domain.stop();
  context.bus.clear();
  await rm(context.uploadsDir, { recursive: true, force: true }).catch(() => {});
});

/** Create an identified session, which is all a client ever has to do. */
function identify(name, fingerprint = name) {
  const { session } = context.domain.sessions.resolve({ fingerprint });
  context.domain.sessions.updateProfile(session.id, { displayName: name });
  return context.store.sessions.get(session.id);
}

describe('sessions', () => {
  test('a new client gets a UUID v4, dark mode and no name yet', () => {
    const { session, created, matchedBy } = context.domain.sessions.resolve({ fingerprint: 'fp' });
    assert.equal(created, true);
    assert.equal(matchedBy, 'new');
    assert.ok(isUuid4(session.id));
    assert.equal(session.displayName, null);
    assert.equal(session.colorHue, null, 'the colour arrives with the username');
    assert.equal(session.theme, 'dark', 'dark mode is the default');
  });

  test('a returning client gets the same session back', () => {
    const first = context.domain.sessions.resolve({ fingerprint: 'fp' });
    const byCookie = context.domain.sessions.resolve({ sessionId: first.session.id, fingerprint: 'other' });
    assert.equal(byCookie.session.id, first.session.id);
    assert.equal(byCookie.matchedBy, 'cookie');

    // No cookie, but the same client metadata: recognised anyway.
    const byMetadata = context.domain.sessions.resolve({ fingerprint: 'fp' });
    assert.equal(byMetadata.session.id, first.session.id);
    assert.equal(byMetadata.matchedBy, 'fingerprint');
  });

  test('an unknown cookie falls back to creating a session', () => {
    const result = context.domain.sessions.resolve({ sessionId: 'not-a-real-session', fingerprint: 'fresh' });
    assert.equal(result.created, true);
  });

  test('choosing a username assigns a random colour', () => {
    const { session } = context.domain.sessions.resolve({ fingerprint: 'fp' });
    const { changed } = context.domain.sessions.updateProfile(session.id, { displayName: 'Ana' });
    assert.deepEqual(changed.sort(), ['colorHue', 'displayName']);
    assert.equal(typeof session.colorHue, 'number');
    assert.ok(session.colorHue >= 0 && session.colorHue < 360);
  });

  test('changing the username later keeps the original colour and UUID', () => {
    const session = identify('Ana');
    const originalId = session.id;
    const originalHue = session.colorHue;
    context.domain.sessions.updateProfile(session.id, { displayName: 'Ana María' });
    assert.equal(session.id, originalId, 'the UUID is permanent');
    assert.equal(session.colorHue, originalHue);
    assert.equal(session.displayName, 'Ana María');
  });

  test('any username is allowed', () => {
    for (const name of ['🦊', 'ünïcödé', 'a'.repeat(120), 'Ana', '   spaced   out   ', '../../etc/passwd', '<script>']) {
      const { session } = context.domain.sessions.resolve({ fingerprint: `fp-${name}` });
      assert.doesNotThrow(() => context.domain.sessions.updateProfile(session.id, { displayName: name }));
    }
    // Duplicates are fine too: names are not identities, the UUID is.
    const a = identify('Same', 'fp-a');
    const b = identify('Same', 'fp-b');
    assert.equal(a.displayName, b.displayName);
    assert.notEqual(a.id, b.id);
  });

  test('only genuinely empty or over-long names are refused', () => {
    const { session } = context.domain.sessions.resolve({ fingerprint: 'fp' });
    assert.throws(() => context.domain.sessions.updateProfile(session.id, { displayName: '   ' }), /cannot be empty/);
    assert.throws(() => context.domain.sessions.updateProfile(session.id, { displayName: 42 }), /must be text/);
    assert.throws(
      () => context.domain.sessions.updateProfile(session.id, { displayName: 'x'.repeat(121) }),
      /cannot exceed/,
    );
  });

  test('colour and theme can be changed independently', () => {
    const session = identify('Ana');
    context.domain.sessions.updateProfile(session.id, { colorHue: 400 });
    assert.equal(session.colorHue, 40, 'hue wraps around the circle');
    context.domain.sessions.updateProfile(session.id, { theme: 'light' });
    assert.equal(session.theme, 'light');
    assert.throws(() => context.domain.sessions.updateProfile(session.id, { colorHue: 'blue' }), /hue/);
  });

  test('a no-op update publishes nothing', () => {
    const session = identify('Ana');
    context.events.length = 0;
    const { changed } = context.domain.sessions.updateProfile(session.id, { displayName: 'Ana' });
    assert.deepEqual(changed, []);
    assert.equal(context.events.length, 0);
  });

  test('the private view exposes preferences, the public one does not', () => {
    const session = identify('Ana');
    const priv = context.domain.sessions.toPrivateView(session);
    assert.equal(priv.identified, true);
    assert.equal(priv.theme, 'dark');
    assert.match(priv.colorHex, /^#[0-9a-f]{6}$/);

    const pub = context.domain.sessions.toPublicView(session);
    assert.deepEqual(Object.keys(pub).sort(), ['colorHue', 'displayName', 'id']);
  });
});

describe('rooms', () => {
  test('any identified user can create rooms, without limit', () => {
    const session = identify('Ana');
    for (let index = 0; index < 25; index += 1) {
      context.domain.rooms.create({ name: `Room ${index}`, session });
    }
    assert.equal(context.store.rooms.size, 25);
  });

  test('creating a room needs a username', () => {
    const { session } = context.domain.sessions.resolve({ fingerprint: 'fp' });
    assert.throws(() => context.domain.rooms.create({ name: 'Nope', session }), { code: 'identity_required' });
  });

  test('an empty room stays open and listed', () => {
    const session = identify('Ana');
    const room = context.domain.rooms.create({ name: 'Quiet', session });
    const [view] = context.domain.rooms.list();
    assert.equal(view.id, room.id);
    assert.equal(view.userCount, 0, 'nobody is connected');
    assert.equal(context.store.rooms.has(room.id), true, 'and yet the room is still there');
  });

  test('only the creator can delete a room', () => {
    const owner = identify('Ana', 'fp-a');
    const stranger = identify('Luis', 'fp-b');
    const room = context.domain.rooms.create({ name: 'Private', session: owner });

    assert.throws(() => context.domain.rooms.remove(room.id, stranger), { code: 'forbidden' });
    assert.equal(context.store.rooms.has(room.id), true);

    context.domain.rooms.remove(room.id, owner);
    assert.equal(context.store.rooms.has(room.id), false);
  });

  test('deleting a room discards its history and publishes the event', () => {
    const owner = identify('Ana');
    const room = context.domain.rooms.create({ name: 'Doomed', session: owner });
    context.domain.messages.create({ roomId: room.id, session: owner, body: 'hi' });

    context.events.length = 0;
    context.domain.rooms.remove(room.id, owner);

    assert.equal(context.store.messages.count(room.id), 0);
    assert.equal(context.events.filter((event) => event.name === EVENTS.ROOM_DELETED).length, 1);
  });

  test('an unknown or malformed room id is a clean 404', () => {
    assert.throws(() => context.domain.rooms.requireRoom('not-a-uuid'), { code: 'room_not_found' });
    assert.throws(() => context.domain.rooms.requireRoom(undefined), { code: 'room_not_found' });
  });

  test('room names are bounded but otherwise unrestricted', () => {
    const session = identify('Ana');
    assert.throws(() => context.domain.rooms.create({ name: '  ', session }), /cannot be empty/);
    assert.throws(() => context.domain.rooms.create({ name: 'x'.repeat(121), session }), /cannot exceed/);
    const room = context.domain.rooms.create({ name: '  🎧  Música  ', session });
    assert.equal(room.name, '🎧 Música', 'trimmed, whitespace collapsed, content untouched');
  });

  test('the room view carries the counters the Home screen renders', () => {
    const session = identify('Ana');
    const room = context.domain.rooms.create({ name: 'General', topic: 'Anything', session });
    context.domain.messages.create({ roomId: room.id, session, body: 'first' });

    const view = context.domain.rooms.toView(room);
    assert.equal(view.name, 'General');
    assert.equal(view.topic, 'Anything');
    assert.equal(view.messageCount, 1);
    assert.equal(view.createdBy.id, session.id);
    assert.equal(view.lastMessage.authorName, 'Ana');
    assert.equal(view.lastMessage.preview, 'first');
  });
});

describe('messages', () => {
  test('a message carries an author snapshot and lands in history', () => {
    const session = identify('Ana');
    const room = context.domain.rooms.create({ name: 'General', session });
    const message = context.domain.messages.create({ roomId: room.id, session, body: 'hola' });

    assert.equal(message.body, 'hola');
    assert.equal(message.author.id, session.id);
    assert.equal(message.author.displayName, 'Ana');
    assert.equal(message.author.colorHue, session.colorHue);
    assert.equal(message.type, 'user');
    assert.deepEqual(context.domain.messages.history(room.id), [message]);
  });

  test('a user who joins later can read everything sent before', () => {
    const first = identify('Ana', 'fp-a');
    const room = context.domain.rooms.create({ name: 'General', session: first });
    for (let index = 0; index < 5; index += 1) {
      context.domain.messages.create({ roomId: room.id, session: first, body: `message ${index}` });
    }

    const latecomer = identify('Luis', 'fp-b');
    const history = context.domain.messages.history(room.id);
    assert.equal(history.length, 5);
    assert.equal(history[0].body, 'message 0');
    assert.equal(latecomer.displayName, 'Luis');
  });

  test('there is no way to edit or delete a message', () => {
    // Enforced by absence: the service exposes no such function at all.
    assert.equal(context.domain.messages.update, undefined);
    assert.equal(context.domain.messages.remove, undefined);
    assert.equal(context.domain.messages.delete, undefined);
    assert.deepEqual(Object.keys(context.domain.messages).sort(), ['create', 'history', 'normalizeBody']);
  });

  test('an empty message is refused, but attachments alone are enough', async () => {
    const session = identify('Ana');
    const room = context.domain.rooms.create({ name: 'General', session });
    assert.throws(() => context.domain.messages.create({ roomId: room.id, session, body: '   ' }), /needs text/);

    const upload = await context.domain.uploads.saveStream({
      stream: Readable.from([Buffer.from('data')]),
      filename: 'note.txt',
      mime: 'text/plain',
      ownerId: session.id,
    });
    const message = context.domain.messages.create({
      roomId: room.id,
      session,
      attachmentIds: [upload.id],
    });
    assert.equal(message.body, '');
    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0].name, 'note.txt');
  });

  test('sending needs a username and a real room', () => {
    const anonymous = context.domain.sessions.resolve({ fingerprint: 'anon' }).session;
    const session = identify('Ana');
    const room = context.domain.rooms.create({ name: 'General', session });
    assert.throws(() => context.domain.messages.create({ roomId: room.id, session: anonymous, body: 'x' }), {
      code: 'identity_required',
    });
    assert.throws(() => context.domain.messages.create({ roomId: 'nope', session, body: 'x' }), {
      code: 'room_not_found',
    });
  });

  test('unknown attachments are refused', () => {
    const session = identify('Ana');
    const room = context.domain.rooms.create({ name: 'General', session });
    assert.throws(
      () => context.domain.messages.create({ roomId: room.id, session, attachmentIds: ['nope'] }),
      /Malformed attachment id/,
    );
    assert.throws(
      () =>
        context.domain.messages.create({
          roomId: room.id,
          session,
          attachmentIds: ['11111111-1111-4111-8111-111111111111'],
        }),
      { code: 'upload_not_found' },
    );
  });

  test('message bodies keep newlines but lose control characters', () => {
    const normalize = context.domain.messages.normalizeBody;
    assert.equal(normalize('line 1\nline 2'), 'line 1\nline 2');
    assert.equal(normalize('bell\u0007here'), 'bellhere');
    assert.equal(normalize('  padded  '), 'padded');
    assert.throws(() => normalize('x'.repeat(4001)), /cannot exceed/);
  });
});

describe('typing', () => {
  test('setting and clearing publishes the current list', () => {
    const ana = identify('Ana', 'fp-a');
    const luis = identify('Luis', 'fp-b');

    context.domain.typing.set({ roomId: 'r', sessionId: ana.id, typing: true });
    context.domain.typing.set({ roomId: 'r', sessionId: luis.id, typing: true });
    assert.deepEqual(
      context.domain.typing.list('r').map((user) => user.displayName).sort(),
      ['Ana', 'Luis'],
    );

    context.domain.typing.set({ roomId: 'r', sessionId: ana.id, typing: false });
    assert.deepEqual(context.domain.typing.sessionIds('r'), [luis.id]);
  });

  test('refreshing an active flag does not re-announce it', () => {
    const ana = identify('Ana');
    context.domain.typing.set({ roomId: 'r', sessionId: ana.id, typing: true });
    context.events.length = 0;
    context.domain.typing.set({ roomId: 'r', sessionId: ana.id, typing: true });
    assert.equal(context.events.filter((event) => event.name === EVENTS.TYPING_CHANGED).length, 0);
  });

  test('a flag expires on its own so a closed tab leaves no ghost', async () => {
    const uploadsDir = context.uploadsDir;
    const config = createConfig([], { uploadsDir, logLevel: 'silent' });
    // Rebuild the domain with a very short expiry instead of waiting 6 seconds.
    const fast = createDomain({
      store: context.store,
      bus: context.bus,
      config: { ...config, chat: { ...config.chat, typingTimeoutMs: 40 } },
    });
    const ana = identify('Ana');
    fast.typing.set({ roomId: 'r', sessionId: ana.id, typing: true });
    assert.equal(fast.typing.sessionIds('r').length, 1);
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(fast.typing.sessionIds('r').length, 0);
    fast.stop();
  });

  test('clearing a room or a session releases every flag', () => {
    const ana = identify('Ana', 'fp-a');
    context.domain.typing.set({ roomId: 'r1', sessionId: ana.id, typing: true });
    context.domain.typing.set({ roomId: 'r2', sessionId: ana.id, typing: true });
    context.domain.typing.clearSessionEverywhere(ana.id);
    assert.deepEqual(context.domain.typing.sessionIds('r1'), []);
    assert.deepEqual(context.domain.typing.sessionIds('r2'), []);

    context.domain.typing.set({ roomId: 'r3', sessionId: ana.id, typing: true });
    context.domain.typing.clearRoom('r3');
    assert.deepEqual(context.domain.typing.sessionIds('r3'), []);
  });
});

describe('uploads', () => {
  test('stores bytes on disk under a UUID name and classifies the kind', async () => {
    const session = identify('Ana');
    const upload = await context.domain.uploads.saveStream({
      stream: Readable.from([Buffer.from('hello '), Buffer.from('world')]),
      filename: 'photo.png',
      mime: 'image/png',
      ownerId: session.id,
    });

    assert.equal(upload.size, 11);
    assert.equal(upload.kind, 'image');
    assert.equal(upload.name, 'photo.png');
    assert.match(upload.storedName, /^[0-9a-f-]{36}\.png$/);
    assert.equal(upload.url, `/uploads/${upload.storedName}`);

    const info = await stat(join(context.uploadsDir, upload.storedName));
    assert.equal(info.size, 11);
  });

  test('the original filename never reaches the filesystem', async () => {
    const session = identify('Ana');
    const upload = await context.domain.uploads.saveStream({
      stream: Readable.from([Buffer.from('x')]),
      filename: '../../etc/passwd',
      mime: 'application/octet-stream',
      ownerId: session.id,
    });
    assert.equal(upload.name, 'passwd', 'shown to users, path stripped');
    assert.match(upload.storedName, /^[0-9a-f-]{36}$/, 'on disk it is only a UUID');
    const entries = await readdir(context.uploadsDir);
    assert.deepEqual(entries, [upload.storedName]);
  });

  test('an oversized upload is rejected and leaves no partial file behind', async () => {
    const session = identify('Ana');
    await assert.rejects(
      () =>
        context.domain.uploads.saveStream({
          stream: Readable.from([Buffer.alloc(200)]),
          filename: 'big.bin',
          ownerId: session.id,
          maxBytes: 50,
        }),
      { code: 'payload_too_large' },
    );
    assert.deepEqual(await readdir(context.uploadsDir), [], 'the temp file was cleaned up');
  });

  test('an empty upload is rejected', async () => {
    await assert.rejects(
      () =>
        context.domain.uploads.saveStream({
          stream: Readable.from([]),
          filename: 'empty.txt',
          ownerId: 'x',
        }),
      /empty/,
    );
  });

  test('stored paths cannot escape the uploads directory', () => {
    const resolve = context.domain.uploads.resolveStoredPath;
    assert.equal(resolve('../../etc/passwd'), join(context.uploadsDir, 'passwd'), 'flattened, never escaped');
    assert.equal(resolve('.hidden.part'), null, 'in-flight temp files are not servable');
    assert.equal(resolve(''), null);
    assert.equal(resolve('..'), null);
    assert.ok(resolve('abc.png').startsWith(context.uploadsDir));
  });

  test('the extension falls back to the declared MIME type', async () => {
    const upload = await context.domain.uploads.saveStream({
      stream: Readable.from([Buffer.from('x')]),
      filename: 'noextension',
      mime: 'image/webp',
      ownerId: 'x',
    });
    assert.match(upload.storedName, /\.webp$/);
    assert.equal(upload.kind, 'image');
  });
});
