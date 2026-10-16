import { STORAGE_KEYS } from './store.js';

/**
 * The OpenRouter API key is a per-browser secret, kept apart from the
 * configuration on purpose: it never enters chat or job snapshots, the saved
 * workspace, or configuration exports, so sharing an export never leaks it.
 *
 * "Remember on this device" keeps it in localStorage (survives restarts);
 * otherwise it lives in sessionStorage and disappears when the tab closes.
 * Only one of the two holds it at a time. Neither is encrypted: scripts on the
 * same origin and anyone with access to the browser profile can read it.
 * When storage refuses the write, the key stays in memory for this page.
 */
const KEY = STORAGE_KEYS.openrouterKey;

/** Clean a pasted key and reject values that cannot be an HTTP header. */
export function normalizeApiKey(raw) {
  if (typeof raw !== 'string') throw new Error('The API key must be text.');
  const key = raw.trim().replace(/^Bearer\s+/i, '').trim();
  if (!key) throw new Error('Paste an OpenRouter API key first.');
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new Error('The API key contains spaces, line breaks, or characters an API key cannot have. Copy it again from your OpenRouter key list.');
  }
  if (key.length > 512) throw new Error('The API key is too long to be an OpenRouter key.');
  return key;
}

/** OpenRouter keys start with sk-or-. Others are usually another vendor's. */
export function looksLikeOpenRouterKey(key) { return /^sk-or-/.test(key); }

/** Show enough of a key to recognise it without revealing it. */
export function maskApiKey(key) {
  if (!key) return '';
  return key.length > 16 ? `${key.slice(0, 9)}…${key.slice(-4)}` : '•'.repeat(key.length);
}

export function createCredentials(options = {}) {
  const pick = name => {
    try { return Object.hasOwn(options, name) ? options[name] : globalThis[name]; }
    catch { return null; }
  };
  const local = pick('localStorage'), session = pick('sessionStorage');
  let memory = '';
  const read = storage => { try { return storage?.getItem(KEY) || ''; } catch { return ''; } };
  const remove = storage => { try { storage?.removeItem(KEY); } catch { /* Nothing to remove. */ } };
  const write = (storage, value) => {
    try { if (!storage) return false; storage.setItem(KEY, value); return storage.getItem(KEY) === value; }
    catch { return false; }
  };
  return {
    /** The key to send, or '' when none is set. */
    get openRouterKey() { return read(session) || read(local) || memory; },
    /** 'device', 'session', 'memory', or '' when no key is set. */
    get persistence() { return read(local) ? 'device' : read(session) ? 'session' : memory ? 'memory' : ''; },
    /**
     * Save a key; returns where it was kept. Throws for an invalid key.
     * Writing one place clears the other so "forget" really forgets.
     */
    setOpenRouterKey(raw, remember = false) {
      const key = normalizeApiKey(raw);
      memory = '';
      remove(remember ? session : local);
      if (write(remember ? local : session, key)) return remember ? 'device' : 'session';
      remove(remember ? local : session);
      memory = key;
      return 'memory';
    },
    clearOpenRouterKey() { memory = ''; remove(local); remove(session); },
  };
}
