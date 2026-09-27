/**
 * The media viewer: one item at full size over everything else.
 *
 * Images: fit, 100 %, zoom with the wheel, pinch, double-click or the
 * buttons; drag to pan; rotate (view only). Videos: the browser's own player.
 * Both: previous/next (arrows, swipe), slideshow, information panel,
 * download, full screen. The sequence is whatever the view showed, in the
 * same order, so "next" means the next tile.
 */
import { api, mediaUrl, previewUrl } from '../core/api.js';
import { h } from '../core/dom.js';
import { bytes, duration as formatDuration, pixels, wallDateTime, wallClock } from '../core/format.js';
import { icon } from '../core/icons.js';
import { posterFor } from '../core/posters.js';
import { canPlayVideo, canShowImage, hasFailed, itemKey, markFailed, reportImage } from '../core/support.js';

const MAX_ZOOM = 16;
const IDLE_MS = 2600;
const SWIPE = 60;

export class Viewer {
  constructor({ albumId, catalog, onClose, onNavigate }) {
    this.albumId = albumId;
    this.catalog = catalog;
    this.onClose = onClose;
    this.onNavigate = onNavigate;
    this.el = null;
    this.sequence = [];
    this.index = 0;
    this.item = null;
    this.infoOpen = false;
    this.slideshow = { on: false, seconds: 5, timer: 0 };
    this.view = { natW: 0, natH: 0, rot: 0, scale: 1, tx: 0, ty: 0, fit: 1 };
    this.pointers = new Map();
    this.gesture = null;
    this.lastTap = 0;
    this.detailsToken = 0;
    this.handleKey = this.handleKey.bind(this);
    this.handleResize = () => this.relayout(false);
    this.wake = this.wake.bind(this);
    document.addEventListener('fullscreenchange', () => {
      if (this.fullButton) this.fullButton.replaceChildren(icon(document.fullscreenElement ? 'exit-fullscreen' : 'fullscreen'));
      requestAnimationFrame(() => this.relayout(false));
    });
  }

  get isOpen() {
    return Boolean(this.el);
  }

  open(sequence, index) {
    this.sequence = sequence;
    if (!this.el) this.build();
    this.show(Math.max(0, Math.min(index, sequence.length - 1)));
  }

  /** The view's list changed (new files, other filters): keep showing the same item. */
  setSequence(sequence) {
    if (!this.el || !this.item) return;
    this.sequence = sequence;
    const index = sequence.findIndex((item) => item.id === this.item.id);
    if (index >= 0) {
      this.index = index;
      const fresh = sequence[index];
      if (fresh !== this.item && fresh.version === this.item.version) this.item = fresh;
    }
    this.updateChrome();
  }

  close({ notify = true } = {}) {
    if (!this.el) return;
    const item = this.item;
    this.stopSlideshow();
    clearTimeout(this.idleTimer);
    window.removeEventListener('keydown', this.handleKey, true);
    window.removeEventListener('resize', this.handleResize);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    const video = this.el.querySelector('video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    this.el.remove();
    this.el = null;
    document.body.classList.remove('viewer-open');
    if (notify) this.onClose(item);
  }

  /* ---- structure ---------------------------------------------------------- */

  build() {
    const button = (name, label, onClick, extra = {}) =>
      h('button', { type: 'button', class: ['icon-btn', extra.class || ''], title: label, 'aria-label': label, onClick }, icon(name));

    this.titleName = h('span', { class: 'name' });
    this.titleSub = h('span', { class: 'sub' });
    this.zoomLabel = h('button', { type: 'button', class: 'viewer-zoom', title: 'Toggle fit / 100 % (0, 1)', onClick: () => this.toggleZoom() });
    this.zoomOut = button('zoom-out', 'Zoom out (−)', () => this.zoomBy(1 / 1.5));
    this.zoomIn = button('zoom-in', 'Zoom in (+)', () => this.zoomBy(1.5));
    this.fitButton = button('fit', 'Fit to screen (0)', () => this.setFit(true), { class: 'optional' });
    this.rotateLeft = button('rotate-left', 'Rotate left (Shift+R)', () => this.rotate(-90), { class: 'optional' });
    this.rotateRight = button('rotate-right', 'Rotate right (R)', () => this.rotate(90));
    this.imageControls = h('div', { class: 'slideshow-menu' }, this.zoomOut, this.zoomLabel, this.zoomIn, this.fitButton, this.rotateLeft, this.rotateRight);
    this.slideButton = button('slideshow', 'Slideshow (S)', () => this.toggleSlideshow());
    this.slideSeconds = h(
      'select',
      { title: 'Seconds per image', 'aria-label': 'Seconds per image', hidden: true, onChange: (event) => this.setSlideSeconds(Number(event.target.value)) },
      [2, 3, 5, 8, 12, 20].map((seconds) => h('option', { value: seconds, selected: seconds === this.slideshow.seconds, text: `${seconds} s` })),
    );
    this.infoButton = button('info', 'Information (I)', () => this.toggleInfo());
    this.download = h('a', { class: 'icon-btn', title: 'Download (D)', 'aria-label': 'Download', download: '' }, icon('download'));
    this.external = h('a', { class: 'icon-btn optional', title: 'Open the original in a new tab', 'aria-label': 'Open original', target: '_blank', rel: 'noopener' }, icon('external'));
    this.fullButton = button('fullscreen', 'Full screen (F)', () => this.toggleFullscreen(), { class: 'optional' });

    const bar = h(
      'div',
      { class: 'viewer-bar' },
      button('x', 'Close (Esc)', () => this.close()),
      h('div', { class: 'viewer-title' }, this.titleName, this.titleSub),
      this.imageControls,
      h('span', { class: 'viewer-sep optional' }),
      h('div', { class: 'slideshow-menu' }, this.slideButton, this.slideSeconds),
      this.infoButton,
      this.download,
      this.external,
      this.fullButton,
    );
    this.stage = h('div', { class: 'viewer-stage' });
    this.prevButton = h('button', { type: 'button', class: 'viewer-nav prev', 'aria-label': 'Previous', title: 'Previous (←)', onClick: () => this.step(-1) }, icon('chevron-left', { size: 28 }));
    this.nextButton = h('button', { type: 'button', class: 'viewer-nav next', 'aria-label': 'Next', title: 'Next (→)', onClick: () => this.step(1) }, icon('chevron-right', { size: 28 }));
    this.info = h('aside', { class: 'viewer-info', hidden: true, 'aria-label': 'Information' });
    this.el = h(
      'div',
      { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Media viewer' },
      h('div', { class: 'viewer-main' }, this.stage, bar, this.prevButton, this.nextButton),
      this.info,
    );
    this.el.addEventListener('pointermove', this.wake);
    this.el.addEventListener('pointerdown', this.wake);
    this.stage.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    this.stage.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.stage.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.stage.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.stage.addEventListener('pointercancel', (event) => this.onPointerUp(event, true));
    this.stage.addEventListener('dblclick', (event) => {
      if (this.mode === 'image') this.toggleZoom(event.clientX, event.clientY);
    });
    window.addEventListener('keydown', this.handleKey, true);
    window.addEventListener('resize', this.handleResize);
    document.body.append(this.el);
    document.body.classList.add('viewer-open');
    this.wake();
  }

  /* ---- showing an item -------------------------------------------------- */

  show(index) {
    if (!this.sequence.length) return;
    this.index = (index + this.sequence.length) % this.sequence.length;
    const item = this.sequence[this.index];
    this.item = item;
    this.view.rot = 0;
    this.pointers.clear();
    this.gesture = null;
    clearTimeout(this.slideshow.timer);
    const albumId = this.albumId();
    this.stage.replaceChildren();
    this.canvas = null;
    this.video = null;

    if (item.kind === 'video') this.showVideo(albumId, item);
    else this.showImage(albumId, item);

    this.download.href = mediaUrl(albumId, item, { download: true });
    this.download.setAttribute('download', item.name);
    this.external.href = mediaUrl(albumId, item);
    this.updateChrome();
    this.preloadNeighbours(albumId);
    if (this.infoOpen) this.renderInfo();
    this.onNavigate(item);
  }

  showImage(albumId, item) {
    this.mode = 'image';
    const displayable = canShowImage(item.format) && !hasFailed(albumId, item);
    const full = displayable ? mediaUrl(albumId, item) : item.preview ? previewUrl(albumId, item) : null;
    if (!full) {
      this.showMessage(item, `This browser cannot display ${item.format.label} files.`);
      return;
    }
    const spinner = h('div', { class: 'viewer-spinner' });
    const img = h('img', { alt: item.name, draggable: 'false', decoding: 'async' });
    this.canvas = h('div', { class: 'viewer-canvas' }, img);
    this.stage.append(this.canvas, spinner);
    this.img = img;

    // Lay out with the size the server measured, so the (blurry) embedded
    // thumbnail can stand in at the right size while the photo loads.
    const known = item.width && item.height;
    if (known) this.setNatural(item.width, item.height);
    if (displayable && item.preview === 1 && known) img.src = previewUrl(albumId, item);

    const loader = new Image();
    loader.decoding = 'async';
    loader.onload = () => {
      if (this.item !== item || !this.el) return;
      spinner.remove();
      reportImage(item.format, true);
      const naturalChanged = !known || Math.abs(loader.naturalWidth / loader.naturalHeight - item.width / item.height) > 0.02;
      img.src = loader.src;
      if (naturalChanged) this.setNatural(loader.naturalWidth, loader.naturalHeight);
      else this.view.natW = loader.naturalWidth || this.view.natW;
      if (!known || naturalChanged) this.setFit(false);
      else this.relayout(false);
      this.scheduleSlide();
    };
    loader.onerror = () => {
      if (this.item !== item || !this.el) return;
      spinner.remove();
      if (displayable) {
        markFailed(albumId, item);
        if (item.format.browser === 'maybe') reportImage(item.format, false);
        if (item.preview) {
          this.showImage(albumId, item); // falls back to the embedded preview
          return;
        }
      }
      this.stage.replaceChildren();
      this.showMessage(item, displayable ? 'This file could not be decoded.' : `This browser cannot display ${item.format.label} files.`);
      this.scheduleSlide();
    };
    loader.src = full;
    if (known) this.setFit(false);
  }

  showVideo(albumId, item) {
    this.mode = 'video';
    if (!canPlayVideo(item) || hasFailed(albumId, item)) {
      this.showMessage(item, `This browser cannot play this ${item.format.label} file${item.codec ? ` (${item.codec})` : ''}.`);
      return;
    }
    const poster = posterFor(itemKey(albumId, item));
    const video = h('video', {
      controls: true,
      playsinline: true,
      preload: 'auto',
      poster: poster ? poster.url : null,
    });
    video.addEventListener('error', () => {
      if (this.item !== item) return;
      markFailed(albumId, item);
      this.stage.replaceChildren();
      this.showMessage(item, `This browser cannot play this ${item.format.label} file${item.codec ? ` (${item.codec})` : ''}.`);
      this.scheduleSlide();
    });
    video.addEventListener('ended', () => {
      if (this.slideshow.on) this.step(1);
    });
    video.src = mediaUrl(albumId, item);
    this.video = video;
    this.stage.append(h('div', { class: 'viewer-video' }, video));
    video.play().catch(() => {});
  }

  showMessage(item, text) {
    this.mode = 'message';
    this.stage.append(
      h(
        'div',
        { class: 'viewer-message' },
        icon(item.kind === 'video' ? 'film' : 'image-off', { size: 48 }),
        h('h2', { text: item.name }),
        h('p', { text: `${text} You can still download it.` }),
        h(
          'a',
          { class: 'btn primary', href: mediaUrl(this.albumId(), item, { download: true }), download: item.name },
          icon('download', { size: 18 }),
          `Download (${bytes(item.size)})`,
        ),
      ),
    );
  }

  updateChrome() {
    const item = this.item;
    if (!item || !this.el) return;
    this.titleName.textContent = item.name;
    const folder = this.catalog.folderPath(item.folderId);
    const parts = [`${this.index + 1} of ${this.sequence.length}`];
    if (item.width) parts.push(`${item.width} × ${item.height}`);
    if (item.duration) parts.push(formatDuration(item.duration));
    parts.push(bytes(item.size));
    if (folder) parts.push(folder);
    this.titleSub.textContent = parts.join(' · ');
    this.imageControls.hidden = this.mode !== 'image';
    this.fitButton.hidden = this.mode !== 'image';
    const single = this.sequence.length < 2;
    this.prevButton.disabled = single;
    this.nextButton.disabled = single;
    this.slideButton.setAttribute('aria-pressed', String(this.slideshow.on));
    this.slideSeconds.hidden = !this.slideshow.on;
    this.infoButton.setAttribute('aria-pressed', String(this.infoOpen));
    this.updateZoomLabel();
  }

  step(delta) {
    if (this.sequence.length < 2) return;
    this.show(this.index + delta);
  }

  preloadNeighbours(albumId) {
    for (const offset of [1, -1]) {
      const neighbour = this.sequence[(this.index + offset + this.sequence.length) % this.sequence.length];
      if (!neighbour || neighbour === this.item || neighbour.kind !== 'image') continue;
      if (canShowImage(neighbour.format) && !hasFailed(albumId, neighbour)) {
        const image = new Image();
        image.decoding = 'async';
        image.src = mediaUrl(albumId, neighbour);
      }
    }
  }

  /* ---- zoom and pan -------------------------------------------------------- */

  setNatural(width, height) {
    this.view.natW = width;
    this.view.natH = height;
  }

  box() {
    const { natW, natH, rot } = this.view;
    return rot % 180 === 0 ? { w: natW, h: natH } : { w: natH, h: natW };
  }

  computeFit() {
    const { w, h: height } = this.box();
    const stageW = this.stage.clientWidth;
    const stageH = this.stage.clientHeight;
    if (!w || !height || !stageW || !stageH) return 1;
    return Math.min(stageW / w, stageH / height, 1);
  }

  setFit(animate = true) {
    this.view.fit = this.computeFit();
    this.view.scale = this.view.fit;
    this.center();
    this.apply(animate);
  }

  relayout(animate) {
    if (this.mode !== 'image' || !this.canvas) return;
    const wasFit = Math.abs(this.view.scale - this.view.fit) < 1e-3;
    this.view.fit = this.computeFit();
    if (wasFit) this.view.scale = this.view.fit;
    this.center();
    this.apply(animate);
  }

  center() {
    const { w, h: height } = this.box();
    const stageW = this.stage.clientWidth;
    const stageH = this.stage.clientHeight;
    this.view.tx = (stageW - w * this.view.scale) / 2;
    this.view.ty = (stageH - height * this.view.scale) / 2;
  }

  clampPan() {
    const { w, h: height } = this.box();
    const stageW = this.stage.clientWidth;
    const stageH = this.stage.clientHeight;
    const scaledW = w * this.view.scale;
    const scaledH = height * this.view.scale;
    this.view.tx = scaledW <= stageW ? (stageW - scaledW) / 2 : Math.min(0, Math.max(stageW - scaledW, this.view.tx));
    this.view.ty = scaledH <= stageH ? (stageH - scaledH) / 2 : Math.min(0, Math.max(stageH - scaledH, this.view.ty));
  }

  zoomAt(scale, clientX, clientY, animate = false) {
    const rect = this.stage.getBoundingClientRect();
    const px = clientX === undefined ? rect.width / 2 : clientX - rect.left;
    const py = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    const maxScale = Math.max(MAX_ZOOM, this.view.fit * 4);
    const next = Math.min(maxScale, Math.max(this.view.fit, scale));
    const ratio = next / this.view.scale;
    this.view.tx = px - (px - this.view.tx) * ratio;
    this.view.ty = py - (py - this.view.ty) * ratio;
    this.view.scale = next;
    this.clampPan();
    this.apply(animate);
  }

  zoomBy(factor) {
    if (this.mode !== 'image') return;
    this.zoomAt(this.view.scale * factor, undefined, undefined, true);
  }

  toggleZoom(clientX, clientY) {
    if (this.mode !== 'image') return;
    const atFit = Math.abs(this.view.scale - this.view.fit) < 1e-3;
    if (!atFit) {
      this.setFit(true);
      return;
    }
    // From "fit" go to 100 %, or to 2.5x when the image is already shown at 100 %.
    const target = this.view.fit < 0.999 ? 1 : this.view.fit * 2.5;
    this.zoomAt(target, clientX, clientY, true);
  }

  rotate(degrees) {
    if (this.mode !== 'image') return;
    this.view.rot = (this.view.rot + degrees + 360) % 360;
    this.setFit(true);
  }

  apply(animate) {
    if (!this.canvas) return;
    const { natW, natH, rot, scale, tx, ty } = this.view;
    const { w, h: height } = this.box();
    this.canvas.classList.toggle('animate', Boolean(animate));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    this.canvas.classList.toggle('pixelated', scale >= 3);
    if (this.img) {
      this.img.style.width = `${natW}px`;
      this.img.style.height = `${natH}px`;
      this.img.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;
    }
    this.stage.classList.toggle('at-fit', Math.abs(scale - this.view.fit) < 1e-3);
    this.updateZoomLabel();
  }

  updateZoomLabel() {
    if (this.zoomLabel) this.zoomLabel.textContent = `${Math.round(this.view.scale * 100)}%`;
  }

  /* ---- input ------------------------------------------------------------------ */

  onWheel(event) {
    if (this.mode !== 'image') return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0022));
    this.zoomAt(this.view.scale * factor, event.clientX, event.clientY);
  }

  onPointerDown(event) {
    if (this.mode !== 'image' || event.button > 0) return;
    this.stage.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 1) {
      this.gesture = { kind: 'drag', x: event.clientX, y: event.clientY, tx: this.view.tx, ty: this.view.ty, time: Date.now(), moved: false };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.gesture = {
        kind: 'pinch',
        distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        scale: this.view.scale,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    }
  }

  onPointerMove(event) {
    if (!this.pointers.has(event.pointerId) || !this.gesture) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.gesture.kind === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.view.tx += mid.x - this.gesture.mid.x;
      this.view.ty += mid.y - this.gesture.mid.y;
      this.gesture.mid = mid;
      this.zoomAt(this.gesture.scale * (distance / this.gesture.distance), mid.x, mid.y);
      return;
    }
    if (this.gesture.kind !== 'drag') return;
    const dx = event.clientX - this.gesture.x;
    const dy = event.clientY - this.gesture.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) this.gesture.moved = true;
    const zoomed = this.view.scale > this.view.fit + 1e-3;
    if (zoomed) {
      this.stage.classList.add('dragging');
      this.view.tx = this.gesture.tx + dx;
      this.view.ty = this.gesture.ty + dy;
      this.clampPan();
      this.apply(false);
    } else if (this.canvas) {
      // Not zoomed: the drag previews a swipe to the next or previous item.
      this.canvas.style.transform = `translate(${this.view.tx + dx}px, ${this.view.ty + Math.max(0, dy) * 0.6}px) scale(${this.view.scale})`;
    }
  }

  onPointerUp(event, cancelled = false) {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.delete(event.pointerId);
    this.stage.classList.remove('dragging');
    const gesture = this.gesture;
    if (this.pointers.size === 1 && gesture && gesture.kind === 'pinch') {
      const [rest] = [...this.pointers.values()];
      this.gesture = { kind: 'drag', x: rest.x, y: rest.y, tx: this.view.tx, ty: this.view.ty, time: Date.now(), moved: true };
      return;
    }
    if (this.pointers.size) return;
    this.gesture = null;
    if (!gesture || gesture.kind !== 'drag' || cancelled) {
      this.apply(true);
      return;
    }
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    const zoomed = this.view.scale > this.view.fit + 1e-3;
    if (!zoomed && gesture.moved) {
      if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy)) {
        this.step(dx < 0 ? 1 : -1);
        return;
      }
      if (dy > SWIPE * 1.6 && Math.abs(dy) > Math.abs(dx)) {
        this.close();
        return;
      }
      this.apply(true);
      return;
    }
    if (!gesture.moved && event.pointerType === 'touch') {
      const now = Date.now();
      if (now - this.lastTap < 300) {
        this.lastTap = 0;
        this.toggleZoom(event.clientX, event.clientY);
      } else {
        this.lastTap = now;
      }
    }
  }

  handleKey(event) {
    if (!this.el) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const onVideo = target && target.tagName === 'VIDEO';
    const keys = {
      Escape: () => (this.infoOpen && window.innerWidth < 720 ? this.toggleInfo() : this.close()),
      ArrowRight: () => !onVideo && this.step(1),
      ArrowLeft: () => !onVideo && this.step(-1),
      PageDown: () => this.step(1),
      PageUp: () => this.step(-1),
      Home: () => this.show(0),
      End: () => this.show(this.sequence.length - 1),
      '+': () => this.zoomBy(1.5),
      '=': () => this.zoomBy(1.5),
      '-': () => this.zoomBy(1 / 1.5),
      0: () => this.setFit(true),
      1: () => this.mode === 'image' && this.zoomAt(1, undefined, undefined, true),
      f: () => this.toggleFullscreen(),
      i: () => this.toggleInfo(),
      r: () => this.rotate(90),
      R: () => this.rotate(-90),
      s: () => this.toggleSlideshow(),
      d: () => this.download.click(),
      ' ': () => {
        if (this.video && !onVideo) {
          if (this.video.paused) this.video.play().catch(() => {});
          else this.video.pause();
        } else if (!this.video) {
          this.toggleSlideshow();
        }
      },
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
    this.wake();
  }

  wake() {
    if (!this.el) return;
    this.el.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.el || this.infoOpen) return;
      if (this.el.querySelector('.viewer-bar:hover')) {
        this.wake();
        return;
      }
      this.el.classList.add('idle');
    }, IDLE_MS);
  }

  /* ---- extras --------------------------------------------------------------------- */

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else this.el.requestFullscreen?.().catch(() => {});
  }

  toggleSlideshow() {
    if (this.slideshow.on) this.stopSlideshow();
    else {
      this.slideshow.on = true;
      if (this.video && this.video.paused) this.video.play().catch(() => {});
      this.scheduleSlide();
    }
    this.updateChrome();
  }

  stopSlideshow() {
    this.slideshow.on = false;
    clearTimeout(this.slideshow.timer);
    if (this.el) this.updateChrome();
  }

  setSlideSeconds(seconds) {
    this.slideshow.seconds = seconds;
    this.scheduleSlide();
  }

  scheduleSlide() {
    clearTimeout(this.slideshow.timer);
    if (!this.slideshow.on || this.mode === 'video') return; // videos advance when they end
    this.slideshow.timer = setTimeout(() => this.step(1), this.slideshow.seconds * 1000);
  }

  toggleInfo() {
    this.infoOpen = !this.infoOpen;
    this.info.hidden = !this.infoOpen;
    if (this.infoOpen) this.renderInfo();
    this.updateChrome();
    requestAnimationFrame(() => this.relayout(false));
  }

  renderInfo() {
    const item = this.item;
    const rows = [];
    const add = (label, value) => {
      if (value === null || value === undefined || value === '') return;
      rows.push(h('dt', { text: label }), h('dd', { text: String(value) }));
    };
    const group = (label) => rows.push(h('div', { class: 'group', text: label }));
    const folder = this.catalog.folderPath(item.folderId);
    add('Name', item.name);
    add('Folder', folder || '(album root)');
    add('Type', `${item.format.label}${item.ext ? ` (.${item.ext})` : ''}`);
    add('Size', `${bytes(item.size)} (${item.size.toLocaleString()} bytes)`);
    add('Dimensions', pixels(item.width, item.height));
    add('Duration', formatDuration(item.duration));
    add('Codec', item.codec);
    if (item.taken !== null) add('Taken', wallDateTime(item.takenUtc ? wallClock(item.taken) : item.taken));
    if (item.birth !== null) add('Created', wallDateTime(wallClock(item.birth)));
    add('Modified', wallDateTime(wallClock(item.mtime)));
    add('Camera', item.camera);
    if (item.animated) add('Animated', 'Yes');
    const list = h('dl', {}, rows);
    const details = h('dl');
    this.info.replaceChildren(
      h('h2', {}, h('span', { text: 'Information' }), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close information', onClick: () => this.toggleInfo() }, icon('x', { size: 18 }))),
      list,
      details,
    );
    const token = ++this.detailsToken;
    api
      .details(this.albumId(), item.id)
      .then((data) => {
        if (token !== this.detailsToken || !this.el) return;
        const extra = [];
        const put = (label, value) => {
          if (value === null || value === undefined || value === '') return;
          extra.push(h('dt', { text: label }), h('dd', { text: String(value) }));
        };
        const d = data.details || {};
        const ratio = (value) => (Array.isArray(value) ? value[0] / value[1] : value);
        if (Object.keys(d).length) extra.push(h('div', { class: 'group', text: 'Camera details' }));
        put('Make', d.make);
        put('Model', d.model);
        put('Lens', [d.lensMake, d.lensModel].filter(Boolean).join(' '));
        if (d.fNumber) put('Aperture', `f/${ratio(d.fNumber).toFixed(1)}`);
        if (d.exposureTime) {
          const seconds = ratio(d.exposureTime);
          put('Exposure', seconds >= 1 ? `${seconds.toFixed(1)} s` : `1/${Math.round(1 / seconds)} s`);
        }
        put('ISO', d.iso);
        if (d.focalLength) put('Focal length', `${ratio(d.focalLength).toFixed(0)} mm${d.focalLength35mm ? ` (${d.focalLength35mm} mm equiv.)` : ''}`);
        if (d.exposureBias) put('Exposure bias', `${ratio(d.exposureBias).toFixed(1)} EV`);
        put('Software', d.software);
        put('Artist', d.artist);
        put('Copyright', d.copyright);
        put('Description', d.description);
        if (d.latitude !== undefined) {
          put('Location', `${d.latitude.toFixed(5)}, ${d.longitude.toFixed(5)}${d.altitude !== undefined ? ` · ${d.altitude} m` : ''}`);
          const link = h('a', {
            href: `https://www.openstreetmap.org/?mlat=${d.latitude}&mlon=${d.longitude}#map=15/${d.latitude}/${d.longitude}`,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: 'Open in OpenStreetMap',
          });
          extra.push(h('dt', { text: '' }), h('dd', {}, link));
        }
        extra.push(h('div', { class: 'group', text: 'File' }));
        put('Path', data.path);
        put('MIME type', data.mime);
        details.replaceChildren(...extra);
      })
      .catch(() => {});
  }
}
