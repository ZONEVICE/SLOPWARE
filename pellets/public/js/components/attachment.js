/**
 * Attachment rendering.
 *
 * Exactly the three behaviours the specification asks for:
 *   image -> inline preview, click opens it enlarged
 *   video -> inline preview with a play badge, click opens and plays it
 *   other -> a card showing the filename and its extension, click downloads it
 */
import { el, icon } from '../core/dom.js';
import { fileSize, extensionLabel, duration } from '../core/format.js';
import { openLightbox } from './lightbox.js';

/**
 * @param {{ id: string, name: string, kind: 'image'|'video'|'file', mime: string, size: number, url: string, downloadUrl: string }} attachment
 * @returns {HTMLElement}
 */
export function renderAttachment(attachment) {
  if (attachment.kind === 'image') return renderImage(attachment);
  if (attachment.kind === 'video') return renderVideo(attachment);
  return renderFile(attachment);
}

function renderImage(attachment) {
  const image = el('img', {
    src: attachment.url,
    alt: attachment.name,
    loading: 'lazy',
    decoding: 'async',
  });

  return el(
    'button',
    {
      class: 'media-thumb',
      type: 'button',
      title: `${attachment.name} · ${fileSize(attachment.size)}`,
      'aria-label': `Open image ${attachment.name}`,
      onClick: () => openLightbox(attachment),
    },
    image,
  );
}

function renderVideo(attachment) {
  // `preload="metadata"` is what makes the browser paint the first frame as a
  // poster and lets us read the duration without downloading the whole file.
  const video = el('video', {
    src: attachment.url,
    preload: 'metadata',
    muted: true,
    playsinline: true,
    tabindex: '-1',
  });

  const durationBadge = el('span', { class: 'media-duration', text: '' });
  video.addEventListener('loadedmetadata', () => {
    const label = duration(video.duration);
    if (label) durationBadge.textContent = label;
  });

  return el(
    'button',
    {
      class: 'media-thumb',
      type: 'button',
      title: `${attachment.name} · ${fileSize(attachment.size)}`,
      'aria-label': `Play video ${attachment.name}`,
      onClick: () => openLightbox(attachment),
    },
    video,
    el('span', { class: 'media-play' }, el('span', {}, icon('play'))),
    durationBadge,
  );
}

function renderFile(attachment) {
  const extension = extensionLabel(attachment.name);
  return el(
    'a',
    {
      class: 'file-card',
      // A direct link with `download` keeps middle-click and "save as" working;
      // the server also sends Content-Disposition: attachment for this URL.
      href: attachment.downloadUrl,
      download: attachment.name,
      'data-external': 'true',
      title: `Download ${attachment.name}`,
    },
    el('span', { class: 'file-ext' }, extension ? el('span', { text: extension }) : icon('file')),
    el(
      'span',
      { class: 'file-meta grow' },
      el('span', { class: 'file-name truncate', text: attachment.name }),
      el('span', { class: 'file-size', text: fileSize(attachment.size) }),
    ),
    el('span', { class: 'file-dl' }, icon('download')),
  );
}
