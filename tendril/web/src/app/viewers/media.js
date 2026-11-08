/**
 * Built-in viewers for files that are not edited as text: images (with zoom
 * and a transparency checkerboard), video and audio (native players; the
 * server answers Range requests so seeking does not download everything),
 * PDF (the browser's own viewer in a frame) and a card for binary or
 * too-large files with a download button.
 *
 * Media are always loaded from /api/fs/raw, which serves them with their real
 * content type and never as active content under Tendril's origin.
 */
import { api } from '../core/api.js';
import { h, iconButton } from '../core/dom.js';
import { bytes } from '../core/format.js';
import { icon } from '../core/icons.js';
import { fileIcon } from '../core/languages.js';
import { extname } from '../core/paths.js';

/** Renders the viewer for `doc` into `pane`. */
export function renderViewer(app, doc, pane) {
  pane.classList.add('viewer', `viewer-${doc.kind}`);
  switch (doc.kind) {
    case 'image':
      return renderImage(app, doc.path, pane, doc.size);
    case 'video':
      return renderMedia(app, doc, pane, 'video');
    case 'audio':
      return renderMedia(app, doc, pane, 'audio');
    case 'pdf':
      return renderPdf(app, doc, pane);
    default:
      return renderCard(app, doc, pane);
  }
}

function downloadButton(app, path) {
  return iconButton('download', 'Download', () => app.commands.run('file.download', path));
}

function infoBar(app, path, ...items) {
  return h('div.viewer-bar', {}, h('span.viewer-name', { text: path }), h('span.viewer-spacer'), ...items, downloadButton(app, path));
}

/** Image viewer; also used by "Preview" for SVG files opened as text. */
export function renderImage(app, path, pane, size) {
  pane.classList.add('viewer', 'viewer-image');
  const img = h('img.viewer-img', { src: api.fileUrl(path), alt: path, draggable: 'false' });
  const stage = h('div.viewer-stage.checker', {}, img);
  const zoomLabel = h('button.btn.small.viewer-zoom', { type: 'button', text: 'Fit', 'data-tip': 'Reset zoom' });
  const dims = h('span.viewer-meta');
  let zoom = 'fit';

  const apply = () => {
    if (zoom === 'fit') {
      img.classList.add('fit');
      img.style.width = '';
      zoomLabel.textContent = 'Fit';
    } else {
      img.classList.remove('fit');
      img.style.width = `${Math.max(1, Math.round(img.naturalWidth * zoom))}px`;
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    }
  };
  const current = () => (zoom === 'fit' ? img.clientWidth / (img.naturalWidth || 1) : zoom);
  const setZoom = (value) => {
    zoom = value === 'fit' ? 'fit' : Math.min(32, Math.max(0.05, value));
    apply();
  };
  img.addEventListener('load', () => {
    dims.textContent = `${img.naturalWidth} × ${img.naturalHeight}${size ? ` · ${bytes(size)}` : ''}`;
    apply();
  });
  img.addEventListener('error', () => {
    stage.replaceChildren(h('div.viewer-error', { text: 'This image could not be displayed.' }));
  });
  stage.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setZoom(current() * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });
  zoomLabel.addEventListener('click', () => setZoom('fit'));

  const backgrounds = ['checker', 'dark', 'light'];
  let bg = 0;
  const bar = infoBar(
    app,
    path,
    dims,
    iconButton('zoom-out', 'Zoom out', () => setZoom(current() / 1.25)),
    zoomLabel,
    iconButton('zoom-in', 'Zoom in', () => setZoom(current() * 1.25)),
    iconButton('actual-size', 'Actual size (100%)', () => setZoom(1)),
    iconButton('fit', 'Fit to window', () => setZoom('fit')),
    iconButton('palette', 'Change background', () => {
      stage.classList.remove(backgrounds[bg]);
      bg = (bg + 1) % backgrounds.length;
      stage.classList.add(backgrounds[bg]);
    }),
    extname(path) === 'svg' ? iconButton('file-code', 'Open as text', () => app.tabs.open(path)) : null,
  );
  pane.append(bar, stage);
}

function renderMedia(app, doc, pane, tag) {
  const player = h(tag, { src: api.fileUrl(doc.path), controls: true, preload: 'metadata', class: `viewer-${tag}-el` });
  player.addEventListener('error', () => {
    stage.append(h('div.viewer-error', { text: `This ${tag} format cannot be played by this browser.` }));
  });
  const stage =
    tag === 'video'
      ? h('div.viewer-stage.dark', {}, player)
      : h('div.viewer-stage', {}, h('div.audio-card', {}, h('div.audio-art', {}, icon('audio')), h('div.audio-name', { text: doc.name }), player));
  pane.append(infoBar(app, doc.path, h('span.viewer-meta', { text: bytes(doc.size) })), stage);
}

function renderPdf(app, doc, pane) {
  const frame = h('iframe.viewer-frame', { src: api.fileUrl(doc.path), title: doc.name });
  pane.append(
    infoBar(app, doc.path, h('span.viewer-meta', { text: bytes(doc.size) }), iconButton('external', 'Open in a new browser tab', () => window.open(api.fileUrl(doc.path), '_blank', 'noopener'))),
    h('div.viewer-stage.frame', {}, frame),
  );
}

function renderCard(app, doc, pane) {
  const { icon: iconName, color } = fileIcon(doc.path);
  const glyph = icon(iconName, 'card-icon');
  glyph.style.color = `var(${color})`;
  pane.append(
    h('div.viewer-stage', {},
      h('div.file-card', {},
        glyph,
        h('div.file-card-name', { text: doc.name }),
        h('div.file-card-meta', { text: [doc.path, doc.size ? bytes(doc.size) : null].filter(Boolean).join(' · ') }),
        h('p.file-card-message', { text: doc.error || 'This file cannot be shown.' }),
        h('div.file-card-actions', {},
          h('button.btn.primary', { type: 'button', onclick: () => app.commands.run('file.download', doc.path) }, icon('download'), 'Download'),
        ),
      ),
    ),
  );
}
