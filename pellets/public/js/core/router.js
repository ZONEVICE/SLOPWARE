/**
 * History API router.
 *
 * URLs are real paths (`/`, `/room/<uuid>`, `/settings`) so a room link can be
 * pasted into a chat and opened directly. The server falls back to index.html
 * for unknown non-file paths, which is what makes that work on a hard reload.
 *
 * A view is `(ctx) => ({ destroy?: () => void })`, where ctx carries `params`,
 * the `outlet` element and `navigate`.
 */

/** Compile `/room/:id` into a matcher. */
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

/**
 * @param {{ outlet: HTMLElement, routes: { pattern: string, view: Function, name?: string }[], fallback?: Function, onNavigate?: (info: object) => void }} options
 */
export function createRouter({ outlet, routes, fallback, onNavigate }) {
  const compiled = routes.map((route) => ({ ...route, ...compile(route.pattern) }));

  /** @type {{ destroy?: () => void }|null} */
  let active = null;
  /** @type {object|null} */
  let current = null;

  function match(pathname) {
    for (const route of compiled) {
      const result = route.regexp.exec(pathname);
      if (!result) continue;
      /** @type {Record<string,string>} */
      const params = {};
      route.keys.forEach((key, index) => {
        try {
          params[key] = decodeURIComponent(result[index + 1]);
        } catch {
          params[key] = result[index + 1];
        }
      });
      return { route, params };
    }
    return null;
  }

  /** Tear down the mounted view and mount the one for `pathname`. */
  function mount(pathname, options = {}) {
    if (active && typeof active.destroy === 'function') {
      try {
        active.destroy();
      } catch (error) {
        console.error('[router] view teardown failed', error);
      }
    }
    active = null;
    outlet.replaceChildren();

    const found = match(pathname);
    const view = found ? found.route.view : fallback;
    const params = found ? found.params : {};
    current = { pathname, name: found ? found.route.name : 'not-found', params };

    if (onNavigate) onNavigate({ ...current, ...options });
    if (!view) return;

    active = view({ params, outlet, navigate, path: pathname }) || null;
  }

  /**
   * Go to a path.
   * @param {string} path
   * @param {{ replace?: boolean }} [options]
   */
  function navigate(path, options = {}) {
    const target = new URL(path, window.location.origin);
    const next = target.pathname + target.search;
    const currentPath = window.location.pathname + window.location.search;

    if (next !== currentPath) {
      if (options.replace) window.history.replaceState({}, '', next);
      else window.history.pushState({}, '', next);
    }
    mount(target.pathname, options);
  }

  /** Intercept same-origin link clicks so navigation stays client side. */
  function handleClick(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = event.target.closest && event.target.closest('a[href]');
    if (!anchor) return;
    if (anchor.target && anchor.target !== '_self') return;
    if (anchor.hasAttribute('download') || anchor.dataset.external === 'true') return;

    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) return;

    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return;
    // Uploads and API paths are real server resources, not application routes.
    if (url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/api/')) return;

    event.preventDefault();
    navigate(url.pathname + url.search);
  }

  function start() {
    window.addEventListener('popstate', () => mount(window.location.pathname));
    document.addEventListener('click', handleClick);
    mount(window.location.pathname, { initial: true });
  }

  return {
    start,
    navigate,
    /** Re-run the current route, e.g. after identity is established. */
    refresh: () => mount(window.location.pathname, { refresh: true }),
    get current() {
      return current;
    },
  };
}
