/**
 * What this browser can show. The format table says "yes", "no" or "maybe";
 * a "maybe" image format (HEIC, TIFF, JPEG XL) is tried on the first file and
 * the answer is remembered for the rest of the page's life. Videos are asked
 * with canPlayType, including the codec the server found in the file.
 */
const imageFormats = new Map(); // format key -> true | false
const failedItems = new Set(); // "album:id:version" of files that failed to load
export const supportEvents = new EventTarget();

const probeVideo = document.createElement('video');

// Codec names from the server -> RFC 6381 strings canPlayType understands.
const CODECS = {
  avc1: 'avc1.42E01E', avc3: 'avc1.42E01E', h264: 'avc1.42E01E',
  hvc1: 'hvc1.1.6.L93.B0', hev1: 'hev1.1.6.L93.B0', hevc: 'hvc1.1.6.L93.B0',
  av01: 'av01.0.05M.08', av1: 'av01.0.05M.08',
  vp09: 'vp09.00.10.08', vp9: 'vp9', vp08: 'vp8', vp8: 'vp8',
  mp4v: 'mp4v.20.8', mpeg4: 'mp4v.20.8', theora: 'theora',
};

export function canShowImage(format) {
  if (format.browser === 'yes') return true;
  if (format.browser === 'no') return false;
  return imageFormats.get(format.key) !== false;
}

export function reportImage(format, worked) {
  if (format.browser !== 'maybe' || imageFormats.get(format.key) === worked) return;
  if (imageFormats.get(format.key) === true && !worked) return; // one broken file does not condemn the format
  imageFormats.set(format.key, worked);
  supportEvents.dispatchEvent(new Event('change'));
}

export function canPlayVideo(item) {
  const format = item.format;
  if (format.browser === 'no') return false;
  // Chrome answers "" for video/quicktime yet plays H.264 .mov files: ask as MP4.
  const container = ['mov', '3gp', 'mp4'].includes(format.key) ? 'video/mp4' : format.key === 'mkv' ? 'video/webm' : format.mime;
  const codec = item.codec ? CODECS[item.codec.toLowerCase()] : null;
  if (codec) return probeVideo.canPlayType(`${container}; codecs="${codec}"`) !== '';
  if (format.browser === 'yes') return true;
  return probeVideo.canPlayType(container) !== '' || format.key === 'mov';
}

export function itemKey(albumId, item) {
  return `${albumId}:${item.id}:${item.version}`;
}

export function markFailed(albumId, item) {
  failedItems.add(itemKey(albumId, item));
}

export function hasFailed(albumId, item) {
  return failedItems.has(itemKey(albumId, item));
}

/** Can this item be looked at in this browser (original or embedded preview)? */
export function isViewable(albumId, item) {
  if (hasFailed(albumId, item)) return item.preview > 0;
  if (item.kind === 'video') return canPlayVideo(item);
  return canShowImage(item.format) || item.preview === 2;
}
