/**
 * The control panel's HTTP client.
 *
 * Every mutation is sent as `application/json` (even an empty body): the
 * server requires it, which is part of what stops another website from
 * driving this panel through the user's browser.
 */

/** An error answered by the server: `{ error: { code, message } }`. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body) {
  const init = { method, headers: { Accept: 'application/json' }, cache: 'no-store' };
  if (method === 'POST' || method === 'PUT') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'offline', 'Reptile is not answering. Is the process still running?');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status, data?.error?.code || 'error', data?.error?.message || `Request failed (${response.status}).`);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  del: (path) => request('DELETE', path),
};
