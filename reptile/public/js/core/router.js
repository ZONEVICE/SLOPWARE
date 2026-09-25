/**
 * Hash router: `#/`, `#/host`, `#/sync?uuid=...`.
 *
 * A view is a factory `(ctx) => ({ el, destroy? })`. The router mounts one
 * view at a time and destroys the previous one, which is where views
 * unsubscribe from the store.
 */
export function createRouter({ routes, outlet, context }) {
  let current = null;

  const parse = () => {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, query = ''] = raw.split('?');
    return { path: path || '/', query: new URLSearchParams(query) };
  };

  const render = () => {
    const { path, query } = parse();
    const factory = routes[path] || routes['*'];
    current?.destroy?.();
    current = factory({ ...context, query, navigate });
    outlet.replaceChildren(current.el);
    outlet.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  };

  /** Go to a route; re-renders even when the hash does not change. */
  function navigate(hash) {
    if (location.hash === hash || (hash === '#/' && location.hash === '')) render();
    else location.hash = hash;
  }

  window.addEventListener('hashchange', render);
  return { start: render, navigate };
}
