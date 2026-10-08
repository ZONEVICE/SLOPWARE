/**
 * View registry.
 *
 * THIS IS THE LEGO BOARD of the client. A view is `(ctx) => ({ el, destroy? })`
 * where `ctx` holds the store, `navigate` and the hash query. To add a screen,
 * drop a file in this directory and add one line to ROUTES.
 */
import { homeView } from './home.js';
import { hostView } from './host.js';
import { syncView } from './sync.js';

export const ROUTES = {
  '/': homeView,
  '/host': hostView,
  '/sync': syncView,
  '*': homeView,
};
