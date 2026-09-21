/**
 * Tiny pattern router.
 *
 * Patterns support named parameters (`/api/rooms/:id`) and a trailing wildcard
 * (`/uploads/*`), which is everything Pellets needs.
 *
 * MODULARITY: routes are registered through `router.use(plugin)`, where a
 * plugin is just `(router, deps) => void`. `src/http/routes/index.js` lists the
 * plugins; adding an endpoint group means writing one file and adding one line
 * there.
 */

/**
 * Compile a path pattern into a matcher.
 * @param {string} pattern
 */
function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment === '*') {
        keys.push('wildcard');
        return '(.*)';
      }
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      // Escape regex metacharacters in literal segments.
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regexp: new RegExp(`^${source}/?$`), keys };
}

export function createRouter() {
  /** @type {{ method: string, pattern: string, regexp: RegExp, keys: string[], handler: Function }[]} */
  const routes = [];

  const add = (method, pattern, handler) => {
    const { regexp, keys } = compile(pattern);
    routes.push({ method: method.toUpperCase(), pattern, regexp, keys, handler });
    return router;
  };

  const router = {
    routes,
    add,
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    put: (pattern, handler) => add('PUT', pattern, handler),
    patch: (pattern, handler) => add('PATCH', pattern, handler),
    delete: (pattern, handler) => add('DELETE', pattern, handler),
    /** Matches any method. */
    all: (pattern, handler) => add('*', pattern, handler),

    /**
     * Mount a route plugin.
     * @param {(router: object, deps: object) => void} plugin
     * @param {object} [deps]
     */
    use(plugin, deps) {
      plugin(router, deps);
      return router;
    },

    /**
     * Find and run the first matching route.
     *
     * A GET pattern also answers HEAD, so every document is introspectable.
     * @param {object} ctx Request context; `ctx.params` is filled in place.
     * @returns {Promise<boolean>} true when a route handled the request.
     */
    async handle(ctx) {
      const method = ctx.req.method.toUpperCase();
      const path = ctx.url.pathname;

      let methodMismatch = false;
      for (const route of routes) {
        const match = route.regexp.exec(path);
        if (!match) continue;

        const methodMatches =
          route.method === '*' || route.method === method || (method === 'HEAD' && route.method === 'GET');
        if (!methodMatches) {
          methodMismatch = true;
          continue;
        }

        /** @type {Record<string,string>} */
        const params = {};
        route.keys.forEach((key, index) => {
          const raw = match[index + 1] ?? '';
          try {
            params[key] = decodeURIComponent(raw);
          } catch {
            params[key] = raw;
          }
        });
        ctx.params = params;
        ctx.route = route.pattern;
        await route.handler(ctx);
        return true;
      }

      // The path exists but not for this verb: let the caller answer 405.
      ctx.methodMismatch = methodMismatch;
      return false;
    },
  };

  return router;
}
