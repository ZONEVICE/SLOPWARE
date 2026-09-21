/**
 * Upload service: attachments on disk, metadata in memory.
 *
 * The specification splits these two deliberately:
 *  - The BYTES go to `<app>/uploads/` and survive a restart.
 *  - The METADATA lives in memory and does not. After a restart an old file is
 *    still readable by its stored name, but it is listed nowhere, because the
 *    chat that referenced it is gone.
 *
 * Files are written to a hidden `.part` temp file and renamed into place only
 * once the whole body arrived, so a half-uploaded file is never served.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve, sep, basename } from 'node:path';
import { uuid4 } from '../lib/ids.js';
import { extname, safeExtension, extensionForMime, lookupMime, classify, DEFAULT_MIME } from '../lib/mime.js';
import { EVENTS } from '../lib/events.js';
import { errors } from './errors.js';

/**
 * @param {{ store: object, bus: object, config: object, logger?: object }} deps
 */
export function createUploadService({ store, bus, config, logger }) {
  const directory = resolve(config.uploadsDir);

  /** Create `uploads/` if it is not there yet. Called once at startup. */
  async function ensureDirectory() {
    await mkdir(directory, { recursive: true });
    return directory;
  }

  /**
   * Original filename cleanup. Only used for display and for picking an
   * extension; the name on disk is always a fresh UUID.
   */
  function normalizeName(value) {
    const raw = typeof value === 'string' ? value : '';
    const withoutPath = raw.split(/[\\/]/).pop() || '';
    const cleaned = withoutPath.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return cleaned.slice(0, 255) || 'file';
  }

  /**
   * Map a stored filename to an absolute path inside `uploads/`, or null when
   * the name is not something we are willing to serve.
   *
   * Path traversal is impossible here: `basename` drops every directory
   * component, and the resolved path is re-checked against the uploads root.
   * Dotfiles are rejected so in-flight `.part` files can never be downloaded.
   * @param {string} storedName
   * @returns {string|null}
   */
  function resolveStoredPath(storedName) {
    const name = basename(String(storedName || ''));
    if (!name || name === '.' || name === '..' || name.startsWith('.')) return null;
    if (name.includes('/') || name.includes('\\')) return null;
    const full = resolve(directory, name);
    if (full !== directory && !full.startsWith(directory + sep)) return null;
    return full;
  }

  /** Public projection embedded in messages and returned by the upload route. */
  function toView(upload) {
    return {
      id: upload.id,
      name: upload.name,
      mime: upload.mime,
      kind: upload.kind,
      size: upload.size,
      url: upload.url,
      // Same file, but served with Content-Disposition: attachment so that a
      // click on a non-media file downloads instead of navigating.
      downloadUrl: `${upload.url}?download=1`,
    };
  }

  /**
   * Stream a request body into `uploads/`.
   *
   * @param {object} input
   * @param {import('node:stream').Readable} input.stream Source of the bytes.
   * @param {string} input.filename Original client filename.
   * @param {string} [input.mime] Declared content type.
   * @param {string} input.ownerId Session that is uploading.
   * @param {number} [input.maxBytes] Override the configured limit.
   * @returns {Promise<object>} The stored upload record.
   */
  function saveStream({ stream, filename, mime, ownerId, maxBytes = config.uploads.maxBytes }) {
    return new Promise((resolvePromise, rejectPromise) => {
      const id = uuid4();
      const name = normalizeName(filename);

      // Extension priority: the client's filename, then the declared MIME type.
      const extension = safeExtension(extname(name)) || safeExtension(extensionForMime(mime));
      const storedName = `${id}${extension}`;
      const tempPath = join(directory, `.${id}.part`);
      const finalPath = join(directory, storedName);

      // Trust the declared type only when it is meaningful; otherwise derive it
      // from the extension, which is what the client renderer will see.
      const declared = String(mime || '').split(';')[0].trim().toLowerCase();
      const effectiveMime = declared && declared !== DEFAULT_MIME ? declared : lookupMime(name);

      const out = createWriteStream(tempPath, { mode: 0o644 });
      let size = 0;
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        stream.unpipe?.(out);
        out.destroy();
        // Keep draining the source. A multipart part stream that nobody reads
        // would stall the whole parser, and the caller still needs to reach the
        // end of the request to send its error response.
        stream.resume?.();
        // Reject only AFTER the partial file is gone, so a caller that handles
        // the failure can rely on `uploads/` being clean.
        rm(tempPath, { force: true })
          .catch(() => {})
          .finally(() => rejectPromise(error));
      };

      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          fail(errors.payloadTooLarge(`Attachment exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`));
        }
      });
      stream.on('error', fail);
      out.on('error', fail);

      out.on('finish', async () => {
        if (settled) return;
        if (size === 0) {
          settled = true;
          await rm(tempPath, { force: true }).catch(() => {});
          rejectPromise(errors.badRequest('Attachment is empty.'));
          return;
        }
        try {
          await rename(tempPath, finalPath);
        } catch (error) {
          fail(error);
          return;
        }
        settled = true;

        const upload = {
          id,
          storedName,
          name,
          mime: effectiveMime,
          kind: classify({ mime: effectiveMime, name }),
          size,
          url: `${config.uploads.urlPrefix}${storedName}`,
          ownerId,
          createdAt: Date.now(),
          attached: false,
        };
        store.uploads.insert(upload);
        logger?.debug?.('upload stored', storedName, size, 'bytes');
        bus.emit(EVENTS.UPLOAD_STORED, { upload });
        resolvePromise(upload);
      });

      stream.pipe(out);
    });
  }

  /** Flag an upload as referenced by a message. Purely informational. */
  function markAttached(id) {
    const upload = store.uploads.get(id);
    if (upload && !upload.attached) store.uploads.update(id, { attached: true });
    return upload;
  }

  /**
   * File metadata straight from disk, for serving a stored name that the
   * in-memory index no longer knows about (e.g. after a restart).
   * @param {string} storedName
   */
  async function statStored(storedName) {
    const path = resolveStoredPath(storedName);
    if (!path) return null;
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      return { path, size: info.size, mtimeMs: info.mtimeMs, mime: lookupMime(storedName) };
    } catch {
      return null;
    }
  }

  return {
    directory,
    ensureDirectory,
    saveStream,
    markAttached,
    toView,
    resolveStoredPath,
    statStored,
    normalizeName,
    get: (id) => store.uploads.get(id),
    getByStoredName: (storedName) => store.uploads.getByStoredName(storedName),
  };
}
