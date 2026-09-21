/**
 * HTTP client.
 *
 * Almost everything in Pellets travels over the WebSocket; HTTP is used for the
 * initial session probe and for attachment uploads, which need a real request
 * body and upload progress.
 */

/** Error carrying the server's machine-readable code. */
export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code || 'error';
    this.status = status || 0;
  }
}

/**
 * @param {Response} response
 * @returns {Promise<any>}
 */
async function unwrap(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const error = body && body.error ? body.error : {};
    throw new ApiError(error.message || `Request failed (${response.status})`, error.code, response.status);
  }
  return body;
}

/** GET a JSON endpoint. */
export async function getJson(path) {
  return unwrap(await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin' }));
}

/** Send a JSON body with any method. */
export async function sendJson(path, body, method = 'POST') {
  return unwrap(
    await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    }),
  );
}

/**
 * Upload one file with progress reporting.
 *
 * XMLHttpRequest rather than fetch: only XHR exposes upload progress events,
 * and a 300 MB video needs a progress bar.
 *
 * @param {File} file
 * @param {{ onProgress?: (fraction: number) => void, roomId?: string }} [options]
 * @returns {{ promise: Promise<object>, abort: () => void }}
 */
export function uploadFile(file, options = {}) {
  const xhr = new XMLHttpRequest();

  const promise = new Promise((resolve, reject) => {
    const form = new FormData();
    if (options.roomId) form.append('roomId', options.roomId);
    form.append('file', file, file.name);

    xhr.open('POST', '/api/uploads');
    xhr.responseType = 'text';
    xhr.withCredentials = true;

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable || !options.onProgress) return;
      options.onProgress(event.loaded / event.total);
    });

    xhr.addEventListener('load', () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText || 'null');
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body && body.uploads && body.uploads[0]) {
        if (options.onProgress) options.onProgress(1);
        resolve(body.uploads[0]);
        return;
      }
      const error = body && body.error ? body.error : {};
      reject(new ApiError(error.message || `Upload failed (${xhr.status})`, error.code, xhr.status));
    });

    xhr.addEventListener('error', () => reject(new ApiError('Upload failed: network error.', 'network', 0)));
    xhr.addEventListener('abort', () => reject(new ApiError('Upload cancelled.', 'aborted', 0)));

    xhr.send(form);
  });

  return { promise, abort: () => xhr.abort() };
}

/** The session probe the app performs on boot. */
export function fetchSession() {
  return getJson('/api/session');
}
