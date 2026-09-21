/**
 * Profile updates, transport-agnostic.
 *
 * Prefers the WebSocket (instant, and the server broadcasts the change to every
 * other client for us) and falls back to the REST endpoint when the socket is
 * still connecting or has dropped. Both paths end in the same place: the server
 * is the only thing that decides what the session looks like.
 */
import { request, isOpen } from './socket.js';
import { sendJson } from './api.js';
import { setSession } from './state.js';

/**
 * @param {{ displayName?: string, colorHue?: number, theme?: 'dark'|'light' }} patch
 * @returns {Promise<object>} The updated private session view.
 */
export async function updateProfile(patch) {
  if (isOpen()) {
    const payload = await request('profile:update', patch);
    if (payload && payload.session) setSession(payload.session);
    return payload.session;
  }

  const body = await sendJson('/api/session', patch, 'PATCH');
  setSession(body.session);
  return body.session;
}
