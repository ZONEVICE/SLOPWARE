/**
 * VIEW REGISTRY.
 *
 * The three windows the specification describes, mapped to real URLs so a room
 * link can be shared and opened directly.
 *
 * TO ADD A WINDOW: write `public/js/views/<name>.js` exporting
 * `(ctx) => ({ destroy })` and add one entry here.
 */
import { homeView } from './home.js';
import { roomView } from './room.js';
import { settingsView } from './settings.js';
import { notFoundView } from './notFound.js';

export const ROUTES = [
  { pattern: '/', name: 'home', view: homeView },
  { pattern: '/room/:id', name: 'room', view: roomView },
  { pattern: '/settings', name: 'settings', view: settingsView },
];

export { notFoundView as FALLBACK_VIEW };
