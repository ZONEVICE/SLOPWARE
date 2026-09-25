/**
 * The single-mode rule: an instance is hosting, syncing, or neither, never
 * two of those at once.
 *
 * Every transition goes through this controller, serialised by a mutex so that
 * two quick clicks cannot interleave a start and a stop. The ordering choices:
 *
 *  - Starting to sync while hosting first verifies the target and the PIN
 *    (the handshake), and only then stops hosting. A wrong PIN therefore
 *    leaves hosting untouched, and the user can simply try again.
 *  - Starting to host while syncing stops syncing first.
 *  - Hosting another directory requires stopping the current one first, as
 *    the specification describes ("cancel hosting to host another directory").
 */
import { EVENTS } from '../lib/events.js';
import { Mutex } from '../lib/queue.js';
import { errors } from './errors.js';

/**
 * @param {object} deps
 * @param {import('../lib/events.js').EventBus} deps.bus
 * @param {ReturnType<import('./hosting.js').createHostingService>} deps.hosting
 * @param {ReturnType<import('./syncing.js').createSyncingService>} deps.syncing
 */
export function createModeController({ bus, hosting, syncing }) {
  const mutex = new Mutex();
  let mode = 'idle';

  const setMode = (next) => {
    if (mode === next) return;
    const from = mode;
    mode = next;
    bus.emit(EVENTS.MODE_CHANGED, { from, to: next });
    bus.emit(EVENTS.STATE_CHANGED, { section: 'mode' });
  };

  // Hosting can end on its own (the directory disappeared).
  bus.on(EVENTS.HOSTING_STOPPED, () => {
    if (mode === 'hosting' && !hosting.active) setMode('idle');
  });

  return {
    get mode() {
      return mode;
    },

    startHosting(input) {
      return mutex.run(async () => {
        if (mode === 'hosting') {
          throw errors.conflict('This instance is already hosting a directory. Stop hosting first.', 'already_hosting');
        }
        if (mode === 'syncing') {
          await syncing.stop();
          setMode('idle');
        }
        const status = await hosting.start(input);
        setMode('hosting');
        return status;
      });
    },

    stopHosting() {
      return mutex.run(async () => {
        await hosting.stop();
        if (mode === 'hosting') setMode('idle');
      });
    },

    setHostPin(pin) {
      return mutex.run(async () => {
        if (mode !== 'hosting') throw errors.conflict('This instance is not hosting a directory.', 'not_hosting');
        return hosting.setPin(pin);
      });
    },

    startSyncing(input) {
      return mutex.run(async () => {
        if (mode === 'syncing') {
          throw errors.conflict('This instance is already syncing a directory. Stop syncing first.', 'already_syncing');
        }
        const prepared = await syncing.handshake(input);
        try {
          if (mode === 'hosting') {
            await hosting.stop();
            setMode('idle');
          }
          const status = await syncing.begin(prepared);
          setMode('syncing');
          return status;
        } catch (error) {
          await syncing.abandon(prepared);
          throw error;
        }
      });
    },

    stopSyncing() {
      return mutex.run(async () => {
        await syncing.stop();
        if (mode === 'syncing') setMode('idle');
      });
    },

    submitSyncPin(pin) {
      return mutex.run(async () => {
        if (mode !== 'syncing') throw errors.conflict('This instance is not syncing a directory.', 'not_syncing');
        return syncing.submitPin(pin);
      });
    },

    /** Stop whatever is running; used at shutdown. */
    shutdown() {
      return mutex.run(async () => {
        await syncing.stop().catch(() => {});
        await hosting.stop().catch(() => {});
        setMode('idle');
      });
    },
  };
}
