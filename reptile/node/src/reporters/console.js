/**
 * Console reporter: tells the person who started Reptile from a terminal what
 * is happening, without anyone having to open the control panel.
 *
 * It is a pure subscriber: it only listens to the event bus, and nothing in
 * the domain knows it exists. Removing it from `./index.js` removes the
 * messages and changes nothing else.
 */
import { EVENTS } from '../lib/events.js';

const SYNC_MESSAGES = {
  syncing: 'synchronising with the host…',
  live: 'live: both copies are identical',
  reconnecting: 'connection lost, reconnecting…',
  pin_required: 'the host changed the PIN; enter the new one in the control panel',
  stopped: 'the host stopped hosting; syncing ended',
  error: 'syncing stopped because of an error (see the control panel)',
};

/**
 * @param {{ bus: import('../lib/events.js').EventBus, logger: object }} deps
 * @returns {() => void} Detach.
 */
export default function consoleReporter({ bus, logger }) {
  const log = logger.child('events');
  const offs = [
    bus.on(EVENTS.HOSTING_STARTED, ({ name, path }) => log.info(`hosting "${name}" from ${path}`)),
    bus.on(EVENTS.HOSTING_STOPPED, ({ name, reason }) =>
      reason === 'root_missing' ? log.warn(`stopped hosting "${name}": the directory disappeared`) : log.info(`stopped hosting "${name}"`),
    ),
    bus.on(EVENTS.HOSTING_PEER_CONNECTED, ({ peer }) => log.info(`${peer.hostname} (${peer.address}) connected`)),
    bus.on(EVENTS.HOSTING_PEER_DISCONNECTED, ({ peer, reason }) => log.info(`${peer.hostname} disconnected (${reason})`)),
    bus.on(EVENTS.HOSTING_PIN_CHANGED, ({ disconnected }) =>
      log.info(`the PIN was changed${disconnected ? '; the connected instance was disconnected' : ''}`),
    ),
    bus.on(EVENTS.SYNC_STATE, ({ state }) => {
      if (SYNC_MESSAGES[state]) log.info(`sync: ${SYNC_MESSAGES[state]}`);
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}
