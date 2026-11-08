/**
 * The server-side settings (~/.tendril/settings.json) as the browser sees
 * them. Loaded once, changed with JSON merge patches; every change is
 * announced on the bus as `settings:changed` with the new object.
 */
import { api } from './api.js';

export function createSettings(bus) {
  let current = {};
  let meta = {};
  return {
    async load() {
      const result = await api.get('/api/settings');
      current = result.settings;
      meta = result.meta;
      return current;
    },
    /** The whole settings object (read-only by convention). */
    get all() {
      return current;
    },
    get meta() {
      return meta;
    },
    /** A value by dotted path, e.g. `editor.font_size`. */
    get(path, fallback) {
      let value = current;
      for (const part of path.split('.')) value = value?.[part];
      return value === undefined ? fallback : value;
    },
    /** Applies a merge patch on the server; resolves with the new settings. */
    async patch(patch) {
      const result = await api.patch('/api/settings', patch);
      current = result.settings;
      meta = result.meta;
      bus.emit('settings:changed', current, patch);
      return current;
    },
    /** Builds the nested patch for a dotted path. */
    set(path, value) {
      const patch = {};
      let cursor = patch;
      const parts = path.split('.');
      parts.slice(0, -1).forEach((part) => {
        cursor[part] = {};
        cursor = cursor[part];
      });
      cursor[parts[parts.length - 1]] = value;
      return this.patch(patch);
    },
  };
}
