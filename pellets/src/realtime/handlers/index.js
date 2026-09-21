/**
 * Realtime handler registry composition.
 *
 * TO ADD A REALTIME FEATURE: write `src/realtime/handlers/<feature>.js`
 * exporting `(registry, deps) => void`, then add it to `HANDLER_PLUGINS`.
 * Add its frame types to `src/realtime/protocol.js` at the same time.
 */
import systemHandlers from './system.js';
import profileHandlers from './profile.js';
import roomHandlers from './rooms.js';
import messageHandlers from './messages.js';
import typingHandlers from './typing.js';

export const HANDLER_PLUGINS = [
  systemHandlers,
  profileHandlers,
  roomHandlers,
  messageHandlers,
  typingHandlers,
];

/**
 * @param {object} registry
 * @param {object} deps
 */
export function registerHandlers(registry, deps) {
  for (const plugin of HANDLER_PLUGINS) registry.use(plugin, deps);
  return registry;
}
