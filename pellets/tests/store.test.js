/**
 * In-memory stores.
 *
 * Everything here is deliberately volatile: these tests document that the
 * stores keep chat state only for the lifetime of the process, and that the
 * presence bookkeeping counts USERS rather than sockets.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, SetMap } from '../src/store/collection.js';
import { createStore } from '../src/store/index.js';

describe('Collection', () => {
  test('stores, reads and deletes records', () => {
    const collection = new Collection({ name: 'test' });
    collection.set('a', { id: 'a', value: 1 });
    assert.equal(collection.get('a').value, 1);
    assert.equal(collection.has('a'), true);
    assert.equal(collection.size, 1);
    assert.equal(collection.delete('a'), true);
    assert.equal(collection.delete('a'), false);
    assert.equal(collection.size, 0);
  });

  test('update mutates in place so existing references stay valid', () => {
    // Long-lived holders (an open socket, a queued broadcast) must never see a
    // stale copy, which is why update() does not replace the object.
    const collection = new Collection({ name: 'test' });
    const record = { id: 'a', value: 1 };
    collection.set('a', record);
    const updated = collection.update('a', { value: 2 });
    assert.equal(updated, record, 'same object identity');
    assert.equal(record.value, 2);
    assert.equal(collection.update('missing', { value: 3 }), null);
  });

  test('secondary indexes follow updates and deletions', () => {
    const collection = new Collection({
      name: 'sessions',
      indexes: { fingerprint: (record) => record.fingerprint || null },
    });
    collection.set('a', { id: 'a', fingerprint: 'f1' });
    assert.equal(collection.findBy('fingerprint', 'f1').id, 'a');

    collection.update('a', { fingerprint: 'f2' });
    assert.equal(collection.findBy('fingerprint', 'f1'), undefined, 'the old key is released');
    assert.equal(collection.findBy('fingerprint', 'f2').id, 'a');

    collection.delete('a');
    assert.equal(collection.findBy('fingerprint', 'f2'), undefined);
  });

  test('a null index key simply skips the record', () => {
    const collection = new Collection({ name: 't', indexes: { k: (record) => record.k || null } });
    collection.set('a', { id: 'a' });
    assert.equal(collection.findBy('k', null), undefined);
    assert.equal(collection.size, 1);
  });
});

describe('SetMap', () => {
  test('tracks membership and drops empty keys', () => {
    const map = new SetMap();
    map.add('room', 'c1');
    map.add('room', 'c2');
    assert.equal(map.count('room'), 2);
    assert.equal(map.has('room', 'c1'), true);
    assert.equal(map.remove('room', 'c1'), false, 'still has members');
    assert.equal(map.remove('room', 'c2'), true, 'key removed when it empties');
    assert.equal(map.count('room'), 0);
    assert.deepEqual(map.keys(), []);
  });
});

describe('presence store', () => {
  /** Build a store with two sessions and their sockets already registered. */
  function setup() {
    const store = createStore();
    store.presence.addConnection('c1', 'alice');
    store.presence.addConnection('c2', 'bob');
    return store;
  }

  test('counts distinct users, not sockets', () => {
    const store = setup();
    // Alice opens a second tab.
    store.presence.addConnection('c3', 'alice');

    store.presence.join('room', 'c1');
    store.presence.join('room', 'c3');
    assert.equal(store.presence.countInRoom('room'), 1, 'two tabs are still one person');

    store.presence.join('room', 'c2');
    assert.equal(store.presence.countInRoom('room'), 2);
    assert.deepEqual(store.presence.sessionsInRoom('room'), ['alice', 'bob']);
    assert.equal(store.presence.connectionsInRoom('room').length, 3);
  });

  test('reports when a user genuinely enters or leaves', () => {
    const store = setup();
    store.presence.addConnection('c3', 'alice');

    assert.equal(store.presence.join('room', 'c1').sessionJoined, true);
    assert.equal(store.presence.join('room', 'c3').sessionJoined, false, 'second tab is not a new user');

    assert.equal(store.presence.leave('room', 'c1').sessionLeft, false, 'a tab remains');
    assert.equal(store.presence.leave('room', 'c3').sessionLeft, true, 'the last tab left');
    assert.equal(store.presence.countInRoom('room'), 0);
  });

  test('closing a socket removes it from every room it was in', () => {
    const store = setup();
    store.presence.join('r1', 'c1');
    store.presence.join('r2', 'c1');

    const result = store.presence.removeConnection('c1');
    assert.equal(result.sessionId, 'alice');
    assert.deepEqual(result.rooms.sort(), ['r1', 'r2']);
    assert.deepEqual(result.sessionLeftRooms.sort(), ['r1', 'r2']);
    assert.equal(store.presence.countInRoom('r1'), 0);
    assert.equal(store.presence.connectionCount, 1);
  });

  test('roomsOfSession unions every tab', () => {
    const store = setup();
    store.presence.addConnection('c3', 'alice');
    store.presence.join('r1', 'c1');
    store.presence.join('r2', 'c3');
    assert.deepEqual(store.presence.roomsOfSession('alice').sort(), ['r1', 'r2']);
  });

  test('dropRoom detaches everyone, as happens when a room is deleted', () => {
    const store = setup();
    store.presence.join('room', 'c1');
    store.presence.join('room', 'c2');
    const affected = store.presence.dropRoom('room');
    assert.deepEqual(affected.sort(), ['c1', 'c2']);
    assert.equal(store.presence.countInRoom('room'), 0);
    assert.deepEqual(store.presence.roomsOfConnection('c1'), []);
  });

  test('operations on an unknown connection are harmless', () => {
    const store = createStore();
    assert.deepEqual(store.presence.removeConnection('ghost'), { sessionId: null, rooms: [], sessionLeftRooms: [] });
    assert.equal(store.presence.join('room', 'ghost').ok, false);
    assert.equal(store.presence.leave('room', 'ghost').ok, false);
  });
});

describe('message store', () => {
  test('keeps full history in order by default', () => {
    const store = createStore();
    for (let index = 0; index < 250; index += 1) {
      store.messages.append('room', { id: `m${index}`, createdAt: index });
    }
    const history = store.messages.history('room');
    assert.equal(history.length, 250, 'unlimited by default: every earlier message stays readable');
    assert.equal(history[0].id, 'm0');
    assert.equal(store.messages.last('room').id, 'm249');
    assert.equal(store.messages.count('room'), 250);
    assert.equal(store.messages.total(), 250);
  });

  test('honours an explicit cap by dropping the oldest entries', () => {
    const store = createStore();
    for (let index = 0; index < 20; index += 1) store.messages.append('room', { id: `m${index}` }, 5);
    const history = store.messages.history('room');
    assert.equal(history.length, 5);
    assert.equal(history[0].id, 'm15');
  });

  test('limit returns the newest slice without mutating storage', () => {
    const store = createStore();
    for (let index = 0; index < 10; index += 1) store.messages.append('room', { id: `m${index}` });
    assert.deepEqual(
      store.messages.history('room', { limit: 3 }).map((message) => message.id),
      ['m7', 'm8', 'm9'],
    );
    assert.equal(store.messages.count('room'), 10);
  });

  test('history is a copy, so callers cannot corrupt the store', () => {
    const store = createStore();
    store.messages.append('room', { id: 'm0' });
    store.messages.history('room').push({ id: 'injected' });
    assert.equal(store.messages.count('room'), 1);
  });

  test('deleting a room discards its history', () => {
    const store = createStore();
    store.messages.append('room', { id: 'm0' });
    store.messages.dropRoom('room');
    assert.deepEqual(store.messages.history('room'), []);
    assert.equal(store.messages.last('room'), null);
  });
});

describe('store composition', () => {
  test('clear wipes every store, the way restarting the process does', () => {
    const store = createStore();
    store.sessions.insert({ id: 's', fingerprint: 'f' });
    store.rooms.insert({ id: 'r', createdAt: 1 });
    store.messages.append('r', { id: 'm' });
    store.uploads.insert({ id: 'u', storedName: 'u.png' });
    store.presence.addConnection('c', 's');

    store.clear();

    assert.equal(store.sessions.size, 0);
    assert.equal(store.rooms.size, 0);
    assert.equal(store.messages.total(), 0);
    assert.equal(store.uploads.size, 0);
    assert.equal(store.presence.connectionCount, 0);
  });

  test('rooms are listed newest first', () => {
    const store = createStore();
    store.rooms.insert({ id: 'old', createdAt: 100 });
    store.rooms.insert({ id: 'new', createdAt: 300 });
    store.rooms.insert({ id: 'mid', createdAt: 200 });
    assert.deepEqual(
      store.rooms.all().map((room) => room.id),
      ['new', 'mid', 'old'],
    );
  });
});
