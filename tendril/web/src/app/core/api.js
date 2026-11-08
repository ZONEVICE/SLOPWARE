/**
 * The HTTP client for Tendril's API.
 *
 * - Sends the workspace id in `X-Tendril-Workspace` once a folder is open.
 * - `quiet: true` adds `X-Tendril-Quiet`, marking automatic requests (polls,
 *   refreshes) so they do not count as user activity on the server.
 * - Errors become `ApiError` with the server's machine code (`err.code`).
 * - A 401 means the session is gone (server restarted): reload to the login.
 * - A network failure is reported through `onConnectionLost`.
 */

export class ApiError extends Error {
  constructor(status, body = {}) {
    super(body.message || `HTTP ${status}`);
    this.status = status;
    this.code = body.error || 'http_error';
    this.data = body;
  }
}

let workspaceId = null;
let connectionListener = () => {};
let unauthorizedListener = () => window.location.reload();

/** Sets the workspace id sent with every request. */
export function setWorkspaceId(id) {
  workspaceId = id;
}

export function getWorkspaceId() {
  return workspaceId;
}

/** Called with `true` when a request fails at the network level. */
export function onConnectionChange(fn) {
  connectionListener = fn;
}

export function onUnauthorized(fn) {
  unauthorizedListener = fn;
}

async function request(method, path, { query, json, body, headers = {}, quiet = false, raw = false, signal } = {}) {
  const url = new URL(path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  const finalHeaders = { ...headers };
  if (workspaceId) finalHeaders['X-Tendril-Workspace'] = workspaceId;
  if (quiet) finalHeaders['X-Tendril-Quiet'] = '1';
  let payload = body;
  if (json !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  let response;
  try {
    response = await fetch(url, { method, headers: finalHeaders, body: payload, credentials: 'same-origin', signal });
  } catch (err) {
    if (err.name !== 'AbortError') connectionListener(false);
    throw new ApiError(0, { error: 'network', message: 'Cannot reach the Tendril server' });
  }
  connectionListener(true);
  if (response.status === 401) {
    unauthorizedListener();
    throw new ApiError(401, { error: 'unauthorized', message: 'Session expired' });
  }
  if (!response.ok) {
    let data = {};
    try {
      data = await response.json();
    } catch {
      /* not JSON */
    }
    throw new ApiError(response.status, data);
  }
  if (raw) return response;
  const type = response.headers.get('content-type') || '';
  return type.includes('application/json') ? response.json() : response.text();
}

export const api = {
  get: (path, options) => request('GET', path, options),
  post: (path, json, options = {}) => request('POST', path, { ...options, json }),
  patch: (path, json, options = {}) => request('PATCH', path, { ...options, json }),
  put: (path, body, options = {}) => request('PUT', path, { ...options, body }),
  raw: (method, path, options = {}) => request(method, path, { ...options, raw: true }),

  /** URL of a workspace file for <img>, <video>, <iframe> or a download. */
  fileUrl(path, { download = false } = {}) {
    const url = new URL('/api/fs/raw', window.location.origin);
    url.searchParams.set('ws', workspaceId || '');
    url.searchParams.set('path', path);
    if (download) url.searchParams.set('download', '1');
    return url.pathname + url.search;
  },
};
