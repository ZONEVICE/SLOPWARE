/**
 * localStorage, wrapped: every access may throw (private windows, blocked
 * storage, quota) and must never break the editor. Only per-browser
 * conveniences live here - the theme, panel sizes, open tabs. Settings that
 * matter live in ~/.tendril/settings.json on the server.
 */
const PREFIX = 'tendril.';

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* storage unavailable: the preference is simply not remembered */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  },
};

/** Same API over sessionStorage (per browser tab). */
export const sessionStore = {
  get(key, fallback = null) {
    try {
      const raw = sessionStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
  remove(key) {
    try {
      sessionStorage.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  },
};
