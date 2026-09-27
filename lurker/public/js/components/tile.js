/**
 * One media tile. Images show the original file, preceded by the embedded
 * EXIF thumbnail when there is one (it arrives in milliseconds, the photo a
 * moment later). Videos show a frame captured in the browser (core/posters).
 * Anything this browser cannot draw gets a placeholder naming the format.
 */
import { mediaUrl, previewUrl } from '../core/api.js';
import { h } from '../core/dom.js';
import { duration as formatDuration } from '../core/format.js';
import { icon } from '../core/icons.js';
import { requestPoster } from '../core/posters.js';
import { canPlayVideo, canShowImage, hasFailed, itemKey, markFailed, reportImage } from '../core/support.js';

const RAW_FORMATS = new Set(['raw', 'raf', 'cr3']);
const START_DELAY = 60; // ms a tile must stay mounted before its image is requested

/*
 * The virtual list keeps rows well beyond the screen. Video tiles tell the
 * poster queue whether they are actually visible, so what the user is looking
 * at is captured first.
 */
const watchers = new Map(); // element -> (visible) => void
const observer =
  typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) watchers.get(entry.target)?.(entry.isIntersecting);
      })
    : null;

function watchVisibility(el, callback) {
  if (!observer) {
    callback(true);
    return () => {};
  }
  watchers.set(el, callback);
  observer.observe(el);
  return () => {
    watchers.delete(el);
    observer.unobserve(el);
  };
}

/** Which URLs to show for an image: { first, full } (either may be null). */
export function imageSources(albumId, item) {
  if (canShowImage(item.format) && !hasFailed(albumId, item)) {
    return { first: item.preview === 1 ? previewUrl(albumId, item) : null, full: mediaUrl(albumId, item) };
  }
  if (item.preview) return { first: null, full: previewUrl(albumId, item) };
  return { first: null, full: null };
}

/**
 * @param {object} item
 * @param {{ albumId: string, open: (item) => void, onFailure?: () => void }} context
 * @param {{ width: number, height: number, small?: boolean, interactive?: boolean }} size
 *   `interactive: false` makes a plain picture (a folder card's cover), not a button.
 */
export function createTile(item, context, { width, height, small = false, interactive = true }) {
  const { albumId } = context;
  const el = interactive
    ? h('button', {
        type: 'button',
        class: `tile tile-${item.kind}`,
        title: item.name,
        'aria-label': `${item.kind === 'video' ? 'Video' : 'Image'}: ${item.name}`,
        dataset: { id: item.id },
      })
    : h('span', { class: `tile tile-${item.kind}`, 'aria-hidden': 'true' });
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  if (interactive) el.addEventListener('click', () => context.open(item));

  const releases = [];
  const placeholder = (reason) => {
    el.querySelector('.tile-img')?.remove();
    el.querySelector('.tile-placeholder')?.remove();
    el.classList.remove('loading');
    const glyph = item.kind === 'video' ? 'film' : reason === 'broken' ? 'image-off' : 'image';
    el.prepend(
      h(
        'span',
        { class: 'tile-placeholder', title: reason === 'unsupported' ? `This browser cannot show ${item.format.label} files` : null },
        icon(glyph, { size: small ? 18 : 28 }),
        h('span', { class: 'format', text: (item.ext || item.format.key).toUpperCase() }),
        width >= 120 ? h('span', { class: 'file-name', text: item.name }) : null,
      ),
    );
  };

  let released = false;
  const image = (src, onFail) => {
    const img = h('img', { class: 'tile-img', alt: '', decoding: 'async', draggable: 'false' });
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => released || onFail(), { once: true });
    img.src = src;
    el.querySelector('.tile-placeholder')?.remove();
    el.prepend(img);
    return img;
  };

  if (item.kind === 'image') {
    const { first, full } = imageSources(albumId, item);
    const load = () => {
      el.classList.remove('loading');
      if (first && !small) {
        // Embedded thumbnail now, the real photo when it has been decoded.
        const img = image(first, () => {});
        const upgrade = new Image();
        upgrade.decoding = 'async';
        upgrade.src = full;
        upgrade
          .decode()
          .then(() => {
            if (released || !img.isConnected) return;
            img.src = full;
            reportImage(item.format, true);
          })
          .catch(() => {
            if (released) return;
            if (!upgrade.complete || upgrade.naturalWidth === 0) {
              markFailed(albumId, item);
              reportImage(item.format, false);
            }
          });
        releases.push(() => upgrade.removeAttribute('src'));
      } else {
        const src = small && first ? first : full;
        image(src, () => {
          markFailed(albumId, item);
          if (src === full && item.format.browser === 'maybe') reportImage(item.format, false);
          if (item.preview && src !== previewUrl(albumId, item)) image(previewUrl(albumId, item), () => placeholder('broken'));
          else placeholder('broken');
          context.onFailure?.();
        }).addEventListener('load', () => reportImage(item.format, true), { once: true });
      }
    };
    if (!full) {
      placeholder('unsupported');
    } else {
      // Rows fly past during a fast scroll; only tiles that stay a moment start downloading.
      placeholder('pending');
      el.classList.add('loading');
      const timer = setTimeout(load, START_DELAY);
      releases.push(() => clearTimeout(timer));
    }
    if (item.animated) el.append(badges([badge(item.format.key === 'gif' ? 'GIF' : 'ANIM')]));
    else if (RAW_FORMATS.has(item.format.key)) el.append(badges([badge('RAW')]));
  } else {
    placeholder('pending');
    const playable = canPlayVideo(item) && !hasFailed(albumId, item);
    if (playable) {
      el.classList.add('loading');
      const request = requestPoster(itemKey(albumId, item), mediaUrl(albumId, item), item.duration, (poster) => {
        el.classList.remove('loading');
        if (poster) image(poster.url, () => placeholder('broken'));
        else {
          markFailed(albumId, item);
          placeholder('unsupported');
          el.querySelector('.tile-play')?.remove();
        }
      });
      const stopWatching = watchVisibility(el, request.setVisible);
      releases.push(() => {
        stopWatching();
        request.cancel();
      });
    } else {
      el.querySelector('.tile-placeholder').title = `This browser cannot play ${item.format.label} files`;
    }
    if (!small && interactive && playable) el.append(h('span', { class: 'tile-play' }, h('span', {}, icon('play', { size: 18 }))));
    if (item.duration) el.append(badges([badge(formatDuration(item.duration))]));
  }
  if (!small && interactive) el.append(h('span', { class: 'tile-caption', text: item.name }));
  el.release = () => {
    released = true;
    releases.forEach((release) => release());
    // Abort downloads still in flight: a removed <img> keeps loading otherwise.
    for (const img of el.querySelectorAll('img')) img.removeAttribute('src');
  };
  return el;
}

function badges(children) {
  return h('span', { class: 'tile-badges' }, children);
}

function badge(text) {
  return h('span', { class: 'tile-badge', text });
}

/** Stop the pending work (poster capture, upgrades) of every tile inside `el`. */
export function releaseTiles(el) {
  for (const tile of el.querySelectorAll('.tile')) tile.release?.();
}
