/**
 * Keeps the store fed with server snapshots over server-sent events.
 *
 * EventSource reconnects by itself (the server asks for a 2 s retry). While it
 * is down, the store reports offline and the page shows a banner, so the user
 * never looks at stale state without knowing it.
 */
export function connectLive(store) {
  let source = null;

  const open = () => {
    source = new EventSource('/api/events');
    source.addEventListener('state', (event) => {
      try {
        store.set(JSON.parse(event.data));
        store.setOnline(true);
      } catch {
        /* a malformed frame is ignored; the next one replaces it */
      }
    });
    source.addEventListener('open', () => store.setOnline(true));
    source.addEventListener('error', () => {
      store.setOnline(false);
      // A closed source (e.g. the server answered 403) does not retry on its own.
      if (source.readyState === EventSource.CLOSED) setTimeout(open, 3000);
    });
  };

  open();
  return () => source?.close();
}
