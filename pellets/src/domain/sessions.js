/**
 * Session service: identity, username and colour.
 *
 * Rules from the specification:
 *  - Hitting the site creates a session automatically from the client metadata;
 *    a returning client gets the session it already had.
 *  - The UUID v4 is permanent and cannot be changed.
 *  - Picking a username is the ONLY step required to use the chat, and there is
 *    no restriction on what that username may be.
 *  - A colour is assigned at random the moment the username is first chosen.
 */
import { uuid4 } from '../lib/ids.js';
import { randomHue, normalizeHue, hueToHex } from '../lib/colors.js';
import { EVENTS } from '../lib/events.js';
import { errors } from './errors.js';

/**
 * @param {{ store: object, bus: object, config: object, logger?: object }} deps
 */
export function createSessionService({ store, bus, config, logger }) {
  const limits = config.chat;

  /**
   * Normalise a username. The only rule is "not empty once trimmed"; every
   * character, including emoji and duplicates of an existing name, is allowed.
   * @param {unknown} value
   * @returns {string}
   */
  function normalizeDisplayName(value) {
    if (typeof value !== 'string') throw errors.badRequest('Username must be text.');
    const trimmed = value.trim();
    if (!trimmed) throw errors.badRequest('Username cannot be empty.');
    // Length is a memory safety bound, not a content restriction.
    if ([...trimmed].length > limits.maxDisplayNameLength) {
      throw errors.badRequest(`Username cannot exceed ${limits.maxDisplayNameLength} characters.`);
    }
    // Control characters would break the layout; whitespace runs collapse.
    return trimmed.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ');
  }

  /** Build a brand new session record. */
  function create({ fingerprint = null, userAgent = '' } = {}) {
    const now = Date.now();
    const session = {
      id: uuid4(),
      displayName: null, // set later, when the client picks a username
      colorHue: null, // assigned together with the username
      theme: 'dark', // the specification asks for dark mode by default
      fingerprint,
      userAgent: String(userAgent || '').slice(0, 512),
      createdAt: now,
      lastSeenAt: now,
    };
    store.sessions.insert(session);
    bus.emit(EVENTS.SESSION_CREATED, { session });
    logger?.debug?.('session created', session.id);
    return session;
  }

  /**
   * Resolve the session for an incoming request.
   *
   * Order of resolution:
   *   1. The session cookie, when it points at a live session.
   *   2. The client-metadata fingerprint, which recovers the session of a
   *      client whose cookie was dropped.
   *   3. A brand new session.
   *
   * @param {{ sessionId?: string|null, fingerprint?: string|null, userAgent?: string }} input
   * @returns {{ session: object, created: boolean, matchedBy: 'cookie'|'fingerprint'|'new' }}
   */
  function resolve({ sessionId = null, fingerprint = null, userAgent = '' } = {}) {
    const byCookie = sessionId ? store.sessions.get(sessionId) : undefined;
    if (byCookie) {
      store.sessions.touch(byCookie.id);
      return { session: byCookie, created: false, matchedBy: 'cookie' };
    }

    if (config.session.fingerprintEnabled && fingerprint) {
      const byFingerprint = store.sessions.getByFingerprint(fingerprint);
      if (byFingerprint) {
        store.sessions.touch(byFingerprint.id);
        return { session: byFingerprint, created: false, matchedBy: 'fingerprint' };
      }
    }

    return { session: create({ fingerprint, userAgent }), created: true, matchedBy: 'new' };
  }

  /**
   * Apply a profile change.
   *
   * The UUID is never touched. Picking a username for the first time also
   * assigns the random colour required by the specification.
   *
   * @param {string} sessionId
   * @param {{ displayName?: string, colorHue?: number|string, theme?: string }} patch
   * @returns {{ session: object, changed: string[] }}
   */
  function updateProfile(sessionId, patch = {}) {
    const session = store.sessions.get(sessionId);
    if (!session) throw errors.notFound('Session not found.');

    /** @type {Record<string, any>} */
    const next = {};
    const changed = [];

    if (patch.displayName !== undefined) {
      const name = normalizeDisplayName(patch.displayName);
      if (name !== session.displayName) {
        next.displayName = name;
        changed.push('displayName');
      }
      // First username ever => assign a random colour. Hues already taken by
      // other users are passed in so the new one actually stands out.
      if (session.colorHue === null || session.colorHue === undefined) {
        const taken = store.sessions
          .all()
          .filter((other) => other.id !== sessionId && other.colorHue !== null)
          .map((other) => other.colorHue);
        next.colorHue = randomHue(taken);
        changed.push('colorHue');
      }
    }

    if (patch.colorHue !== undefined) {
      const hue = normalizeHue(patch.colorHue);
      if (hue === null) throw errors.badRequest('Colour must be a hue between 0 and 359.');
      if (hue !== session.colorHue) {
        next.colorHue = hue;
        if (!changed.includes('colorHue')) changed.push('colorHue');
      }
    }

    if (patch.theme !== undefined) {
      const theme = patch.theme === 'light' ? 'light' : 'dark';
      if (theme !== session.theme) {
        next.theme = theme;
        changed.push('theme');
      }
    }

    if (changed.length === 0) return { session, changed };

    next.lastSeenAt = Date.now();
    const updated = store.sessions.update(sessionId, next);
    bus.emit(EVENTS.SESSION_UPDATED, { session: updated, changed });
    return { session: updated, changed };
  }

  /** A session may chat only once it has a username. */
  function isIdentified(session) {
    return Boolean(session && typeof session.displayName === 'string' && session.displayName.length > 0);
  }

  /** Throw the standard error when the caller has not picked a username yet. */
  function requireIdentified(session) {
    if (!isIdentified(session)) throw errors.identityRequired();
    return session;
  }

  /**
   * The representation sent to the owning client. Includes preferences that
   * other users never see.
   */
  function toPrivateView(session) {
    return {
      id: session.id,
      displayName: session.displayName,
      colorHue: session.colorHue,
      colorHex: session.colorHue === null ? null : hueToHex(session.colorHue),
      theme: session.theme,
      identified: isIdentified(session),
      createdAt: session.createdAt,
    };
  }

  /** The representation other users see: identity and colour only. */
  function toPublicView(session) {
    if (!session) return null;
    return {
      id: session.id,
      displayName: session.displayName,
      colorHue: session.colorHue,
    };
  }

  /**
   * Re-key a session's client-metadata fingerprint.
   *
   * Called by the HTTP layer when a returning client's metadata changed (a
   * browser update, a new IP). Rewriting through the store keeps the secondary
   * fingerprint index consistent.
   * @param {string} sessionId
   * @param {string} fingerprint
   */
  function setFingerprint(sessionId, fingerprint) {
    const session = store.sessions.get(sessionId);
    if (!session || session.fingerprint === fingerprint) return session || null;
    return store.sessions.update(sessionId, { fingerprint });
  }

  return {
    create,
    resolve,
    updateProfile,
    normalizeDisplayName,
    isIdentified,
    requireIdentified,
    toPrivateView,
    toPublicView,
    setFingerprint,
    get: (id) => store.sessions.get(id),
    getByFingerprint: (fingerprint) => store.sessions.getByFingerprint(fingerprint),
    all: () => store.sessions.all(),
  };
}
