/**
 * The HTTP API. Every call sends and expects JSON; a 401 means the password
 * session is gone (the server restarted, or another tab locked Lurker), so
 * the page goes back to the login form.
 */

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function goToLogin() {
  const next = `${location.pathname}${location.hash}`;
  location.assign(`/login?next=${encodeURIComponent(next === '/' ? '/' : next)}`);
}

async function request(method, url, body) {
  const options = { method, credentials: 'same-origin', cache: 'no-store', headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new ApiError(0, 'offline', 'Lurker cannot be reached. Is it still running?');
  }
  if (response.status === 401) {
    goToLogin();
    throw new ApiError(401, 'auth_required', 'Enter the password first.');
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = (data && data.error) || {};
    throw new ApiError(response.status, error.code || 'http_error', error.message || `Request failed (${response.status}).`, error);
  }
  return data;
}

export const api = {
  state: () => request('GET', '/api/state'),
  checkPath: (path) => request('POST', '/api/paths/check', { path }),
  suggest: (path) => request('GET', `/api/paths/suggest?path=${encodeURIComponent(path)}`),
  open: (path) => request('POST', '/api/album/open', { path }),
  close: () => request('POST', '/api/album/close', {}),
  rescan: (album) => request('POST', '/api/album/rescan', { album }),
  delta: (album, since) => request('GET', `/api/album/delta?album=${encodeURIComponent(album)}&since=${since}`),
  details: (album, id) => request('GET', `/api/items/${encodeURIComponent(album)}/${id}`),
  logout: () => request('POST', '/api/auth/logout', {}),
};

function safeName(name) {
  try {
    return encodeURIComponent(name);
  } catch {
    return 'file';
  }
}

/** URL of an item's original file (inline, or as a download). */
export function mediaUrl(albumId, item, { download = false } = {}) {
  return `/media/${albumId}/${item.id}/${item.version}/${safeName(item.name)}${download ? '?download=1' : ''}`;
}

/** URL of an item's embedded JPEG preview (EXIF thumbnail or RAW preview). */
export function previewUrl(albumId, item) {
  return `/thumb/${albumId}/${item.id}/${item.version}`;
}
