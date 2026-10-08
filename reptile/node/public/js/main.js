/**
 * Client bootstrap: one store fed by server-sent events, the status bar, and
 * the hash router that mounts one view at a time.
 */
import { mountStatusBar } from './components/statusBar.js';
import { connectLive } from './core/live.js';
import { createRouter } from './core/router.js';
import { createStore } from './core/store.js';
import { ROUTES } from './views/index.js';

const store = createStore();
mountStatusBar(document.getElementById('statusbar'), store);
connectLive(store);

// Views need the first snapshot (mode, identity) before they can render.
const router = createRouter({ routes: ROUTES, outlet: document.getElementById('view'), context: { store } });
const unsubscribe = store.subscribe(() => {
  unsubscribe();
  router.start();
});
