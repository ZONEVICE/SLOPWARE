/**
 * Tiny pattern router.
 *
 * Patterns are literal paths with optional named parameters (`/api/x/:id`).
 *
 * MODULARITY: routes are registered through `router.use(plugin, deps)`, where a
 * plugin is just `(router, deps) => void`. `src/http/routes/index.js` lists the
 * plugins; adding an endpoint group means writing one file and adding one line
 * there.
 */

function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regexp: new RegExp(`^${source}/?$`), keys };
}

export function createRouter() {
  /** @type {{ method: string, pattern: string, regexp: RegExp, keys: string[], handler: Function, options: object }[]} */
  const routes = [];

  const add = (method, pattern, handler, options = {}) => {
    const { regexp, keys } = compile(pattern);
    routes.push({ method: method.toUpperCase(), pattern, regexp, keys, handler, options });
    return router;
  };

  const router = {
    routes,
    /**
     * @param {string} method
     * @param {string} pattern
     * @param {(ctx: object) => Promise<void>|void} handler
     * @param {{ access?: 'ui'|'peer'|'public' }} [options] Who may call the route; see `src/http/guard.js`.
     */
    add,
    get: (pattern, handler, options) => add('GET', pattern, handler, options),
    post: (pattern, handler, options) => add('POST', pattern, handler, options),
    put: (pattern, handler, options) => add('PUT', pattern, handler, options),
    delete: (pattern, handler, options) => add('DELETE', pattern, handler, options),

    /** Mount a route plugin. */
    use(plugin, deps) {
      plugin(router, deps);
      return router;
    },

    /**
     * Find the route for a request.
     * @returns {{ route: object, params: Record<string, string> }|{ methodMismatch: true }|null}
     */
    match(method, path) {
      let mismatch = false;
      const verb = method.toUpperCase();
      for (const route of routes) {
        const found = route.regexp.exec(path);
        if (!found) continue;
        if (route.method !== verb && !(verb === 'HEAD' && route.method === 'GET')) {
          mismatch = true;
          continue;
        }
        const params = {};
        route.keys.forEach((key, index) => {
          try {
            params[key] = decodeURIComponent(found[index + 1] ?? '');
          } catch {
            params[key] = found[index + 1] ?? '';
          }
        });
        return { route, params };
      }
      return mismatch ? { methodMismatch: true } : null;
    },
  };

  return router;
}
