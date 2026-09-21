/**
 * Extension <-> MIME mapping plus the "what kind of attachment is this"
 * classification used by the chat UI.
 *
 * Only the types the application actually serves are listed. Anything unknown
 * becomes `application/octet-stream`, which the UI renders as a downloadable
 * file card, exactly as the specification requires.
 */
const BY_EXTENSION = new Map(
  Object.entries({
    // Documents served to the browser to run the app itself.
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',

    // Images.
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.heic': 'image/heic',

    // Video.
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',

    // Audio (classified as "file", but still served with a useful type).
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.opus': 'audio/opus',

    // Fonts.
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',

    // Common binaries.
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.7z': 'application/x-7z-compressed',
    '.rar': 'application/vnd.rar',
  }),
);

export const DEFAULT_MIME = 'application/octet-stream';

/**
 * Lowercase extension including the dot, or "" when there is none.
 * @param {string} filename
 */
export function extname(filename) {
  const base = String(filename || '')
    .split(/[\\/]/)
    .pop();
  const index = base.lastIndexOf('.');
  if (index <= 0) return '';
  return base.slice(index).toLowerCase();
}

/**
 * MIME type for a filename.
 * @param {string} filename
 * @returns {string}
 */
export function lookupMime(filename) {
  return BY_EXTENSION.get(extname(filename)) || DEFAULT_MIME;
}

/**
 * Attachment class consumed by the client renderer.
 *
 * "image"  -> inline thumbnail, click opens the lightbox.
 * "video"  -> inline preview, click opens the lightbox with native controls.
 * "file"   -> name + extension card, click downloads.
 *
 * The declared MIME wins; the extension is only a fallback for clients that
 * upload with a generic or missing content type.
 * @param {{ mime?: string, name?: string }} attachment
 * @returns {'image'|'video'|'file'}
 */
export function classify({ mime, name } = {}) {
  const effective = (mime && mime !== DEFAULT_MIME ? mime : lookupMime(name || '')).toLowerCase();
  // SVG is an image, but an inline SVG is also a script container. It is served
  // with a restrictive CSP by the upload route, so previewing it is safe.
  if (effective.startsWith('image/')) return 'image';
  if (effective.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * Reverse lookup: a sensible extension for a MIME type. Used when a client
 * uploads a file whose name carries no extension at all.
 * @param {string} mime
 * @returns {string} Extension including the dot, or "".
 */
export function extensionForMime(mime) {
  const value = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!value || value === DEFAULT_MIME) return '';
  for (const [extension, candidate] of BY_EXTENSION) {
    if (candidate.split(';')[0].trim() === value) return extension;
  }
  return '';
}

/**
 * Sanitise an extension so it can never escape the uploads directory or carry
 * surprising characters into a filename.
 * @param {string} extension Including the leading dot.
 * @returns {string} A safe extension, or "".
 */
export function safeExtension(extension) {
  const value = String(extension || '').toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(value) ? value : '';
}

/** True when the type is safe to render inline instead of forcing a download. */
export function isInlineRenderable(mime) {
  const value = String(mime || '').toLowerCase();
  return value.startsWith('image/') || value.startsWith('video/') || value.startsWith('audio/');
}
