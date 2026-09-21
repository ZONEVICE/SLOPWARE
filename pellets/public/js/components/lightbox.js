/**
 * Full-screen media viewer.
 *
 * Specification behaviour:
 *  - Clicking an image preview opens it at full size.
 *  - Clicking a video preview opens it and plays it with the browser's own
 *    native controls (no custom player, no library).
 *
 * Range requests are served by the backend, so seeking inside a large video
 * works exactly as it would for any static file.
 */
import { el, icon, on, disposer } from '../core/dom.js';
import { fileSize } from '../core/format.js';

const root = () => document.getElementById('lightbox-root');

/**
 * @param {{ id: string, name: string, url: string, downloadUrl: string, kind: string, mime: string, size: number }} attachment
 */
export function openLightbox(attachment) {
  const off = disposer();
  const previouslyFocused = document.activeElement;

  const media =
    attachment.kind === 'video'
      ? el('video', {
          src: attachment.url,
          controls: true,
          autoplay: true,
          playsinline: true,
          preload: 'metadata',
        })
      : el('img', { src: attachment.url, alt: attachment.name, decoding: 'async' });

  const closeButton = el(
    'button',
    { class: 'btn btn-icon', type: 'button', 'aria-label': 'Close viewer', onClick: () => close() },
    icon('close'),
  );

  const overlay = el(
    'div',
    { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': attachment.name },
    el(
      'div',
      { class: 'lightbox-bar' },
      el(
        'div',
        { class: 'grow truncate' },
        el('div', { class: 'lightbox-name truncate', text: attachment.name }),
        el('div', { class: 'lightbox-sub', text: `${attachment.mime} · ${fileSize(attachment.size)}` }),
      ),
      el(
        'a',
        {
          class: 'btn',
          href: attachment.downloadUrl,
          download: attachment.name,
          'data-external': 'true',
          title: 'Download',
        },
        icon('download'),
        el('span', { text: 'Download' }),
      ),
      closeButton,
    ),
    el('div', { class: 'lightbox-stage', onClick: (event) => event.target.classList.contains('lightbox-stage') && close() }, media),
  );

  function close() {
    off.dispose();
    // Stop playback before detaching so audio never outlives the overlay.
    if (media.tagName === 'VIDEO') {
      try {
        media.pause();
        media.removeAttribute('src');
        media.load();
      } catch {
        /* ignore */
      }
    }
    overlay.remove();
    if (previouslyFocused && document.contains(previouslyFocused)) {
      try {
        previouslyFocused.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
  }

  off(
    on(document, 'keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    }),
  );

  root().appendChild(overlay);
  requestAnimationFrame(() => closeButton.focus({ preventScroll: true }));
  return { close };
}
