/**
 * Hash routes: #/<view>?<params>. Changing filters replaces the history
 * entry; switching views and opening the viewer push one, so the back
 * button (and a phone's back gesture) closes the viewer or returns to the
 * previous view.
 */
export function parseHash(hash = location.hash) {
  const text = hash.replace(/^#\/?/, '');
  const [view, query = ''] = text.split('?');
  return { view: view || '', params: new URLSearchParams(query) };
}

export function buildHash(view, params) {
  const query = params.toString();
  return `#/${view}${query ? `?${query}` : ''}`;
}

export function createRouter(onChange) {
  let current = parseHash();

  const emit = () => {
    current = parseHash();
    onChange(current);
  };
  window.addEventListener('popstate', emit);
  window.addEventListener('hashchange', emit);

  return {
    get current() {
      return current;
    },
    /** Go to `view` with `params` (URLSearchParams). */
    go(view, params, { replace = false } = {}) {
      const hash = buildHash(view, params);
      if (hash === location.hash) return;
      if (replace) history.replaceState(history.state, '', hash);
      else history.pushState({ lurker: true }, '', hash);
      emit();
    },
    /** Change some parameters of the current view. */
    patch(changes, { replace = true } = {}) {
      const params = new URLSearchParams(current.params);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === undefined || value === '') params.delete(key);
        else params.set(key, String(value));
      }
      this.go(current.view, params, { replace });
    },
    back() {
      history.back();
    },
  };
}
