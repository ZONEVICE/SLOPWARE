/**
 * Attachment endpoints.
 *
 * Upload flow used by the client:
 *   1. POST /api/uploads  ->  bytes stream to `uploads/`, JSON metadata comes back
 *   2. The upload id is attached to a `message:send` frame over the WebSocket
 *   3. Everyone in the room renders the attachment from the metadata snapshot
 *
 * Two request shapes are accepted:
 *   - `multipart/form-data` with one or more file parts (what the UI sends, so
 *     that XHR can report upload progress).
 *   - A raw body with `X-Pellets-Filename`, for scripts and `curl --data-binary`.
 *
 * Bytes never sit in memory: they stream from the socket to a temp file and are
 * renamed into place once complete.
 */
import { json, fail } from '../respond.js';
import { sendFile } from '../static.js';
import { MultipartParser, getBoundary, parseContentType, parseContentDisposition } from '../multipart.js';
import { errors } from '../../domain/errors.js';

/**
 * @param {object} router
 * @param {{ domain: object, config: object, logger?: object }} deps
 */
export default function uploadRoutes(router, { domain, config, logger }) {
  /**
   * Reject early when the declared length already exceeds the limit, so a huge
   * body is refused before a single byte is written to disk.
   */
  function assertDeclaredSize(req) {
    const declared = Number.parseInt(req.headers['content-length'] || '', 10);
    if (Number.isFinite(declared) && declared > config.uploads.maxBytes) {
      throw errors.payloadTooLarge(
        `Attachment exceeds the ${Math.floor(config.uploads.maxBytes / 1024 / 1024)} MB limit.`,
      );
    }
  }

  /** Consume a multipart body, storing every file part it contains. */
  function handleMultipart(ctx, boundary) {
    const { req } = ctx;
    return new Promise((resolve, reject) => {
      const parser = new MultipartParser(boundary, { maxParts: config.chat.maxAttachmentsPerMessage + 8 });
      /** @type {Promise<object>[]} */
      const pending = [];
      /** @type {import('node:stream').Readable[]} */
      const openParts = [];
      /** @type {Record<string,string>} */
      const fields = {};
      let aborted = false;

      const abort = (error) => {
        if (aborted) return;
        aborted = true;
        // Tear down parts still streaming to disk; their temp files are removed
        // by the upload service's own error path.
        for (const stream of openParts) stream.destroy(error);
        reject(error);
      };

      parser.on('field', ({ name, value }) => {
        if (name) fields[name] = value;
      });

      parser.on('part', (part) => {
        if (pending.length >= config.chat.maxAttachmentsPerMessage) {
          // Discard the extra part instead of wedging the parser.
          part.stream.resume();
          abort(errors.badRequest(`At most ${config.chat.maxAttachmentsPerMessage} files per request.`));
          return;
        }
        openParts.push(part.stream);
        const saving = domain.uploads.saveStream({
          stream: part.stream,
          filename: part.filename,
          mime: part.mime,
          ownerId: ctx.session.id,
        });
        // Absorb the rejection here so aborting the request never produces an
        // unhandled rejection; Promise.all below is what actually reports it.
        saving.catch(() => {});
        pending.push(saving);
      });

      parser.on('error', abort);
      parser.on('drain', () => req.resume());

      parser.on('finish', () => {
        if (aborted) return;
        Promise.all(pending)
          .then((uploads) => resolve({ uploads, fields }))
          .catch(abort);
      });

      req.on('data', (chunk) => {
        if (aborted) return;
        if (!parser.write(chunk)) req.pause();
      });
      req.once('error', abort);
      req.once('end', () => {
        if (!aborted) parser.end();
      });
    });
  }

  /** Consume a raw body as a single file. */
  async function handleRaw(ctx) {
    const { req } = ctx;
    const headerName = req.headers['x-pellets-filename'];
    const disposition = parseContentDisposition(req.headers['content-disposition'] || '');
    let filename = disposition.filename || '';
    if (!filename && headerName) {
      try {
        filename = decodeURIComponent(String(headerName));
      } catch {
        filename = String(headerName);
      }
    }
    if (!filename) throw errors.badRequest('Provide a filename via X-Pellets-Filename or Content-Disposition.');

    const upload = await domain.uploads.saveStream({
      stream: req,
      filename,
      mime: parseContentType(req.headers['content-type']).type,
      ownerId: ctx.session.id,
    });
    return { uploads: [upload], fields: {} };
  }

  /**
   * POST /api/uploads
   * Response: { uploads: [ { id, name, mime, kind, size, url, downloadUrl } ] }
   */
  router.post('/api/uploads', async (ctx) => {
    // Uploading is chatting: it needs the same single step, a username.
    domain.sessions.requireIdentified(ctx.session);
    assertDeclaredSize(ctx.req);

    const boundary = getBoundary(ctx.req.headers['content-type']);
    try {
      const { uploads, fields } = boundary ? await handleMultipart(ctx, boundary) : await handleRaw(ctx);
      if (uploads.length === 0) throw errors.badRequest('No file was provided.');
      logger?.debug?.('stored', uploads.length, 'upload(s) for session', ctx.session.id);
      json(ctx.res, 201, {
        uploads: uploads.map((upload) => domain.uploads.toView(upload)),
        // Echo any extra form fields so a caller can correlate the response.
        ...(fields.roomId ? { roomId: fields.roomId } : {}),
      });
    } catch (error) {
      // `Connection: close` tells Node to end the socket once the response has
      // been flushed, which both stops the client from streaming a body we have
      // already refused AND guarantees the status code arrives. Destroying the
      // request directly would race with the response and truncate it.
      fail(ctx.res, error, { logger, headers: { Connection: 'close' } });
    }
  });

  /**
   * GET /uploads/<storedName>
   *
   * Serves the raw file. `?download=1` forces a download with the original
   * filename, which is how a non-media attachment behaves when clicked.
   *
   * Files whose metadata was lost in a restart are still served (the bytes are
   * on disk); they are simply not listed anywhere, because no chat references
   * them any more.
   */
  router.get('/uploads/*', async (ctx) => {
    const storedName = ctx.params.wildcard || '';
    const info = await domain.uploads.statStored(storedName);
    if (!info) throw errors.uploadNotFound();

    const known = domain.uploads.getByStoredName(storedName);
    const wantsDownload = ctx.url.searchParams.has('download');
    const forced = wantsDownload || (known ? known.kind === 'file' : false);

    const served = await sendFile({
      req: ctx.req,
      res: ctx.res,
      path: info.path,
      mime: known?.mime || info.mime,
      // Stored names are UUIDs, so their content can never change.
      cacheControl: 'private, max-age=31536000, immutable',
      downloadName: forced ? known?.name || storedName : undefined,
      sandbox: true,
    });
    if (!served) throw errors.uploadNotFound();
  });
}
