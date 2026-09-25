/**
 * Hosting: sharing one directory with at most one connected peer.
 *
 * Responsibilities:
 *  - start/stop hosting, with a name, a PIN and a content selection;
 *  - watch the directory and announce every change to the connected peer;
 *  - answer the peer API (connect, manifest, files, operations, heartbeat)
 *    while enforcing the rules: one peer at a time, the PIN, unchecked items
 *    never leave the host and are never modified by the peer;
 *  - end the session when the PIN changes or hosting stops.
 *
 * The HTTP layer (`src/http/routes/peer.routes.js`) only translates requests
 * into calls on this service; every rule lives here.
 *
 * Locking: the watcher's batches and every change applied on the peer's behalf
 * run under one mutex. A change is written to the index BEFORE it reaches the
 * disk, so the watcher events it causes find nothing new and are not echoed
 * back to the peer.
 */
import { basename } from 'node:path';
import { EVENTS } from '../lib/events.js';
import { newToken, newUuid, safeEqual } from '../lib/ids.js';
import { Mutex } from '../lib/queue.js';
import { isStrictlyInside, normalizeWirePath, parentOf, resolveWirePath } from '../lib/wirePath.js';
import { identityKey, isTempPath, publicState, readState, sameState } from '../fs/entry.js';
import { FileIndex, commitOp } from '../fs/fileIndex.js';
import { hashFile } from '../fs/hash.js';
import {
  ensureDirectory,
  moveEntry,
  moveTreeSelective,
  removeFile,
  removeStaleTempFiles,
  removeTree,
  resolveSafely,
  stageFile,
} from '../fs/mutate.js';
import { checkHostDirectory, pathsOverlap } from '../fs/pathCheck.js';
import { walkTree } from '../fs/walk.js';
import { createDirectoryWatcher } from '../fs/watcher.js';
import { createActivityLog } from './activity.js';
import { AppError, errors } from './errors.js';
import { assertPin, generatePin, pinMatches } from './pin.js';
import { BYE, PROTOCOL_VERSION, STREAM, TIMING } from './protocol.js';
import { Selection } from './selection.js';

const MAX_NAME_LENGTH = 80;

/** The wire form of an operation: no inodes, no local-only fields. */
export function wireOp(op) {
  switch (op.op) {
    case 'rename':
      return { op: 'rename', from: op.from, to: op.to, kind: op.kind };
    case 'write':
      return { op: 'write', path: op.path, size: op.state.size, mtimeMs: op.state.mtimeMs };
    default:
      return { op: op.op, path: op.path };
  }
}

/** Translate a filesystem error from `src/fs/mutate.js` into an AppError. */
function fsToAppError(error) {
  if (error instanceof AppError) return error;
  switch (error?.code) {
    case 'conflict':
    case 'EEXIST':
    case 'ENOTEMPTY':
    case 'EISDIR':
    case 'ENOTDIR':
      return errors.conflict(error.message, 'conflict');
    case 'not_found':
    case 'ENOENT':
      return errors.conflict(error.message, 'conflict');
    case 'unsafe_path':
    case 'EPATHESCAPE':
      return errors.forbidden(error.message, 'unsafe_path');
    case 'size_mismatch':
      return errors.badRequest(error.message, 'size_mismatch');
    case 'EACCES':
    case 'EPERM':
      return errors.forbidden('The host does not have permission to change this path.', 'permission');
    case 'ENOSPC':
      return errors.unavailable('The host has no space left on its disk.', 'no_space');
    default:
      return errors.internal(error?.message || 'Filesystem error.', error);
  }
}

/**
 * @param {object} deps
 * @param {import('../lib/events.js').EventBus} deps.bus
 * @param {object} deps.identity
 * @param {object} deps.config
 * @param {object} [deps.logger]
 */
export function createHostingService({ bus, identity, config, logger }) {
  const activity = createActivityLog({ bus, source: 'hosting' });
  const watcherTiming = config.watcher || {};
  const timing = { ...TIMING, ...(config.timing || {}) };
  /** @type {null|object} */
  let share = null;
  /** Last notable event, shown in the interface until hosting starts again. */
  let notice = null;

  const changed = () => bus.emit(EVENTS.STATE_CHANGED, { section: 'hosting' });

  function requireShare() {
    if (!share) throw errors.conflict('This instance is not hosting a directory.', 'not_hosting');
    return share;
  }

  // --- Stats --------------------------------------------------------------

  function computeStats(current) {
    const now = Date.now();
    if (current.stats && !current.statsDirty && now - current.statsAt < 60_000) return current.stats;
    if (current.stats && now - current.statsAt < 500) return current.stats;
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    for (const [path, state] of current.index.entries) {
      if (current.selection.isExcluded(path)) continue;
      if (state.kind === 'file') {
        files += 1;
        bytes += state.size;
      } else dirs += 1;
    }
    current.stats = { files, dirs, bytes, excluded: current.selection.size };
    current.statsAt = now;
    current.statsDirty = false;
    return current.stats;
  }

  // --- Sessions -----------------------------------------------------------

  function publicSession(session) {
    if (!session) return null;
    return {
      peer: { uuid: session.peer.uuid, hostname: session.peer.hostname, address: session.peer.address },
      since: session.since,
      lastSeen: session.lastSeen,
      phase: session.phase,
      streaming: Boolean(session.sink),
      progress: session.progress,
    };
  }

  /**
   * End the current session, telling the peer why when the stream is open.
   * @param {object} current The share the session belongs to.
   * @param {string} reason One of BYE.
   * @param {string} message Shown on the peer.
   */
  function endSession(current, reason, message) {
    const session = current.session;
    if (!session) return;
    current.session = null;
    clearInterval(session.timer);
    if (session.sink) {
      try {
        session.sink.send({ type: STREAM.BYE, reason, message });
      } catch {
        /* the stream may already be gone */
      }
      session.sink.close();
      session.sink = null;
    }
    const labels = {
      [BYE.PIN_CHANGED]: 'was disconnected because the PIN changed',
      [BYE.HOST_STOPPED]: 'was disconnected because hosting stopped',
      [BYE.REPLACED]: 'reconnected',
      [BYE.TIMEOUT]: 'stopped responding and was disconnected',
      left: 'disconnected',
    };
    activity.add({ kind: reason === 'left' || reason === BYE.REPLACED ? 'info' : 'warning', message: `${session.peer.hostname} ${labels[reason] || 'disconnected'}.` });
    bus.emit(EVENTS.HOSTING_PEER_DISCONNECTED, { reason, peer: publicSession(session).peer });
    changed();
  }

  function authorize(token) {
    const current = requireShare();
    const session = current.session;
    if (!session || typeof token !== 'string' || !safeEqual(token, session.token)) throw errors.unauthorized();
    session.lastSeen = Date.now();
    return { current, session };
  }

  // --- Paths --------------------------------------------------------------

  /** Validate a wire path from the peer and make sure it is shared. */
  function sharedPath(current, raw, { allowRoot = false } = {}) {
    const path = normalizeWirePath(raw, { allowRoot });
    if (path === null) throw errors.badRequest(`Invalid path: ${String(raw)}`, 'bad_path');
    if (isTempPath(path)) throw errors.badRequest('Temporary transfer files cannot be synchronised.', 'bad_path');
    if (current.selection.isExcluded(path)) {
      throw errors.forbidden(`"${path}" is not shared by the host.`, 'not_shared');
    }
    return path;
  }

  // --- Local changes -> peer ---------------------------------------------

  /** Runs under the mutex, called by the watcher with each batch. */
  function handleLocalOps(current, ops) {
    if (share !== current) return;
    const outgoing = [];
    for (const op of ops) {
      if (op.op === 'reindex') {
        commitOp(current.index, op);
        continue;
      }
      if (op.op === 'rename') {
        const fromExcluded = current.selection.isExcluded(op.from);
        const toExcluded = current.selection.isExcluded(op.to);
        if (current.selection.applyRename(op.from, op.to)) logger?.debug?.(`selection follows rename ${op.from} -> ${op.to}`);
        commitOp(current.index, op);
        if (fromExcluded) continue; // an unchecked item moved; nothing leaves the host
        if (toExcluded) {
          outgoing.push({ op: op.kind === 'dir' ? 'rmdir' : 'unlink', path: op.from });
          continue;
        }
        outgoing.push(wireOp(op));
        continue;
      }
      if ((op.op === 'write' || op.op === 'mkdir') && current.selection.followIdentity(op.path, identityKey(op.state))) {
        // An unchecked item reappeared under a new name: it stays unchecked.
        commitOp(current.index, op);
        continue;
      }
      commitOp(current.index, op);
      if (current.selection.isExcluded(op.path)) continue;
      outgoing.push(wireOp(op));
    }
    current.statsDirty = true;

    const session = current.session;
    if (outgoing.length > 0 && session?.sink) {
      session.sink.send({ type: STREAM.OPS, ops: outgoing });
      for (const op of outgoing) {
        // A write is logged when the peer actually downloads it (openFile).
        if (op.op !== 'write') activity.add({ kind: 'sent', op: op.op, path: op.path ?? op.from, to: op.to });
      }
    }
    changed();
  }

  // --- Lifecycle ----------------------------------------------------------

  async function start({ path, name, pin, excluded } = {}) {
    if (share) throw errors.conflict(`Already hosting "${share.name}". Stop hosting first.`, 'already_hosting');

    const check = await checkHostDirectory(path);
    if (!check.ok) throw errors.badRequest(check.message, 'invalid_path');
    const root = check.path;
    const pinValue = pin === undefined || pin === null || pin === '' ? generatePin() : assertPin(pin);
    const selection = Selection.fromInput(excluded);
    const trimmed = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : '';
    const displayName = trimmed || basename(root) || root;

    for (const excludedPath of selection.list()) {
      const state = await readState(resolveWirePath(root, excludedPath)).catch(() => null);
      selection.bindIdentity(excludedPath, identityKey(state));
    }
    await removeStaleTempFiles(root).catch(() => 0);

    const current = {
      id: newUuid(),
      name: displayName,
      root,
      pin: pinValue,
      selection,
      index: new FileIndex(),
      mutex: new Mutex(),
      startedAt: Date.now(),
      session: null,
      watcher: null,
      stats: null,
      statsAt: 0,
      statsDirty: true,
      error: null,
    };

    current.watcher = createDirectoryWatcher({
      root,
      index: current.index,
      ...watcherTiming,
      logger: logger?.child?.('watch'),
      // Temporary transfer files and the inside of unchecked directories are
      // invisible. Unchecked items themselves stay visible, so their renames
      // can be followed.
      ignore: (wire) => isTempPath(wire) || selection.hasExcludedAncestor(wire),
      onRawAdd: (wire, stats) => {
        if (stats && selection.followIdentity(wire, identityKey(stats))) {
          logger?.debug?.(`unchecked item moved to ${wire}; it stays unchecked`);
        }
      },
      onOps: (ops) => handleLocalOps(current, ops),
      run: (fn) => current.mutex.run(fn),
      onRootMissing: () => {
        setImmediate(() => {
          if (share !== current) return;
          stop({ reason: 'root_missing' }).catch((error) => logger?.error?.('stop after root loss failed:', error));
        });
      },
      onError: (error) => {
        current.error = error?.code === 'ENOSPC'
          ? 'The system limit of watched directories was reached; some changes may not be detected.'
          : String(error?.message || error);
        changed();
      },
    });

    try {
      await current.watcher.ready;
      await current.mutex.run(async () => {
        const { entries } = await walkTree(root, {
          filter: (wire) => (selection.hasExcludedAncestor(wire) ? 'prune' : 'include'),
        });
        current.index.replaceAll(entries);
      });
    } catch (error) {
      await current.watcher.close();
      throw error;
    }

    share = current;
    notice = null;
    activity.clear();
    activity.add({ kind: 'info', message: `Hosting "${displayName}" from ${root}.` });
    bus.emit(EVENTS.HOSTING_STARTED, { name: displayName, path: root, id: current.id });
    changed();
    return status();
  }

  async function stop({ reason = 'stopped' } = {}) {
    const current = share;
    if (!current) return;
    share = null;
    endSession(current, BYE.HOST_STOPPED, `The host stopped hosting "${current.name}".`);
    await current.watcher.close();
    if (reason === 'root_missing') {
      notice = { kind: 'error', message: `Hosting stopped: the directory ${current.root} disappeared.` };
    }
    activity.add({ kind: 'info', message: `Stopped hosting "${current.name}".` });
    bus.emit(EVENTS.HOSTING_STOPPED, { name: current.name, id: current.id, reason });
    changed();
  }

  function setPin(pin) {
    const current = requireShare();
    let value = pin === undefined || pin === null || pin === '' ? generatePin() : assertPin(pin);
    if (value === current.pin && (pin === undefined || pin === null || pin === '')) {
      // A "random" PIN must actually be different.
      while (value === current.pin) value = generatePin();
    }
    if (value === current.pin) return { pin: value, changed: false, disconnected: false };
    current.pin = value;
    const hadPeer = Boolean(current.session);
    activity.add({ kind: 'info', message: 'The PIN was changed.' });
    // The specification: a PIN change cuts the connected instance off at once.
    endSession(current, BYE.PIN_CHANGED, 'The host changed the PIN. Enter the new PIN to resume.');
    bus.emit(EVENTS.HOSTING_PIN_CHANGED, { disconnected: hadPeer });
    changed();
    return { pin: value, changed: true, disconnected: hadPeer };
  }

  function status() {
    if (!share) return notice ? { active: false, notice } : null;
    const current = share;
    return {
      active: true,
      id: current.id,
      name: current.name,
      path: current.root,
      pin: current.pin,
      startedAt: current.startedAt,
      excluded: current.selection.list(),
      stats: computeStats(current),
      session: publicSession(current.session),
      error: current.error,
      activity: activity.recent(60),
    };
  }

  // --- Peer API -----------------------------------------------------------

  /**
   * A peer asks to connect.
   * @param {{ pin: unknown, protocol?: string, peer?: object, remoteAddress?: string }} request
   */
  function connect({ pin, protocol, peer, remoteAddress } = {}) {
    const current = requireShare();
    if (protocol && protocol !== identity.protocol) {
      throw errors.badRequest(
        `Protocol mismatch: this instance uses ${identity.protocol.toUpperCase()} and yours uses ${String(protocol).toUpperCase()}. Both must use the same protocol.`,
        'protocol_mismatch',
      );
    }
    const info = peer && typeof peer === 'object' ? peer : {};
    const uuid = typeof info.uuid === 'string' ? info.uuid.slice(0, 64) : '';
    if (!uuid) throw errors.badRequest('The connecting instance did not identify itself.', 'bad_request');
    const hostname = typeof info.hostname === 'string' && info.hostname ? info.hostname.slice(0, 255) : 'unknown';

    // One peer at a time, whatever PIN it brings.
    if (current.session && current.session.peer.uuid !== uuid) {
      const other = current.session.peer;
      throw errors.conflict(
        `"${current.name}" is already being synced by ${other.hostname} (${other.address}). A hosted directory accepts only one connected instance at a time.`,
        'busy',
        { hostname: other.hostname, address: other.address },
      );
    }
    if (!pinMatches(typeof pin === 'string' ? pin.trim() : pin, current.pin)) {
      throw errors.forbidden('Wrong PIN.', 'pin_invalid');
    }
    if (
      typeof info.machine === 'string' &&
      info.machine === identity.machine &&
      typeof info.localPath === 'string' &&
      pathsOverlap(info.localPath, current.root)
    ) {
      throw errors.badRequest(
        'That local directory is the hosted directory itself, or is inside it, or contains it. Choose another directory.',
        'same_directory',
      );
    }

    // The same peer reconnecting replaces its previous session.
    if (current.session) endSession(current, BYE.REPLACED, 'A newer connection from the same instance replaced this one.');

    const now = Date.now();
    const session = {
      id: newUuid(),
      token: newToken(),
      peer: { uuid, hostname, address: remoteAddress || 'unknown' },
      since: now,
      lastSeen: now,
      phase: 'connecting',
      progress: null,
      sink: null,
      timer: null,
    };
    session.timer = setInterval(() => {
      if (current.session !== session) return;
      if (Date.now() - session.lastSeen > timing.peerSilenceMs) {
        endSession(current, BYE.TIMEOUT, 'The host stopped hearing from this instance.');
        return;
      }
      try {
        session.sink?.send({ type: STREAM.HEARTBEAT, at: Date.now() });
      } catch {
        /* the stream route notices the broken pipe itself */
      }
    }, timing.streamHeartbeatMs);
    session.timer.unref?.();
    current.session = session;

    activity.add({ kind: 'info', message: `${hostname} (${session.peer.address}) connected.` });
    bus.emit(EVENTS.HOSTING_PEER_CONNECTED, { peer: session.peer });
    changed();
    return {
      token: session.token,
      protocolVersion: PROTOCOL_VERSION,
      share: { id: current.id, name: current.name },
      host: { uuid: identity.uuid, hostname: identity.hostname },
    };
  }

  /**
   * Attach the NDJSON stream of an authorised session.
   * @param {string} token
   * @param {{ send: (message: object) => void, close: () => void }} sink
   * @returns {() => void} Detach, called when the HTTP response closes.
   */
  function attachStream(token, sink) {
    const { current, session } = authorize(token);
    if (session.sink && session.sink !== sink) session.sink.close();
    session.sink = sink;
    session.phase = 'syncing';
    sink.send({
      type: STREAM.HELLO,
      protocolVersion: PROTOCOL_VERSION,
      share: { id: current.id, name: current.name },
      host: { uuid: identity.uuid, hostname: identity.hostname },
    });
    changed();
    return () => {
      if (session.sink === sink) {
        session.sink = null;
        changed();
      }
    };
  }

  /** Every shared entry, freshly read from disk. */
  async function manifest(token) {
    const { current } = authorize(token);
    const { entries } = await walkTree(current.root, {
      filter: (wire) => (current.selection.isExcluded(wire) ? 'prune' : 'include'),
    });
    const out = [];
    for (const [path, state] of entries) out.push({ path, ...publicState(state) });
    return { share: { id: current.id, name: current.name }, entries: out };
  }

  async function hashes(token, paths) {
    const { current } = authorize(token);
    if (!Array.isArray(paths) || paths.length > 20_000) throw errors.badRequest('Expected a list of up to 20000 paths.');
    const out = {};
    for (const raw of paths) {
      const path = normalizeWirePath(raw);
      if (path === null || current.selection.isExcluded(path)) continue;
      try {
        const absolute = await resolveSafely(current.root, path);
        const state = await readState(absolute);
        if (state?.kind === 'file') out[path] = await hashFile(absolute);
      } catch {
        /* skipped: the peer treats a missing hash as "different" */
      }
    }
    return { hashes: out };
  }

  /** Resolve a file the peer wants to download. */
  async function openFile(token, rawPath) {
    const { current } = authorize(token);
    const path = sharedPath(current, rawPath);
    let absolute;
    try {
      absolute = await resolveSafely(current.root, path);
    } catch (error) {
      throw fsToAppError(error);
    }
    const state = await readState(absolute);
    if (!state || state.kind !== 'file') throw errors.notFound(`"${path}" is not a file on the host.`);
    return {
      path,
      absolute,
      state,
      /** Called by the route once the body was sent completely. */
      sent: () => activity.add({ kind: 'sent', op: 'write', path, size: state.size }),
    };
  }

  /**
   * Decide whether an upload is accepted, before its body is read.
   * @returns {Promise<{ current: object, path: string, existing: object|null, unchanged: boolean }>}
   */
  async function prepareUpload(token, { path: rawPath, size, mtimeMs, base }) {
    const { current } = authorize(token);
    const path = sharedPath(current, rawPath);
    if (!Number.isFinite(size) || size < 0) throw errors.badRequest('Missing or invalid file size.', 'bad_request');
    if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) throw errors.badRequest('Missing or invalid modification time.', 'bad_request');
    let absolute;
    try {
      absolute = await resolveSafely(current.root, path);
    } catch (error) {
      throw fsToAppError(error);
    }
    const existing = await readState(absolute);
    if (existing && existing.kind !== 'file') {
      throw errors.conflict(`"${path}" is a directory on the host.`, 'conflict');
    }
    const incoming = { kind: 'file', size, mtimeMs };
    if (existing && sameState(existing, incoming)) return { current, path, absolute, existing, unchanged: true };
    if (existing && !(base && sameState(existing, base)) && existing.mtimeMs >= mtimeMs) {
      // Both sides changed the file: the newer version wins, and it is the host's.
      throw errors.conflict(`The host has a newer version of "${path}".`, 'conflict');
    }
    return { current, path, absolute, existing, unchanged: false };
  }

  /**
   * Receive an upload whose metadata `prepareUpload` accepted.
   * @param {object} prepared
   * @param {import('node:stream').Readable} body
   * @param {{ size: number, mtimeMs: number }} meta
   */
  async function receiveFile(prepared, body, { size, mtimeMs }) {
    const { current, path, absolute, existing } = prepared;
    if (share !== current) throw errors.conflict('Hosting stopped during the transfer.', 'not_hosting');
    let staged;
    try {
      await current.mutex.run(async () => {
        for (const created of await ensureDirectory(current.root, parentOf(path))) current.index.set(created.path, created.state);
      });
      staged = await stageFile(current.root, path, body, { size, mtimeMs });
    } catch (error) {
      throw fsToAppError(error);
    }
    try {
      await current.mutex.run(async () => {
        // The host's own copy may have changed while the bytes were travelling.
        const now = await readState(absolute);
        if (now && now.kind !== 'file') throw errors.conflict(`"${path}" is a directory on the host.`, 'conflict');
        if (now && !(existing && sameState(now, existing)) && now.mtimeMs >= mtimeMs) {
          throw errors.conflict(`"${path}" changed on the host during the transfer.`, 'conflict');
        }
        current.index.set(path, staged.state);
        await staged.commit();
      });
    } catch (error) {
      await staged.discard();
      throw fsToAppError(error);
    }
    current.statsDirty = true;
    activity.add({ kind: 'received', op: 'write', path, size });
    return { ok: true, state: publicState(staged.state) };
  }

  /** Apply one non-content operation from the peer. Runs under the mutex. */
  async function applyOne(current, op) {
    const { root, index, selection } = current;
    switch (op?.op) {
      case 'mkdir': {
        const path = sharedPath(current, op.path);
        const created = await ensureDirectory(root, path);
        for (const entry of created) index.set(entry.path, entry.state);
        if (created.length > 0) activity.add({ kind: 'received', op: 'mkdir', path });
        return { ok: true };
      }
      case 'unlink': {
        const path = sharedPath(current, op.path);
        const absolute = await resolveSafely(root, path);
        const existing = await readState(absolute);
        if (!existing) {
          index.delete(path);
          return { ok: true, missing: true };
        }
        if (existing.kind !== 'file') throw errors.conflict(`"${path}" is not a file on the host.`, 'conflict');
        if (op.base && !sameState(existing, op.base)) {
          throw errors.conflict(`"${path}" was modified on the host, and a modification wins over a deletion.`, 'conflict');
        }
        index.delete(path);
        await removeFile(root, path);
        activity.add({ kind: 'received', op: 'unlink', path });
        return { ok: true };
      }
      case 'rmdir': {
        const path = sharedPath(current, op.path);
        const absolute = await resolveSafely(root, path);
        const existing = await readState(absolute);
        if (!existing) {
          index.deleteTree(path);
          return { ok: true, missing: true };
        }
        if (existing.kind !== 'dir') throw errors.conflict(`"${path}" is not a directory on the host.`, 'conflict');
        const { removed, kept } = await removeTree(root, path, {
          // Unchecked content stays; so does anything changed since the host
          // last announced it (it will reach the peer through the stream).
          shouldRemove: (wire, state) =>
            !selection.isExcluded(wire) && (state.kind === 'dir' || sameState(state, index.get(wire))),
        });
        for (const wire of removed) index.delete(wire);
        activity.add({ kind: 'received', op: 'rmdir', path });
        return kept.length > 0 ? { ok: true, partial: true } : { ok: true };
      }
      case 'rename': {
        const from = sharedPath(current, op.from);
        const to = sharedPath(current, op.to);
        if (from === to || isStrictlyInside(from, to)) throw errors.badRequest('Invalid rename.', 'bad_path');
        const source = await readState(await resolveSafely(root, from));
        if (!source) throw errors.conflict(`"${from}" no longer exists on the host.`, 'conflict');
        const target = await readState(await resolveSafely(root, to));
        if (target && (target.kind === 'dir' || source.kind === 'dir')) {
          throw errors.conflict(`"${to}" already exists on the host.`, 'conflict');
        }
        if (source.kind === 'file' && op.base && !sameState(source, op.base)) {
          throw errors.conflict(`"${from}" was modified on the host before the rename arrived.`, 'conflict');
        }
        if (source.kind === 'dir' && selection.hasExclusionsInside(from)) {
          // Unchecked items inside must not move: move everything else.
          const result = await moveTreeSelective(root, from, to, {
            canMove: (wire) => !selection.isExcluded(wire),
          });
          for (const [a, b] of result.moved) index.rekey(a, b);
          const { entries } = await walkTree(await resolveSafely(root, to));
          for (const [rel, state] of entries) {
            const wire = `${to}/${rel}`;
            if (!index.has(wire)) index.set(wire, state);
          }
          const toState = await readState(await resolveSafely(root, to));
          if (toState) index.set(to, toState);
          // Directories emptied and removed by the move must leave the index
          // too, or the watcher would announce their removal to the peer.
          for (const [wire] of [...index.descendants(from), [from]]) {
            if (!(await readState(resolveWirePath(root, wire)))) index.delete(wire);
          }
          activity.add({ kind: 'received', op: 'rename', path: from, to });
          return result.kept.length > 0 ? { ok: true, partial: true } : { ok: true };
        }
        const createdParents = await ensureDirectory(root, parentOf(to));
        for (const entry of createdParents) index.set(entry.path, entry.state);
        index.rekey(from, to);
        try {
          await moveEntry(root, from, to);
        } catch (error) {
          index.rekey(to, from);
          throw error;
        }
        activity.add({ kind: 'received', op: 'rename', path: from, to });
        return { ok: true };
      }
      default:
        throw errors.badRequest(`Unknown operation: ${String(op?.op)}`, 'bad_op');
    }
  }

  /** Apply a list of operations in order; each gets its own result. */
  async function applyOps(token, ops) {
    const { current } = authorize(token);
    if (!Array.isArray(ops) || ops.length > 50_000) throw errors.badRequest('Expected a list of operations.');
    const results = [];
    for (const op of ops) {
      if (share !== current) {
        results.push({ ok: false, code: 'not_hosting', message: 'Hosting stopped.' });
        continue;
      }
      try {
        results.push(await current.mutex.run(() => applyOne(current, op)));
      } catch (error) {
        const appError = fsToAppError(error);
        if (appError.status >= 500) logger?.error?.('applying a peer operation failed:', error);
        results.push({ ok: false, code: appError.code, message: appError.message });
      }
    }
    current.statsDirty = true;
    changed();
    return { results };
  }

  function heartbeat(token, report = {}) {
    const { session } = authorize(token);
    const phase = report.phase === 'live' || report.phase === 'syncing' ? report.phase : session.phase;
    const progress = report.progress && typeof report.progress === 'object' ? report.progress : null;
    const before = JSON.stringify([session.phase, session.progress]);
    session.phase = phase;
    session.progress = progress;
    if (JSON.stringify([session.phase, session.progress]) !== before) changed();
    return { ok: true };
  }

  function disconnect(token) {
    const { current } = authorize(token);
    endSession(current, 'left', 'Disconnected.');
    return { ok: true };
  }

  return {
    start,
    stop,
    setPin,
    status,
    /** True while a directory is hosted. */
    get active() {
      return Boolean(share);
    },
    /** What `GET /api/ping` says about hosting. */
    pingInfo() {
      if (!share) return null;
      return { id: share.id, name: share.name, connected: Boolean(share.session) };
    },
    connect,
    /** Throw `unauthorized` unless the token belongs to the current session. */
    verify(token) {
      authorize(token);
    },
    attachStream,
    manifest,
    hashes,
    openFile,
    prepareUpload,
    receiveFile,
    applyOps,
    heartbeat,
    disconnect,
    /** Wait until pending watcher batches are processed (tests). */
    async settle() {
      if (!share) return;
      await share.watcher.flush();
      await share.mutex.run(() => {});
    },
  };
}
