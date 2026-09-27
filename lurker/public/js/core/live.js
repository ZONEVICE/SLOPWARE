/**
 * The server-sent event stream: the album status, pushed whenever it changes.
 * EventSource reconnects by itself; when it cannot, a plain request tells a
 * lost password session (401: back to the login page) from a stopped server.
 */
import { api } from './api.js';

export function connectLive({ onState, onConnection }) {
  let source = null;
  let closed = false;
  let retryTimer = 0;
  let downSince = 0;

  const open = () => {
    if (closed) return;
    source = new EventSource('/api/events');
    source.addEventListener('state', (event) => {
      downSince = 0;
      onConnection(true);
      try {
        onState(JSON.parse(event.data));
      } catch (error) {
        console.error('Bad state event', error);
      }
    });
    source.addEventListener('open', () => {
      downSince = 0;
      onConnection(true);
    });
    source.addEventListener('error', () => {
      if (!downSince) downSince = Date.now();
      if (source.readyState === EventSource.CLOSED) {
        onConnection(false);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(recover, 2000);
      } else if (Date.now() - downSince > 1500) {
        onConnection(false);
      } else {
        setTimeout(() => {
          if (downSince && source && source.readyState !== EventSource.OPEN) onConnection(false);
        }, 1600);
      }
    });
  };

  const recover = async () => {
    if (closed) return;
    try {
      const state = await api.state(); // a 401 here redirects to the login page
      onState(state.album);
      open();
    } catch {
      retryTimer = setTimeout(recover, 3000);
    }
  };

  open();
  return {
    close() {
      closed = true;
      clearTimeout(retryTimer);
      if (source) source.close();
    },
  };
}
