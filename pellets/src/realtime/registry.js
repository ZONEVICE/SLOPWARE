/**
 * WebSocket handler registry.
 *
 * THIS IS THE LEGO BOARD for the realtime layer, mirroring what
 * `src/http/routes/index.js` does for HTTP. A handler plugin is
 * `(registry, deps) => void` and registers one function per frame type.
 *
 * A handler receives a single context object and may:
 *   - return a value, which is sent back as an `ack` payload, or
 *   - send frames itself through `ctx.connection.send` / `ctx.gateway`, or
 *   - throw an `AppError`, which the gateway turns into an `error` frame.
 */
export function createHandlerRegistry() {
  /** @type {Map<string, Function>} */
  const handlers = new Map();

  const registry = {
    handlers,

    /**
     * @param {string} type Frame type from `C2S`.
     * @param {(ctx: object) => any} handler
     */
    register(type, handler) {
      if (handlers.has(type)) throw new Error(`Duplicate WebSocket handler for "${type}"`);
      handlers.set(type, handler);
      return registry;
    },

    /**
     * Mount a handler plugin.
     * @param {(registry: object, deps: object) => void} plugin
     * @param {object} [deps]
     */
    use(plugin, deps) {
      plugin(registry, deps);
      return registry;
    },

    has: (type) => handlers.has(type),
    get: (type) => handlers.get(type),
    types: () => [...handlers.keys()],
  };

  return registry;
}
