/**
 * WebSocket chat behaviour.
 *
 * Real sockets against a real server. This is where the live parts of the
 * specification are asserted: message broadcast, history on join, the typing
 * indicator, live user counts, and who is allowed to delete a room.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, sleep } from './helpers/server.js';

describe('realtime', () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;
  /** Sockets opened by the current test, closed automatically afterwards. */
  let open = [];

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    for (const socket of open) await socket.close();
    open = [];
  });

  /** Identify a fresh client and connect it. */
  async function connect(name, userAgent = `UA-${name}-${Math.random()}`) {
    const client = server.client(userAgent);
    const session = await client.identify(name);
    const socket = await client.connect().ready();
    await socket.waitFor('session:state');
    open.push(socket);
    return { client, session, socket };
  }

  test('a socket is greeted with its session and the room list', async () => {
    const { session, socket } = await connect('Ana');
    const greeting = await socket.waitFor('session:state');
    assert.equal(greeting.payload.session.id, session.id);
    assert.equal(greeting.payload.session.displayName, 'Ana');
    assert.equal(greeting.payload.session.identified, true);

    const rooms = await socket.waitFor('rooms:state');
    assert.ok(Array.isArray(rooms.payload.rooms));
  });

  test('a room created by anyone appears for everyone immediately', async () => {
    const ana = await connect('Ana');
    const luis = await connect('Luis');
    luis.socket.reset();

    const created = await ana.socket.request('room:create', { name: 'General', topic: 'Anything' });
    assert.equal(created.room.name, 'General');

    const broadcast = await luis.socket.waitFor('room:created');
    assert.equal(broadcast.payload.room.id, created.room.id);
    assert.equal(broadcast.payload.room.topic, 'Anything');
  });

  test('joining returns the room, its history and its members', async () => {
    const ana = await connect('Ana');
    const room = (await ana.socket.request('room:create', { name: 'History' })).room;
    await ana.socket.request('room:join', { roomId: room.id });
    await ana.socket.request('message:send', { roomId: room.id, body: 'sent before you arrived' });

    const luis = await connect('Luis');
    const joined = await luis.socket.request('room:join', { roomId: room.id });

    assert.equal(joined.room.id, room.id);
    assert.equal(joined.messages.length, 1, 'earlier messages are visible to a newcomer');
    assert.equal(joined.messages[0].body, 'sent before you arrived');
    assert.deepEqual(joined.members.map((member) => member.displayName).sort(), ['Ana', 'Luis']);
    assert.deepEqual(joined.typing, []);
  });

  test('a message reaches everyone in the room, sender included', async () => {
    const ana = await connect('Ana');
    const luis = await connect('Luis');
    const room = (await ana.socket.request('room:create', { name: 'Chat' })).room;
    await ana.socket.request('room:join', { roomId: room.id });
    await luis.socket.request('room:join', { roomId: room.id });

    ana.socket.reset();
    luis.socket.reset();
    await ana.socket.request('message:send', { roomId: room.id, body: 'hola' });

    for (const [label, socket] of [['sender', ana.socket], ['receiver', luis.socket]]) {
      const frame = await socket.waitFor('message:new');
      assert.equal(frame.payload.message.body, 'hola', `${label} receives the canonical record`);
      assert.equal(frame.payload.message.author.displayName, 'Ana');
      assert.equal(frame.payload.roomId, room.id);
    }
  });

  test('a message is not delivered to other rooms', async () => {
    const ana = await connect('Ana');
    const luis = await connect('Luis');
    const one = (await ana.socket.request('room:create', { name: 'One' })).room;
    const two = (await ana.socket.request('room:create', { name: 'Two' })).room;
    await ana.socket.request('room:join', { roomId: one.id });
    await luis.socket.request('room:join', { roomId: two.id });

    luis.socket.reset();
    await ana.socket.request('message:send', { roomId: one.id, body: 'only for room one' });
    await sleep(120);
    assert.equal(luis.socket.frames.some((frame) => frame.type === 'message:new'), false);
  });

  test('sending to a room you have not joined is refused', async () => {
    const ana = await connect('Ana');
    const room = (await ana.socket.request('room:create', { name: 'Closed' })).room;
    await assert.rejects(() => ana.socket.request('message:send', { roomId: room.id, body: 'x' }), (error) => {
      assert.equal(error.code, 'forbidden');
      return true;
    });
  });

  test('the typing indicator appears and clears', async () => {
    const ana = await connect('Ana');
    const luis = await connect('Luis');
    const room = (await ana.socket.request('room:create', { name: 'Typing' })).room;
    await ana.socket.request('room:join', { roomId: room.id });
    await luis.socket.request('room:join', { roomId: room.id });

    ana.socket.reset();
    luis.socket.send('typing:set', { roomId: room.id, typing: true });
    const started = await ana.socket.waitFor('typing:state');
    assert.deepEqual(started.payload.users.map((user) => user.displayName), ['Luis']);

    ana.socket.reset();
    luis.socket.send('typing:set', { roomId: room.id, typing: false });
    const stopped = await ana.socket.waitFor('typing:state');
    assert.deepEqual(stopped.payload.users, []);
  });

  test('sending a message clears the sender typing flag', async () => {
    const ana = await connect('Ana');
    const luis = await connect('Luis');
    const room = (await ana.socket.request('room:create', { name: 'TypingSend' })).room;
    await ana.socket.request('room:join', { roomId: room.id });
    await luis.socket.request('room:join', { roomId: room.id });

    luis.socket.send('typing:set', { roomId: room.id, typing: true });
    await ana.socket.waitFor('typing:state');

    ana.socket.reset();
    await luis.socket.request('message:send', { roomId: room.id, body: 'done typing' });
    const cleared = await ana.socket.waitFor(
      (frame) => frame.type === 'typing:state' && frame.payload.users.length === 0,
    );
    assert.deepEqual(cleared.payload.users, []);
  });

  test('user counts follow joins, leaves and disconnects', async () => {
    const ana = await connect('Ana');
    const room = (await ana.socket.request('room:create', { name: 'Counting' })).room;
    const countOf = async () => (await ana.client.json(`/api/rooms/${room.id}`)).room.userCount;

    assert.equal(await countOf(), 0, 'a new room starts empty and stays listed');

    await ana.socket.request('room:join', { roomId: room.id });
    assert.equal(await countOf(), 1);

    const luis = await connect('Luis');
    await luis.socket.request('room:join', { roomId: room.id });
    assert.equal(await countOf(), 2);

    await luis.socket.request('room:leave', { roomId: room.id });
    assert.equal(await countOf(), 1);

    await ana.socket.close();
    await sleep(120);
    assert.equal(await countOf(), 0, 'the room survives with nobody in it');
    assert.equal((await luis.client.json(`/api/rooms/${room.id}`)).room.name, 'Counting');
  });

  test('two tabs of one user count as one person', async () => {
    const ana = await connect('Ana');
    const room = (await ana.socket.request('room:create', { name: 'Tabs' })).room;
    await ana.socket.request('room:join', { roomId: room.id });

    // A second socket for the SAME session, as a second browser tab would be.
    const secondTab = await ana.client.connect().ready();
    open.push(secondTab);
    await secondTab.waitFor('session:state');
    await secondTab.request('room:join', { roomId: room.id });

    assert.equal((await ana.client.json(`/api/rooms/${room.id}`)).room.userCount, 1);

    await secondTab.close();
    await sleep(120);
    assert.equal((await ana.client.json(`/api/rooms/${room.id}`)).room.userCount, 1, 'still present in the other tab');
  });

  test('presence updates are pushed to the room', async () => {
    const ana = await connect('Ana');
    const room = (await ana.socket.request('room:create', { name: 'Presence' })).room;
    await ana.socket.request('room:join', { roomId: room.id });

    ana.socket.reset();
    const luis = await connect('Luis');
    await luis.socket.request('room:join', { roomId: room.id });

    const presence = await ana.socket.waitFor('presence:state');
    assert.equal(presence.payload.userCount, 2);
    assert.deepEqual(presence.payload.members.map((member) => member.displayName).sort(), ['Ana', 'Luis']);
  });

  test('only the creator can delete a room, and everyone is told', async () => {
    const ana = await connect('Ana');
    const luis = await connect('Luis');
    const room = (await ana.socket.request('room:create', { name: 'Owned' })).room;
    await luis.socket.request('room:join', { roomId: room.id });

    await assert.rejects(() => luis.socket.request('room:delete', { roomId: room.id }), (error) => {
      assert.equal(error.code, 'forbidden');
      return true;
    });

    luis.socket.reset();
    await ana.socket.request('room:delete', { roomId: room.id });

    const deleted = await luis.socket.waitFor('room:deleted');
    assert.equal(deleted.payload.roomId, room.id);
    assert.equal(deleted.payload.name, 'Owned');
    assert.equal((await ana.client.fetch(`/api/rooms/${room.id}`)).status, 404);
  });

  test('renaming a user syncs their tabs and tells everyone else', async () => {
    const ana = await connect('Ana');
    const luis = await connect('Luis');
    const room = (await ana.socket.request('room:create', { name: 'Rename' })).room;
    await ana.socket.request('room:join', { roomId: room.id });
    await luis.socket.request('room:join', { roomId: room.id });

    const secondTab = await ana.client.connect().ready();
    open.push(secondTab);
    await secondTab.waitFor('session:state');

    secondTab.reset();
    luis.socket.reset();
    await ana.socket.request('profile:update', { displayName: 'Ana María' });

    const ownTab = await secondTab.waitFor('session:state');
    assert.equal(ownTab.payload.session.displayName, 'Ana María');

    const others = await luis.socket.waitFor('user:updated');
    assert.equal(others.payload.user.id, ana.session.id);
    assert.equal(others.payload.user.displayName, 'Ana María');

    // New messages carry the new name; old ones keep their snapshot.
    const message = await ana.socket.request('message:send', { roomId: room.id, body: 'renamed' });
    assert.ok(message.messageId);
    const history = (await ana.client.json(`/api/rooms/${room.id}/messages`)).messages;
    assert.equal(history[0].author.displayName, 'Ana María');
  });

  test('a client without a username cannot join or create', async () => {
    const anonymous = server.client('UA-anonymous');
    await anonymous.fetch('/');
    const socket = await anonymous.connect().ready();
    open.push(socket);
    await socket.waitFor('session:state');

    await assert.rejects(() => socket.request('room:create', { name: 'Nope' }), (error) => {
      assert.equal(error.code, 'identity_required');
      return true;
    });

    const ana = await connect('Ana');
    const room = (await ana.socket.request('room:create', { name: 'Members only' })).room;
    await assert.rejects(() => socket.request('room:join', { roomId: room.id }), (error) => {
      assert.equal(error.code, 'identity_required');
      return true;
    });
  });

  test('picking a username over the socket is the single setup step', async () => {
    const newcomer = server.client('UA-newcomer');
    await newcomer.fetch('/');
    const socket = await newcomer.connect().ready();
    open.push(socket);

    const before = await socket.waitFor('session:state');
    assert.equal(before.payload.session.identified, false);
    assert.equal(before.payload.session.colorHue, null);

    const after = await socket.request('profile:update', { displayName: 'Recién llegada' });
    assert.equal(after.session.identified, true);
    assert.equal(typeof after.session.colorHue, 'number', 'a colour is assigned with the name');

    // And that is enough to use the chat.
    const room = (await socket.request('room:create', { name: 'Works' })).room;
    await socket.request('room:join', { roomId: room.id });
    await socket.request('message:send', { roomId: room.id, body: 'ready' });
  });

  test('a message with attachments carries their metadata to everyone', async () => {
    const ana = await connect('Ana');
    const luis = await connect('Luis');
    const room = (await ana.socket.request('room:create', { name: 'Files' })).room;
    await ana.socket.request('room:join', { roomId: room.id });
    await luis.socket.request('room:join', { roomId: room.id });

    const uploaded = (
      await ana.client.json('/api/uploads', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'x-pellets-filename': 'nota.txt' },
        body: 'contenido',
      })
    ).uploads[0];

    luis.socket.reset();
    await ana.socket.request('message:send', { roomId: room.id, body: '', attachmentIds: [uploaded.id] });

    const frame = await luis.socket.waitFor('message:new');
    const [attachment] = frame.payload.message.attachments;
    assert.equal(attachment.name, 'nota.txt');
    assert.equal(attachment.kind, 'file');
    assert.equal(attachment.url, uploaded.url);
    assert.equal(await (await luis.client.fetch(attachment.url)).text(), 'contenido');
  });

  test('malformed frames get a structured error, not a dropped connection', async () => {
    const ana = await connect('Ana');

    ana.socket.socket.send('this is not json');
    const notJson = await ana.socket.waitFor('error');
    assert.equal(notJson.payload.code, 'bad_request');

    await assert.rejects(() => ana.socket.request('nonsense:frame', {}), (error) => {
      assert.match(error.message, /Unknown frame type/);
      return true;
    });

    // The socket is still usable afterwards.
    const pong = await ana.socket.request('ping', {});
    assert.equal(typeof pong.at, 'number');
  });

  test('binary frames are rejected with an explanation', async () => {
    const ana = await connect('Ana');
    ana.socket.reset();
    ana.socket.socket.send(Buffer.from([1, 2, 3]));
    const error = await ana.socket.waitFor('error');
    assert.match(error.payload.message, /upload files over HTTP/);
  });

  test('a websocket upgrade on the wrong path is refused', async () => {
    const response = await fetch(`${server.base}/not-the-ws-path`, {
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    }).catch((error) => ({ status: 0, error }));
    assert.notEqual(response.status, 101);
  });

  test('room statistics are broadcast as activity happens', async () => {
    const ana = await connect('Ana');
    const observer = await connect('Observer');
    const room = (await ana.socket.request('room:create', { name: 'Stats' })).room;
    await ana.socket.request('room:join', { roomId: room.id });

    observer.socket.reset();
    await ana.socket.request('message:send', { roomId: room.id, body: 'activity' });

    const stats = await observer.socket.waitFor(
      (frame) => frame.type === 'room:stats' && frame.payload.room.id === room.id && frame.payload.room.messageCount === 1,
    );
    assert.equal(stats.payload.room.lastMessage.preview, 'activity');
    assert.equal(stats.payload.room.lastMessage.authorName, 'Ana');
  });
});
