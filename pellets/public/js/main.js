/**
 * CLIENT BOOTSTRAP.
 *
 * Boot order:
 *   1. GET /api/session  - the server has already read the client metadata and
 *      decided whether this is a new or a returning visitor; this call just
 *      reads the answer, plus the server-declared limits.
 *   2. Open the WebSocket - every live update travels over it from here on.
 *   3. Start the router   - mounts Home, a room, or Settings.
 *
 * This module is the ONLY place that translates socket frames into application
 * state. Views subscribe to state channels and never touch raw frames, except
 * for the room-scoped frames the room view handles itself.
 */
import { el, icon, render } from './core/dom.js';
import { fetchSession } from './core/api.js';
import { connect, onFrame } from './core/socket.js';
import { createRouter } from './core/router.js';
import { applyTheme, getTheme, storedTheme, toggleTheme } from './core/theme.js';
import { updateProfile } from './core/profile.js';
import {
  setSession,
  setLimits,
  setConnection,
  setRooms,
  upsertRoom,
  removeRoom,
  rememberUser,
  subscribe,
  isIdentified,
  state,
} from './core/state.js';
import { ROUTES, FALLBACK_VIEW } from './views/index.js';
import { toast } from './components/toast.js';
import { promptForIdentity } from './components/identity.js';

const outlet = document.getElementById('view');
const headerNode = document.getElementById('app-header');

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const CONNECTION_LABELS = { online: 'Live', connecting: 'Connecting', offline: 'Reconnecting' };

let router;

function renderHeader() {
  const route = router?.current?.name;
  const status = state.connection;

  render(
    headerNode,
    el(
      'a',
      { class: 'brand', href: '/', title: 'Pellets' },
      el('span', { class: 'brand-mark' }, icon('chat')),
      el('span', { text: 'Pellets' }),
    ),
    el('div', { class: 'header-spacer' }),
    el(
      'div',
      { class: 'header-actions' },
      el(
        'span',
        { class: 'conn-pill', dataset: { state: status }, title: `Realtime connection: ${status}` },
        el('span', { class: 'conn-dot' }),
        el('span', { class: 'conn-label', text: CONNECTION_LABELS[status] || status }),
      ),
      el(
        'button',
        {
          class: 'btn btn-ghost btn-icon',
          type: 'button',
          title: 'Toggle light or dark mode',
          'aria-label': 'Toggle light or dark mode',
          onClick: async () => {
            const theme = toggleTheme();
            renderHeader();
            try {
              await updateProfile({ theme });
            } catch {
              // Local preference already applied; syncing is a nicety.
            }
          },
        },
        icon(getTheme() === 'dark' ? 'sun' : 'moon'),
      ),
      el(
        'a',
        {
          class: 'btn btn-ghost btn-icon nav-btn',
          href: '/',
          title: 'Rooms',
          'aria-label': 'Rooms',
          'aria-current': route === 'home' ? 'page' : null,
        },
        icon('home'),
      ),
      el(
        'a',
        {
          class: 'btn btn-ghost btn-icon nav-btn',
          href: '/settings',
          title: 'Settings',
          'aria-label': 'Settings',
          'aria-current': route === 'settings' ? 'page' : null,
        },
        icon('settings'),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Socket frames -> application state
// ---------------------------------------------------------------------------

function wireFrames() {
  onFrame('session:state', (payload) => {
    setSession(payload.session);
  });

  onFrame('rooms:state', (payload) => setRooms(payload.rooms));
  onFrame('room:created', (payload) => upsertRoom(payload.room));
  onFrame('room:stats', (payload) => upsertRoom(payload.room));
  onFrame('room:deleted', (payload) => removeRoom(payload.roomId));

  // Keeps the live user directory fresh so renamed users repaint everywhere.
  onFrame('user:updated', (payload) => rememberUser(payload.user));

  // Errors that answer a specific request are surfaced by the caller's promise;
  // anything unsolicited is shown here so it is never silently swallowed.
  onFrame('error', (payload, frame) => {
    if (frame.replyTo) return;
    toast(payload.message || 'The server reported an error.', { tone: 'error' });
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  wireFrames();

  subscribe('connection', renderHeader);
  subscribe('session', renderHeader);

  // 1. Session + limits. The session itself already exists server side: it was
  //    created from the client metadata when this page was requested.
  try {
    const info = await fetchSession();
    setSession(info.session);
    setLimits(info.limits);

    // Theme precedence: an explicit local choice wins (it is what the inline
    // bootstrap already painted); otherwise follow the stored session, which
    // defaults to dark.
    const local = storedTheme();
    if (local) {
      if (info.session.theme !== local) updateProfile({ theme: local }).catch(() => {});
    } else {
      applyTheme(info.session.theme || 'dark');
    }
  } catch (error) {
    console.error('[boot] could not read the session', error);
    toast('Could not reach the server. Retrying…', { tone: 'error' });
  }

  // 2. Realtime.
  connect({ onState: setConnection });

  // 3. Routing.
  router = createRouter({
    outlet,
    routes: ROUTES,
    fallback: FALLBACK_VIEW,
    onNavigate: () => {
      renderHeader();
      // Move focus to the new view so keyboard and screen-reader users follow.
      outlet.focus({ preventScroll: true });
    },
  });

  renderHeader();
  router.start();

  // Picking a username is the only setup step; offer it right away, but let a
  // first-time visitor browse the room list without committing.
  if (!isIdentified() && router.current?.name === 'home') {
    promptForIdentity({ reason: 'Pick a username to start chatting. You can change it later.' }).catch(() => {});
  }
}

boot();
