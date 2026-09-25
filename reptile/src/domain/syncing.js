/**
 * Syncing: receiving a directory hosted by another instance and keeping the
 * local copy identical to it, in both directions, in real time.
 *
 * Lifecycle of a session (the `state` shown in the interface):
 *
 *   connecting -> syncing -> live
 *                   ^          |  stream lost          PIN changed on host
 *                   |          +------------> reconnecting     -> pin_required
 *                   +-------------------------------+ (retries)      (user types it)
 *   host stopped hosting -> stopped      local directory lost -> error
 *
 *  - `syncing` is a full three-way reconciliation (planner.js). It runs when a
 *    session starts, after every reconnection, and whenever the live path
 *    meets something it cannot apply safely. It is what makes the engine
 *    self-healing.
 *  - `live` means both watchers are running and changes flow as they happen:
 *    host changes arrive on the NDJSON stream, local changes are pushed as
 *    requests.
 *
 * Every step that touches the local disk runs through ONE serial queue: remote
 * operations, local change batches and reconciliations never interleave.
 * Every connection gets a new "generation" number; queued work from an older
 * generation quietly does nothing, so a reconnection never races stale work.
 *
 * The local index is the BASE: the state last known to be identical on both
 * machines. It changes only once the host has confirmed an operation (or a
 * download has been committed), never optimistically, so a failed push is
 * retried by the next reconciliation instead of being mistaken for a remote
 * change.
 */
import { mkdir } from 'node:fs/promises';
import { EVENTS } from '../lib/events.js';
import { backoffDelay, runPool, SerialQueue } from '../lib/queue.js';
import { depthOf, isSameOrInside, normalizeWirePath, parentOf, resolveWirePath } from '../lib/wirePath.js';
import { isTempPath, publicState, readState, sameState } from '../fs/entry.js';
import { commitOp, FileIndex } from '../fs/fileIndex.js';
import { hashFile } from '../fs/hash.js';
import { ensureDirectory, moveEntry, removeFile, removeStaleTempFiles, removeTree, setMtime, stageFile } from '../fs/mutate.js';
import { checkSyncDirectory } from '../fs/pathCheck.js';
import { walkTree } from '../fs/walk.js';
import { createDirectoryWatcher } from '../fs/watcher.js';
import { createActivityLog } from './activity.js';
import { AppError, errors } from './errors.js';
import { assertPin } from './pin.js';
import { hashCandidates, planSync } from './planner.js';
import { BYE, STREAM, TIMING } from './protocol.js';

/** Transfers in flight during a reconciliation. */
const TRANSFER_CONCURRENCY = 8;
/** Reconciliations in a row that may end with conflicts before giving up. */
const MAX_RECONCILE_RETRIES = 3;

/** Turn a RequestError (or anything) from the peer client into an AppError. */
export function peerError(error, fallbackMessage = 'The host could not be reached.') {
  if (error instanceof AppError) return error;
  const status = error?.status || 0;
  if (status > 0) return new AppError(error.code || 'peer_error', error.message, { status: status >= 500 ? 502 : status });
  const unreachable = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'];
  if (unreachable.includes(error?.code)) return new AppError('unreachable', fallbackMessage, { status: 502 });
  return new AppError(error?.code || 'peer_error', error?.message || fallbackMessage, { status: 502 });
}

/**
 * One synchronisation session with one host.
 */
class SyncEngine {
  /**
   * @param {object} options
   */
  constructor({ peer, info, share, host, localPath, pin, identity, activity, bus, logger, config, onTerminal }) {
    this.peer = peer;
    this.info = info;
    this.share = share;
    this.host = host;
    this.root = localPath;
    this.pin = pin;
    this.identity = identity;
    this.activity = activity;
    this.bus = bus;
    this.logger = logger;
    this.config = config;
    this.onTerminal = onTerminal;
    this.timing = { ...TIMING, ...(config.timing || {}) };

    this.index = new FileIndex();
    this.queue = new SerialQueue();
    this.generation = 0;
    this.state = 'connecting';
    this.stateSince = Date.now();
    this.progress = null;
    this.notice = null;
    /** Paths the host refused because they are not shared there. */
    this.rejected = new Set();
    /** Paths left alone because each side has a different kind of entry. */
    this.conflicts = [];
    this.stream = null;
    this.watcher = null;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.reconnectAt = null;
    this.heartbeatTimer = null;
    this.reconcileTimer = null;
    this.reconcileGeneration = 0;
    this.reconcileRetries = 0;
    this.reconciling = false;
    this.reconcilingGeneration = 0;
    this.lastSyncedAt = null;
  }

  // --- State --------------------------------------------------------------

  setState(state, notice) {
    if (notice !== undefined) this.notice = notice;
    if (this.state !== state) {
      const previous = this.state;
      this.state = state;
      this.stateSince = Date.now();
      this.bus.emit(EVENTS.SYNC_STATE, { state, previous });
    }
    this.changed();
  }

  changed() {
    this.bus.emit(EVENTS.STATE_CHANGED, { section: 'syncing' });
  }

  get online() {
    return this.state === 'live' || this.state === 'syncing';
  }

  status() {
    return {
      active: true,
      state: this.state,
      since: this.stateSince,
      address: this.peer.address,
      port: this.peer.port,
      protocol: this.peer.protocol,
      host: this.host,
      share: this.share,
      localPath: this.root,
      progress: this.progress,
      notice: this.notice,
      lastSyncedAt: this.lastSyncedAt,
      reconnect: this.state === 'reconnecting' ? { attempt: this.reconnectAttempt, at: this.reconnectAt } : null,
      rejected: [...this.rejected].sort().slice(0, 200),
      conflicts: this.conflicts.slice(0, 200),
      activity: this.activity.recent(60),
    };
  }

  // --- Lifecycle ----------------------------------------------------------

  async start() {
    await mkdir(this.root, { recursive: true });
    await removeStaleTempFiles(this.root).catch(() => 0);
    this.activity.add({ kind: 'info', message: `Connected to ${this.host.hostname} (${this.peer.address}:${this.peer.port}).` });
    this.startHeartbeat();
    await this.openStream();
  }

  /**
   * Start watching the local directory. Called once the first reconciliation
   * is done: chokidar triples the cost of writing a file into a watched tree,
   * and a first sync can write thousands. The rescan right after the watcher
   * is ready catches anything the user changed in the meantime.
   */
  async startWatcher() {
    if (this.watcher || this.stopped) return;
    this.watcher = createDirectoryWatcher({
      root: this.root,
      index: this.index,
      ...(this.config.watcher || {}),
      logger: this.logger?.child?.('watch'),
      ignore: (wire) => isTempPath(wire),
      onOps: (ops) => this.pushLocal(ops),
      run: (fn) => this.queue.push(fn),
      onRootMissing: () => {
        setImmediate(() =>
          this.fail(`The local directory ${this.root} disappeared. Syncing stopped so that nothing is deleted on the host.`),
        );
      },
      onError: (error) => this.logger?.warn?.('local watcher error:', error?.message || error),
    });
    await this.watcher.ready;
    if (this.stopped || this.state === 'stopped' || this.state === 'error') {
      await this.watcher.close();
      return;
    }
    await this.watcher.rescan();
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.online || !this.peer.token) return;
      const progress = this.progress ? { done: this.progress.done, total: this.progress.total } : null;
      this.peer.heartbeat({ phase: this.state, progress }).catch(() => {});
    }, this.timing.peerHeartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  async openStream() {
    const generation = ++this.generation;
    this.queue.clear();
    const stream = await this.peer.openStream({
      onMessage: (message) => this.onMessage(message, generation),
      onClose: (error) => this.onStreamClosed(error, generation),
    });
    if (generation !== this.generation || this.stopped) {
      stream.close();
      return;
    }
    this.stream = stream;
  }

  onMessage(message, generation) {
    if (generation !== this.generation || this.stopped) return;
    switch (message?.type) {
      case STREAM.HELLO:
        this.reconnectAttempt = 0;
        this.setState('syncing', null);
        this.scheduleReconcile(0);
        break;
      case STREAM.OPS:
        if (Array.isArray(message.ops)) this.queue.push(() => this.applyRemote(message.ops, generation));
        break;
      case STREAM.BYE:
        this.onBye(message, generation);
        break;
      default:
        break; // heartbeats only keep the socket busy
    }
  }

  onBye({ reason, message }, generation) {
    if (generation !== this.generation) return;
    this.generation += 1;
    this.cancelReconcile();
    this.queue.clear();
    this.stream?.close();
    this.stream = null;
    this.progress = null;
    this.peer.token = null;
    if (reason === BYE.PIN_CHANGED) {
      this.activity.add({ kind: 'warning', message: 'The host changed the PIN. Syncing is paused until the new PIN is entered.' });
      this.setState('pin_required', { kind: 'warning', message: message || 'The host changed the PIN. Enter the new PIN to resume syncing.' });
      return;
    }
    if (reason === BYE.HOST_STOPPED) {
      this.activity.add({ kind: 'warning', message: message || 'The host stopped hosting.' });
      this.end('stopped', { kind: 'warning', message: message || `The host stopped hosting "${this.share.name}".` });
      return;
    }
    // Replaced or timed out: try again.
    this.setState('reconnecting', { kind: 'warning', message: message || 'The connection was interrupted. Reconnecting…' });
    this.scheduleReconnect();
  }

  onStreamClosed(error, generation) {
    if (generation !== this.generation || this.stopped) return;
    if (this.state === 'pin_required' || this.state === 'stopped' || this.state === 'error') return;
    this.generation += 1;
    this.cancelReconcile();
    this.queue.clear();
    this.stream = null;
    this.progress = null;
    this.logger?.debug?.('stream closed:', error?.message || 'end');
    this.activity.add({ kind: 'warning', message: 'Lost the connection to the host. Reconnecting…' });
    this.setState('reconnecting', { kind: 'warning', message: 'Lost the connection to the host. Reconnecting…' });
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    if (this.stopped) return;
    const delay = backoffDelay(this.reconnectAttempt, { baseMs: 1000, maxMs: 10_000 });
    this.reconnectAttempt += 1;
    this.reconnectAt = Date.now() + delay;
    this.changed();
    this.reconnectTimer = setTimeout(() => {
      this.reconnect().catch((error) => this.logger?.debug?.('reconnect failed:', error.message));
    }, delay);
  }

  async reconnect() {
    if (this.stopped || this.state !== 'reconnecting') return;
    try {
      const info = await this.peer.ping();
      if (info.uuid !== this.host.uuid) {
        this.end('stopped', { kind: 'warning', message: `${this.host.hostname} restarted. Start a new sync from the start screen.` });
        return;
      }
      if (!info.hosting || info.hosting.id !== this.share.id) {
        this.end('stopped', { kind: 'warning', message: `The host is no longer hosting "${this.share.name}".` });
        return;
      }
      try {
        await this.openStream();
      } catch (error) {
        if (error?.status !== 401) throw error;
        // The old session is gone on the host: open a new one with the PIN.
        await this.authenticate(this.pin);
        await this.openStream();
      }
    } catch (error) {
      if (this.stopped || this.state !== 'reconnecting') return;
      if (error?.code === 'pin_invalid') {
        this.setState('pin_required', { kind: 'warning', message: 'The host’s PIN changed. Enter the new PIN to resume syncing.' });
        return;
      }
      if (error?.code === 'not_hosting') {
        this.end('stopped', { kind: 'warning', message: `The host is no longer hosting "${this.share.name}".` });
        return;
      }
      const message =
        error?.code === 'busy'
          ? `${error.message} Retrying…`
          : `The host cannot be reached (${error?.code || 'error'}). Retrying…`;
      this.setState('reconnecting', { kind: 'warning', message });
      this.scheduleReconnect();
    }
  }

  async authenticate(pin) {
    const result = await this.peer.connect({ pin, localPath: this.root });
    if (result.share?.id !== this.share.id) {
      throw new AppError('not_hosting', 'The host is hosting a different directory now.', { status: 409 });
    }
    this.pin = pin;
  }

  /** The user typed a new PIN after the host changed it. */
  async submitPin(pin) {
    const value = assertPin(pin);
    if (this.state !== 'pin_required' && this.state !== 'reconnecting') {
      throw errors.conflict('No PIN is needed right now.', 'pin_not_needed');
    }
    try {
      const info = await this.peer.ping();
      if (info.uuid !== this.host.uuid || !info.hosting || info.hosting.id !== this.share.id) {
        this.end('stopped', { kind: 'warning', message: `The host is no longer hosting "${this.share.name}".` });
        throw errors.conflict(`The host is no longer hosting "${this.share.name}".`, 'not_hosting');
      }
      await this.authenticate(value);
    } catch (error) {
      const appError = peerError(error);
      if (appError.code === 'pin_invalid') throw errors.forbidden('Wrong PIN. Try again.', 'pin_invalid');
      throw appError;
    }
    clearTimeout(this.reconnectTimer);
    this.activity.add({ kind: 'info', message: 'PIN accepted. Resuming.' });
    this.setState('connecting', null);
    try {
      await this.openStream();
    } catch (error) {
      this.setState('reconnecting', { kind: 'warning', message: 'Could not reopen the connection. Retrying…' });
      this.scheduleReconnect();
    }
    return this.status();
  }

  /** Terminal state: stop moving data, keep the status visible. */
  end(state, notice) {
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    this.cancelReconcile();
    clearInterval(this.heartbeatTimer);
    this.queue.clear();
    this.stream?.close();
    this.stream = null;
    this.progress = null;
    this.watcher?.close().catch(() => {});
    this.setState(state, notice);
    this.onTerminal?.(state);
  }

  fail(message) {
    if (this.stopped || this.state === 'error' || this.state === 'stopped') return;
    this.activity.add({ kind: 'error', message });
    this.peer.disconnect().catch(() => {});
    this.end('error', { kind: 'error', message });
  }

  async stop({ notifyHost = true } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    this.cancelReconcile();
    clearInterval(this.heartbeatTimer);
    this.queue.clear();
    this.stream?.close();
    this.stream = null;
    if (notifyHost) await this.peer.disconnect().catch(() => {});
    await this.watcher?.close().catch(() => {});
    // Let a task that is already running notice the new generation and return.
    await Promise.race([this.queue.idle(), new Promise((resolve) => setTimeout(resolve, 5000))]);
    this.peer.close();
  }

  // --- Reconciliation -----------------------------------------------------

  scheduleReconcile(delay = 400) {
    if (this.stopped) return;
    // A timer left over from an older connection must not block this one's
    // reconciliation (it would fire, see a stale generation, and do nothing).
    if (this.reconcileTimer && this.reconcileGeneration !== this.generation) this.cancelReconcile();
    // A running reconciliation decides by itself whether another one is
    // needed (bounded by MAX_RECONCILE_RETRIES); requests made from inside it
    // would otherwise turn a permanent failure into an endless loop.
    if (this.reconcileTimer || (this.reconciling && this.reconcilingGeneration === this.generation)) return;
    const generation = this.generation;
    this.reconcileGeneration = generation;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      if (generation !== this.generation || this.stopped) return;
      this.queue.push(() => this.reconcile(generation));
    }, delay);
  }

  cancelReconcile() {
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  isRejected(path) {
    for (const rejected of this.rejected) if (isSameOrInside(rejected, path)) return true;
    return false;
  }

  async reconcile(generation) {
    if (generation !== this.generation || this.stopped) return;
    const alive = () => generation === this.generation && !this.stopped;
    this.reconciling = true;
    this.reconcilingGeneration = generation;
    let retryIn = 0;
    try {
      retryIn = await this.reconcilePass(generation, alive);
    } finally {
      this.reconciling = false;
    }
    if (!this.watcher && alive()) await this.startWatcher();
    if (retryIn > 0) this.scheduleReconcile(retryIn);
  }

  /**
   * One full comparison and execution.
   * @returns {Promise<number>} Milliseconds until another pass should run, or 0.
   */
  async reconcilePass(generation, alive) {
    this.setState('syncing');
    this.progress = { phase: 'scanning', done: 0, total: 0, bytesDone: 0, bytesTotal: 0, current: null };
    this.changed();

    let needsAnother = false;
    try {
      const manifest = await this.peer.manifest();
      if (!alive()) return 0;
      if (manifest.share?.id && manifest.share.id !== this.share.id) {
        this.end('stopped', { kind: 'warning', message: 'The host is hosting a different directory now.' });
        return 0;
      }
      const remote = new Map();
      for (const entry of manifest.entries || []) {
        const path = normalizeWirePath(entry.path);
        if (path === null || isTempPath(path)) continue;
        if (entry.kind !== 'file' && entry.kind !== 'dir') continue;
        remote.set(path, { kind: entry.kind, size: Number(entry.size) || 0, mtimeMs: Number(entry.mtimeMs) || 0 });
      }
      const { entries: localEntries } = await walkTree(this.root);
      if (!alive()) return 0;
      const local = new Map();
      for (const [path, state] of localEntries) local.set(path, publicState(state));
      const base = this.index.toPublicMap();

      // Equal content with different mtimes is common before a first sync
      // (copies made by other means); hash those instead of copying them.
      const equalContent = new Set();
      const candidates = hashCandidates({ local, remote, base });
      if (candidates.length > 0) {
        this.progress = { ...this.progress, phase: 'comparing' };
        this.changed();
        const remoteHashes = await this.peer.hashes(candidates);
        for (const path of candidates) {
          if (!alive()) return 0;
          if (!remoteHashes[path]) continue;
          const localHash = await hashFile(resolveWirePath(this.root, path)).catch(() => null);
          if (localHash && localHash === remoteHashes[path]) equalContent.add(path);
        }
      }

      const { actions, conflicts } = planSync({ local, remote, base, isRejected: (path) => this.isRejected(path), equalContent });
      this.conflicts = conflicts.map((conflict) => conflict.path);
      for (const conflict of conflicts) {
        this.activity.add({
          kind: 'warning',
          path: conflict.path,
          message: `"${conflict.path}" is a ${conflict.local?.kind === 'dir' ? 'directory' : 'file'} here and a ${conflict.remote?.kind === 'dir' ? 'directory' : 'file'} on the host. It was left alone.`,
        });
      }
      needsAnother = await this.execute(actions, localEntries, alive);
    } catch (error) {
      if (!alive()) return 0;
      this.logger?.warn?.('reconciliation failed:', error.message);
      this.progress = null;
      if (error?.status === 401) {
        // The session vanished; the stream will close and trigger a reconnect.
        return 0;
      }
      needsAnother = true;
    }

    if (!alive()) return 0;
    this.progress = null;
    this.lastSyncedAt = Date.now();
    this.setState('live');
    if (needsAnother && this.reconcileRetries < MAX_RECONCILE_RETRIES) {
      this.reconcileRetries += 1;
      return 1000 * this.reconcileRetries;
    }
    this.reconcileRetries = 0;
    return 0;
  }

  /**
   * Carry out a plan. Returns true when something could not be completed and
   * another reconciliation is worthwhile.
   */
  async execute(actions, localEntries, alive) {
    const byType = new Map();
    for (const action of actions) {
      if (!byType.has(action.type)) byType.set(action.type, []);
      byType.get(action.type).push(action);
    }
    const take = (type) => byType.get(type) || [];
    const work = actions.filter((action) => !['in-sync', 'forget'].includes(action.type));
    this.progress = {
      phase: 'transferring',
      done: 0,
      total: work.length,
      bytesDone: 0,
      bytesTotal:
        take('download').reduce((sum, action) => sum + (action.remote?.size || 0), 0) +
        take('upload').reduce((sum, action) => sum + (action.local?.size || 0), 0),
      current: null,
    };
    this.changed();
    let incomplete = false;
    const step = (action, bytes = 0) => {
      this.progress.done += 1;
      this.progress.bytesDone += bytes;
      this.progress.current = action?.path ?? null;
      this.changed();
    };

    // Bookkeeping: what is already identical becomes the new base.
    for (const action of take('in-sync')) {
      const state = localEntries.get(action.path);
      if (state) this.index.set(action.path, state);
    }
    for (const action of take('forget')) this.index.delete(action.path);
    for (const action of take('adopt-mtime')) {
      if (!alive()) return false;
      try {
        const state = await setMtime(this.root, action.path, action.remote.mtimeMs);
        if (state) this.index.set(action.path, state);
      } catch {
        incomplete = true;
      }
      step(action);
    }

    // Deletions, deepest first.
    const byDepthDesc = (a, b) => depthOf(b.path) - depthOf(a.path);
    for (const action of take('local-delete').sort(byDepthDesc)) {
      if (!alive()) return false;
      try {
        await this.deleteLocal(action.path, action.local);
      } catch (error) {
        this.logger?.debug?.(`could not delete ${action.path}:`, error.message);
        incomplete = true;
      }
      step(action);
    }
    const remoteDeletes = take('remote-delete').sort(byDepthDesc);
    if (remoteDeletes.length > 0 && alive()) {
      const ops = remoteDeletes.map((action) =>
        action.remote.kind === 'dir'
          ? { op: 'rmdir', path: action.path }
          : { op: 'unlink', path: action.path, base: action.base ? publicState(action.base) : publicState(action.remote) },
      );
      if (await this.sendOps(ops, ops.map((op) => ({ op: op.op, path: op.path })))) incomplete = true;
      for (const action of remoteDeletes) step(action);
    }

    // Directories, shallowest first.
    const byDepthAsc = (a, b) => depthOf(a.path) - depthOf(b.path);
    for (const action of take('local-mkdir').sort(byDepthAsc)) {
      if (!alive()) return false;
      try {
        await this.makeLocalDirectory(action.path, action.local);
      } catch {
        incomplete = true;
      }
      step(action);
    }
    const remoteMkdirs = take('remote-mkdir').sort(byDepthAsc);
    if (remoteMkdirs.length > 0 && alive()) {
      const ops = remoteMkdirs.map((action) => ({ op: 'mkdir', path: action.path }));
      const commits = remoteMkdirs.map((action) => ({ op: 'mkdir', path: action.path, state: localEntries.get(action.path) }));
      if (await this.sendOps(ops, commits)) incomplete = true;
      for (const action of remoteMkdirs) step(action);
    }

    // Transfers.
    const transfers = [...take('download'), ...take('upload')];
    const failures = await runPool(transfers, TRANSFER_CONCURRENCY, async (action) => {
      if (!alive()) return;
      this.progress.current = action.path;
      this.changed();
      if (action.type === 'download') {
        const ok = await this.download(action.path, { expectLocal: action.local });
        if (!ok) incomplete = true;
        step(action, action.remote?.size || 0);
      } else {
        const ok = await this.upload(action.path, { base: action.base });
        if (!ok) incomplete = true;
        step(action, action.local?.size || 0);
      }
    });
    if (failures.length > 0) {
      incomplete = true;
      for (const failure of failures) this.logger?.debug?.(`transfer of ${failure.item.path} failed:`, failure.error.message);
    }
    return incomplete;
  }

  // --- Local disk helpers -------------------------------------------------

  async deleteLocal(path, expected) {
    const absolute = resolveWirePath(this.root, path);
    const current = await readState(absolute);
    if (!current) {
      this.index.deleteTree(path);
      return;
    }
    if (current.kind === 'dir') {
      const { removed, kept } = await removeTree(this.root, path, {
        shouldRemove: (wire, state) => state.kind === 'dir' || sameState(state, this.index.get(wire)) || sameState(state, expected),
      });
      for (const wire of removed) this.index.delete(wire);
      if (kept.length > 0) throw new Error(`${path} still holds ${kept.length} item(s)`);
    } else {
      // Changed since the plan was made: leave it, the watcher will push it.
      if (expected && !sameState(current, expected)) throw new Error(`${path} changed locally`);
      this.index.delete(path);
      await removeFile(this.root, path);
    }
    this.activity.add({ kind: 'received', op: current.kind === 'dir' ? 'rmdir' : 'unlink', path });
  }

  async makeLocalDirectory(path, expected) {
    const absolute = resolveWirePath(this.root, path);
    const current = await readState(absolute);
    if (current?.kind === 'file') {
      // The host replaced a file with a directory, and the local file is
      // unchanged since then (otherwise the plan would be a conflict).
      if (expected && !sameState(current, expected)) throw new Error(`${path} changed locally`);
      this.index.delete(path);
      await removeFile(this.root, path);
    }
    const created = await ensureDirectory(this.root, path);
    for (const entry of created) this.index.set(entry.path, entry.state);
    const state = await readState(absolute);
    if (state?.kind === 'dir') this.index.set(path, state);
    if (created.length > 0) this.activity.add({ kind: 'received', op: 'mkdir', path });
  }

  /**
   * Download one file from the host and commit it.
   * @param {string} path
   * @param {{ expectLocal?: object|null }} [options] The local state the decision was based on.
   * @returns {Promise<boolean>} false when it had to be skipped or failed.
   */
  async download(path, { expectLocal } = {}) {
    const absolute = resolveWirePath(this.root, path);
    try {
      const before = await readState(absolute);
      if (before?.kind === 'dir') {
        // The host replaced a directory with a file; the planner made sure the
        // directory's content was removed first.
        const { kept } = await removeTree(this.root, path, { shouldRemove: (wire, state) => state.kind === 'dir' });
        if (kept.length > 0) return false;
        this.index.deleteTree(path);
      }
      for (const entry of await ensureDirectory(this.root, parentOf(path))) this.index.set(entry.path, entry.state);
      const remote = await this.peer.download(path);
      const staged = await stageFile(this.root, path, remote.stream, { size: remote.size, mtimeMs: remote.mtimeMs });
      const now = await readState(absolute);
      const unchangedLocally = expectLocal === undefined || sameState(now, expectLocal) || sameState(now, this.index.get(path));
      if (now && now.kind === 'file' && !unchangedLocally) {
        // Edited locally while downloading: keep the local edit, let the plan decide again.
        await staged.discard();
        this.scheduleReconcile();
        return false;
      }
      this.index.set(path, staged.state);
      await staged.commit();
      this.activity.add({ kind: 'received', op: 'write', path, size: remote.size });
      return true;
    } catch (error) {
      this.logger?.debug?.(`download of ${path} failed:`, error.message);
      if (error?.code === 'not_shared' || error?.status === 404) return false;
      return false;
    }
  }

  /**
   * Upload one local file.
   * @param {string} path
   * @param {{ base?: object|null }} [options]
   * @returns {Promise<boolean>} false when it was refused or failed.
   */
  async upload(path, { base } = {}) {
    const absolute = resolveWirePath(this.root, path);
    const current = await readState(absolute);
    if (!current || current.kind !== 'file') return true; // gone meanwhile: the watcher reports it
    try {
      await this.peer.upload(path, { absolute, size: current.size, mtimeMs: current.mtimeMs, base: base ? publicState(base) : null });
      this.index.set(path, current);
      this.activity.add({ kind: 'sent', op: 'write', path, size: current.size });
      return true;
    } catch (error) {
      return this.handleRefusal(error, path);
    }
  }

  /**
   * Interpret a refused request.
   * @returns {false}
   */
  handleRefusal(error, path) {
    if (error?.code === 'not_shared') {
      if (!this.rejected.has(path)) {
        this.rejected.add(path);
        this.activity.add({ kind: 'warning', path, message: `"${path}" was not synced: the host does not share that path.` });
        this.changed();
      }
      return false;
    }
    if (error?.code === 'conflict') {
      this.scheduleReconcile();
      return false;
    }
    this.logger?.debug?.(`request for ${path} failed:`, error?.message);
    this.scheduleReconcile(2000);
    return false;
  }

  /**
   * Send non-content operations and commit each confirmed one to the index.
   * @param {object[]} ops Wire operations.
   * @param {object[]} commits Matching operations with local state, for `commitOp`.
   * @returns {Promise<boolean>} true when something was not applied cleanly.
   */
  async sendOps(ops, commits) {
    let results;
    try {
      results = await this.peer.ops(ops);
    } catch (error) {
      this.handleRefusal(error, ops[0]?.path ?? ops[0]?.from);
      return true;
    }
    let incomplete = false;
    ops.forEach((op, index) => {
      const result = results[index] || { ok: false };
      const path = op.path ?? op.from;
      if (result.ok) {
        commitOp(this.index, commits[index]);
        this.activity.add({ kind: 'sent', op: op.op, path, to: op.to });
        if (result.partial) {
          incomplete = true;
          this.scheduleReconcile();
        }
      } else {
        incomplete = true;
        this.handleRefusal(result, op.to ?? path);
      }
    });
    return incomplete;
  }

  // --- Live: local changes -> host ----------------------------------------

  /** Called by the watcher, inside the queue, with each batch of local changes. */
  async pushLocal(ops) {
    for (const op of ops) if (op.op === 'reindex') commitOp(this.index, op);
    // Offline: nothing to do now. The reconciliation after reconnecting
    // compares against the base and pushes these changes then.
    if (!this.online || !this.peer.token) return;
    const generation = this.generation;

    let batch = [];
    let commits = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const ops = batch;
      const pending = commits;
      batch = [];
      commits = [];
      await this.sendOps(ops, pending);
    };

    for (const op of ops) {
      if (generation !== this.generation || this.stopped) return;
      if (op.op === 'reindex') continue;
      const target = op.op === 'rename' ? op.to : op.path;
      if (this.isRejected(target) && op.op !== 'unlink' && op.op !== 'rmdir') continue;
      if (op.op === 'write') {
        await flush();
        await this.upload(op.path, { base: op.base });
        continue;
      }
      if (op.op === 'rename') {
        const base = this.index.get(op.from);
        batch.push({ op: 'rename', from: op.from, to: op.to, kind: op.kind, ...(op.kind === 'file' && base ? { base: publicState(base) } : {}) });
      } else if (op.op === 'unlink') {
        batch.push({ op: 'unlink', path: op.path, ...(op.base ? { base: publicState(op.base) } : {}) });
      } else {
        batch.push({ op: op.op, path: op.path });
      }
      commits.push(op);
    }
    await flush();
  }

  // --- Live: host changes -> local disk -----------------------------------

  async applyRemote(ops, generation) {
    for (const op of ops) {
      if (generation !== this.generation || this.stopped) return;
      try {
        await this.applyRemoteOne(op);
      } catch (error) {
        this.logger?.debug?.(`could not apply ${op?.op} from the host:`, error.message);
        this.scheduleReconcile();
      }
    }
    this.lastSyncedAt = Date.now();
    this.changed();
  }

  async applyRemoteOne(op) {
    const path = normalizeWirePath(op.op === 'rename' ? op.from : op.path);
    if (path === null || isTempPath(path)) return;
    const absolute = resolveWirePath(this.root, path);
    const current = await readState(absolute);
    const known = this.index.get(path);

    switch (op.op) {
      case 'mkdir': {
        if (current?.kind === 'dir') {
          this.index.set(path, current);
          return;
        }
        if (current) {
          if (current.kind === 'file' && sameState(current, known)) {
            this.index.delete(path);
            await removeFile(this.root, path);
          } else {
            this.scheduleReconcile();
            return;
          }
        }
        await this.makeLocalDirectory(path, null);
        return;
      }
      case 'write': {
        const remote = { kind: 'file', size: Number(op.size), mtimeMs: Number(op.mtimeMs) };
        if (current && sameState(current, remote)) {
          this.index.set(path, current);
          return;
        }
        if (current && (current.kind !== 'file' || !sameState(current, known))) {
          // Local edits not yet on the host: the planner decides who wins.
          this.scheduleReconcile();
          return;
        }
        await this.download(path, { expectLocal: current });
        return;
      }
      case 'unlink': {
        if (!current) {
          this.index.delete(path);
          return;
        }
        if (current.kind === 'file' && sameState(current, known)) {
          this.index.delete(path);
          await removeFile(this.root, path);
          this.activity.add({ kind: 'received', op: 'unlink', path });
          return;
        }
        this.scheduleReconcile();
        return;
      }
      case 'rmdir': {
        if (!current) {
          this.index.deleteTree(path);
          return;
        }
        if (current.kind !== 'dir') {
          this.scheduleReconcile();
          return;
        }
        const { removed, kept } = await removeTree(this.root, path, {
          shouldRemove: (wire, state) => state.kind === 'dir' || sameState(state, this.index.get(wire)),
        });
        for (const wire of removed) this.index.delete(wire);
        this.activity.add({ kind: 'received', op: 'rmdir', path });
        if (kept.length > 0) this.scheduleReconcile();
        return;
      }
      case 'rename': {
        const to = normalizeWirePath(op.to);
        if (to === null) return;
        const target = await readState(resolveWirePath(this.root, to));
        if (!current && target && sameState(target, this.index.get(to))) return; // already done
        const inSync = current && known && current.kind === known.kind && (current.kind === 'dir' || sameState(current, known));
        if (inSync && !target) {
          this.index.rekey(path, to);
          try {
            const created = await moveEntry(this.root, path, to);
            for (const entry of created) this.index.set(entry.path, entry.state);
          } catch (error) {
            this.index.rekey(to, path);
            throw error;
          }
          this.activity.add({ kind: 'received', op: 'rename', path, to });
          return;
        }
        this.scheduleReconcile();
        return;
      }
      default:
        return;
    }
  }
}

/**
 * The syncing service: at most one engine at a time.
 *
 * @param {object} deps
 * @param {import('../lib/events.js').EventBus} deps.bus
 * @param {object} deps.identity
 * @param {object} deps.config
 * @param {(target: { address: string, port: number, protocol: string }) => object} deps.peerFactory
 * @param {(options: object) => Promise<object>} deps.probe Discovery probe, for precise errors.
 * @param {object} [deps.logger]
 */
export function createSyncingService({ bus, identity, config, peerFactory, probe, logger }) {
  const activity = createActivityLog({ bus, source: 'syncing' });
  /** @type {SyncEngine|null} */
  let engine = null;

  const ADDRESS = /^[A-Za-z0-9.:%-]{1,253}$/;

  function parseTarget({ address, port }) {
    const host = typeof address === 'string' ? address.trim().replace(/^\[|\]$/g, '') : '';
    if (!host || !ADDRESS.test(host)) throw errors.badRequest('Type the IP address of the other instance.', 'bad_address');
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      throw errors.badRequest('The port must be a number between 1 and 65535.', 'bad_port');
    }
    return { address: host, port: portNumber };
  }

  /**
   * Check what lives at an address: used by the manual connection form and
   * before every handshake.
   * @returns {Promise<{ info: object, compatible: boolean }>}
   */
  async function inspect(input) {
    const { address, port } = parseTarget(input);
    const result = await probe({ host: address, port, preferProtocol: identity.protocol, connectTimeoutMs: 2500, requestTimeoutMs: 4000 });
    if (result.status === 'closed' || result.status === 'unreachable') {
      throw errors.badRequest(`Nothing answered at ${address}:${port}. Check the address, the port and that Reptile is running there.`, 'unreachable');
    }
    if (result.status !== 'found') {
      throw errors.badRequest(`Something answered at ${address}:${port}, but it is not Reptile.`, 'not_reptile');
    }
    const info = result.info;
    return {
      info: {
        uuid: info.uuid,
        hostname: info.hostname,
        address,
        port,
        protocol: info.protocol,
        version: info.version,
        mode: info.mode,
        hosting: info.hosting || null,
      },
      compatible: info.protocol === identity.protocol,
      self: info.uuid === identity.uuid,
    };
  }

  /** Throw the precise reason why a target cannot be synced from. */
  function assertSyncable(target) {
    const { info } = target;
    if (target.self) throw errors.badRequest('That is this same instance. Choose another one.', 'self');
    if (!target.compatible) {
      throw errors.badRequest(
        `Protocol mismatch: ${info.hostname} runs ${info.protocol.toUpperCase()} and this instance runs ${identity.protocol.toUpperCase()}. Both must use the same protocol.`,
        'protocol_mismatch',
      );
    }
    if (!info.hosting) throw errors.conflict(`${info.hostname} is not hosting a directory.`, 'not_hosting');
  }

  /**
   * Verify everything and open a session on the host, without touching the
   * local disk or this instance's mode yet. A wrong PIN fails here, so the
   * user can simply try again.
   */
  async function handshake({ address, port, localPath, pin }) {
    const pinValue = assertPin(pin);
    const check = await checkSyncDirectory(localPath);
    if (!check.ok) throw errors.badRequest(check.message, 'invalid_path');
    const target = await inspect({ address, port });
    assertSyncable(target);

    const peer = peerFactory({ address: target.info.address, port: target.info.port, protocol: identity.protocol });
    let session;
    try {
      session = await peer.connect({ pin: pinValue, localPath: check.path });
    } catch (error) {
      peer.close();
      const appError = peerError(error);
      if (appError.code === 'pin_invalid') throw errors.forbidden('Wrong PIN. Try again.', 'pin_invalid');
      throw appError;
    }
    return { peer, info: target.info, session, localPath: check.path, pin: pinValue };
  }

  /** Start the engine for a successful handshake. */
  async function begin(prepared) {
    if (engine) await stop();
    activity.clear();
    const next = new SyncEngine({
      peer: prepared.peer,
      info: prepared.info,
      share: prepared.session.share,
      host: prepared.session.host,
      localPath: prepared.localPath,
      pin: prepared.pin,
      identity,
      activity,
      bus,
      logger,
      config,
    });
    engine = next;
    try {
      await next.start();
    } catch (error) {
      engine = null;
      await next.stop().catch(() => {});
      throw peerError(error, 'Could not start syncing.');
    }
    bus.emit(EVENTS.STATE_CHANGED, { section: 'syncing' });
    return next.status();
  }

  async function stop() {
    const current = engine;
    if (!current) return;
    engine = null;
    await current.stop({ notifyHost: current.state !== 'stopped' });
    bus.emit(EVENTS.STATE_CHANGED, { section: 'syncing' });
  }

  return {
    inspect,
    handshake,
    begin,
    stop,
    /** Abandon a handshake whose session will not be used. */
    async abandon(prepared) {
      await prepared.peer.disconnect().catch(() => {});
      prepared.peer.close();
    },
    async submitPin(pin) {
      if (!engine) throw errors.conflict('This instance is not syncing a directory.', 'not_syncing');
      return engine.submitPin(pin);
    },
    status() {
      return engine ? engine.status() : null;
    },
    get active() {
      return Boolean(engine);
    },
    /** What `GET /api/ping` says about syncing. */
    pingInfo() {
      return engine ? { hostname: engine.host.hostname, share: engine.share.name, state: engine.state } : null;
    },
    /** Wait until the engine has nothing queued (tests). */
    async settle() {
      if (!engine) return;
      await engine.watcher?.flush();
      await engine.queue.idle();
    },
    /** The running engine, for tests and diagnostics. */
    get engine() {
      return engine;
    },
  };
}
