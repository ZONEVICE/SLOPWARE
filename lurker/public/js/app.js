/**
 * The application shell: which screen is showing (start or album), the top
 * bar, the toolbar, the filter panel, the current view and the viewer.
 *
 * State flows one way. The server's album status arrives by server-sent
 * events and drives the catalog; the URL holds every view setting (view,
 * filters, sort, layout, open item); the shell derives the visible list from
 * both and hands it to the current view.
 */
import { closeMenu, confirmDialog, showMenu, toast } from './components/feedback.js';
import { advancedDefaults, createFilterPanel } from './components/filters.js';
import { createStartScreen } from './components/start.js';
import { Viewer } from './components/viewer.js';
import { api } from './core/api.js';
import { Catalog, compareNames } from './core/catalog.js';
import { h } from './core/dom.js';
import { bytes, number, plural, wallDate } from './core/format.js';
import { icon, logo } from './core/icons.js';
import { connectLive } from './core/live.js';
import { clearPosters } from './core/posters.js';
import {
  activeFilterCount,
  dateOf,
  DEFAULT_FILTERS,
  filterItems,
  filtersFromParams,
  filtersToParams,
  normalize,
  SORTS,
  sortItems,
} from './core/query.js';
import { createRouter } from './core/router.js';
import { isViewable, supportEvents } from './core/support.js';
import { findView, VIEWS } from './views/index.js';
import { emptyState } from './views/shared.js';

const THEMES = ['auto', 'dark', 'light'];
const SIZES = { min: 90, max: 400, fallback: 180 };

export class App {
  constructor(root) {
    this.root = root;
    this.catalog = new Catalog();
    this.info = null; // app identity from /api/state
    this.album = null;
    this.shortcuts = [];
    this.screen = null; // 'start' | 'album'
    this.view = null;
    this.viewId = null;
    this.theme = 'auto';
    this.filtersOpen = false;
    this.supportVersion = 0;
    this.listCache = { key: '', items: [], counts: { all: 0, image: 0, video: 0 } };
    this.searchKeys = new WeakMap();
    this.folderPaths = new Map();
    this.seed = Math.floor(Math.random() * 2 ** 31);
    this.closingHere = false;
    this.viewerPushed = false;
    this.refreshTimer = 0;
    this.lastRefresh = 0;
    this.viewer = new Viewer({
      albumId: () => this.album?.id,
      catalog: this.catalog,
      onClose: (item) => this.onViewerClosed(item),
      onNavigate: (item) => {
        if (this.router.current.params.get('item') !== String(item.id)) this.router.patch({ item: item.id }, { replace: true });
      },
    });
  }

  async start() {
    const state = await api.state();
    this.info = state.app;
    this.shortcuts = state.shortcuts;
    this.catalog.setFormats(state.formats);
    this.formats = state.formats;
    this.router = createRouter((route) => this.onRoute(route));
    this.catalog.addEventListener('change', () => this.onCatalogChange());
    supportEvents.addEventListener('change', () => {
      this.supportVersion += 1;
      this.refresh(true);
    });
    this.live = connectLive({
      onState: (album) => this.onAlbum(album),
      onConnection: (connected) => this.setConnected(connected),
    });
    document.addEventListener('keydown', (event) => this.onKey(event));
    this.onAlbum(state.album);
    this.root.setAttribute('aria-busy', 'false');
  }

  /* ---- album status ----------------------------------------------------------- */

  onAlbum(album) {
    const previous = this.album;
    this.album = album;
    if (album.status === 'empty') {
      if (previous && previous.status !== 'empty' && !this.closingHere) {
        toast('The album was closed from another browser.', { timeout: 6000 });
      }
      this.closingHere = false;
      this.catalog.sync(album);
      if (this.screen !== 'start') {
        // Folder and item numbers belong to the album that just closed.
        const route = this.router.current;
        if (route.params.has('folder') || route.params.has('item')) {
          const params = new URLSearchParams(route.params);
          params.delete('folder');
          params.delete('item');
          this.router.go(route.view, params, { replace: true });
        }
        this.showStart();
      }
      return;
    }
    if (!previous || previous.id !== album.id) {
      clearPosters();
      this.folderPaths.clear();
    }
    if (this.screen !== 'album' || !previous || previous.id !== album.id) this.showAlbum(previous && previous.status !== 'empty' && previous.id !== album.id);
    this.catalog.sync(album);
    this.updateHeader();
  }

  onCatalogChange() {
    this.folderPaths.clear();
    if (this.screen !== 'album') return;
    // While a big album is being scanned, redraw at most every 700 ms.
    const album = this.album;
    const busy = album && album.status !== 'empty' && (album.status === 'scanning' || album.probe.done < album.probe.total);
    const wait = busy ? Math.max(0, 700 - (Date.now() - this.lastRefresh)) : 0;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), wait);
  }

  setConnected(connected) {
    if (connected === this.connected) return;
    this.connected = connected;
    document.getElementById('offline')?.remove();
    if (!connected) {
      document.body.append(
        h('div', { id: 'offline', class: 'offline', role: 'alert' }, h('span', { class: 'spinner' }), 'Lost contact with Lurker. Reconnecting…'),
      );
    }
  }

  /* ---- screens ------------------------------------------------------------------- */

  showStart() {
    this.screen = 'start';
    this.destroyView();
    this.viewer.close({ notify: false });
    closeMenu();
    document.title = 'Lurker';
    this.root.replaceChildren(
      createStartScreen({
        app: this.info,
        album: this.album,
        shortcuts: this.shortcuts,
        onOpened: (status) => this.onAlbum(status),
      }),
    );
  }

  showAlbum(replaced) {
    this.screen = 'album';
    this.destroyView();
    this.viewer.close({ notify: false });
    if (replaced) toast('Another album was opened from another browser.', { timeout: 6000 });
    this.buildShell();
    const route = this.router.current;
    // Another album replaced the one on screen: its folder and item numbers mean nothing now.
    if (replaced) {
      const params = new URLSearchParams(route.params);
      params.delete('folder');
      params.delete('item');
      this.router.go(route.view, params, { replace: true });
    }
    this.mountView(findView(this.router.current.view).id);
  }

  buildShell() {
    const button = (glyph, label, onClick, extra = {}) =>
      h('button', { type: 'button', class: ['icon-btn', extra.class || ''], title: label, 'aria-label': label, onClick }, icon(glyph));

    this.titleName = h('span', { class: 'name' });
    this.titlePath = h('span', { class: 'path' });
    this.statusLine = h('div', { class: 'status-line', role: 'status' });
    this.scanbar = h('div', { class: 'progress scanbar', hidden: true }, h('div'));
    this.viewTabs = h('div', { class: 'segmented views', role: 'tablist', 'aria-label': 'Views' });
    this.rescanButton = button('refresh', 'Rescan the directory', () => this.rescan(), { class: 'optional' });
    this.themeButton = button('contrast', 'Theme', () => this.cycleTheme(), { class: 'optional' });
    // Phones hide the secondary buttons; the same actions live in a menu there.
    const more = button('more', 'More actions', () =>
      showMenu(more, [
        { label: 'Rescan the directory', icon: 'refresh', onSelect: () => this.rescan() },
        { label: `Theme: ${this.theme === 'auto' ? 'system' : this.theme}`, icon: 'contrast', onSelect: () => this.cycleTheme() },
        ...(this.info.auth ? [{ label: 'Lock Lurker in this browser', icon: 'lock', onSelect: () => this.logout() }] : []),
      ]), { class: 'phone-only' });
    const actions = h(
      'div',
      { class: 'actions' },
      this.rescanButton,
      this.themeButton,
      this.info.auth ? button('lock', 'Lock Lurker in this browser', () => this.logout(), { class: 'optional' }) : null,
      more,
      h(
        'button',
        { type: 'button', class: 'btn small', title: 'Close the album and choose another directory', onClick: () => this.closeAlbum() },
        icon('x', { size: 16 }),
        h('span', { class: 'close-label', text: 'Close album' }),
      ),
    );
    const topbar = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, logo(28), h('span', { class: 'brand-name', text: 'Lurker' })),
      h('div', { class: 'album-title' }, this.titleName, this.titlePath),
      this.statusLine,
      this.viewTabs,
      actions,
      this.scanbar,
    );

    this.kindControl = h('div', { class: 'segmented kinds', role: 'group', 'aria-label': 'Show' });
    this.searchInput = h('input', {
      class: 'input',
      type: 'search',
      placeholder: 'Search names and folders',
      'aria-label': 'Search names and folders',
      onInput: () => {
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => this.setFilters({ q: this.searchInput.value }), 180);
      },
      onKeydown: (event) => {
        if (event.key === 'Escape' && this.searchInput.value) {
          event.stopPropagation();
          this.searchInput.value = '';
          this.setFilters({ q: '' });
        }
      },
    });
    this.summary = h('span', { class: 'summary', role: 'status' });
    this.sortButton = h('button', { type: 'button', class: 'btn ghost sort-button', onClick: () => this.openSortMenu() });
    this.filterButton = h(
      'button',
      { type: 'button', class: 'icon-btn', title: 'Filters', 'aria-label': 'Filters', onClick: () => this.toggleFilters() },
      icon('sliders'),
    );
    this.layoutButtons = h('div', { class: 'segmented layout-toggle', role: 'group', 'aria-label': 'Layout' });
    this.sizeInput = h('input', {
      type: 'range',
      class: 'range',
      min: SIZES.min,
      max: SIZES.max,
      step: 10,
      'aria-label': 'Tile size',
      onInput: () => {
        clearTimeout(this.sizeTimer);
        this.sizeTimer = setTimeout(() => this.router.patch({ size: this.sizeInput.value === String(SIZES.fallback) ? null : this.sizeInput.value }), 60);
      },
    });
    this.sizeControl = h('label', { class: 'size-control', title: 'Tile size' }, icon('image', { size: 14 }), this.sizeInput, icon('image', { size: 19 }));
    this.chips = h('div', { class: 'chips', hidden: true });
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      this.kindControl,
      h('div', { class: 'search' }, icon('search', { size: 16 }), this.searchInput),
      h('span', { class: 'spacer' }),
      this.summary,
      this.sortButton,
      this.filterButton,
      this.layoutButtons,
      this.sizeControl,
      this.chips,
    );

    this.viewHost = h('main', { class: 'view-host', id: 'view' });
    this.filterPanel = createFilterPanel({
      onChange: (patch) => this.setFilters(patch),
      onClose: () => this.toggleFilters(false),
    });
    this.filterPanel.el.hidden = !this.filtersOpen;
    this.filterPanel.backdrop.hidden = !this.filtersOpen;
    const content = h('div', { class: 'content' }, this.viewHost, this.filterPanel.backdrop, this.filterPanel.el);
    this.root.replaceChildren(topbar, toolbar, content);
    this.applyTheme();
  }

  /* ---- views ------------------------------------------------------------------------- */

  mountView(id) {
    this.destroyView();
    const definition = findView(id);
    this.viewId = definition.id;
    this.definition = definition;
    this.ctx = this.makeContext();
    this.view = definition.create(this.ctx);
    this.viewHost.replaceChildren(this.view.el);
    this.refresh(true);
  }

  destroyView() {
    if (this.view) this.view.destroy();
    this.view = null;
  }

  makeContext() {
    const app = this;
    return {
      catalog: this.catalog,
      get albumId() {
        return app.album?.id;
      },
      albumName: () => this.album?.name || '/',
      albumRoot: () => this.album?.root || '/',
      items: [],
      params: new URLSearchParams(),
      filters: { ...DEFAULT_FILTERS },
      sort: { key: 'date', dir: 'desc' },
      layout: 'square',
      tileSize: SIZES.fallback,
      supportVersion: 0,
      open: (item) => this.openItem(item),
      patch: (changes, options) => this.router.patch(changes, options),
      emptyState: (items) => this.emptyState(items),
      emptyNote: (glyph, title, text) => emptyState({ glyph, title, text }),
      onFailure: () => {},
    };
  }

  /** Settings from the URL. */
  settings(route = this.router.current) {
    const params = route.params;
    const filters = filtersFromParams(params);
    const sortKey = SORTS.some((sort) => sort.key === params.get('sort')) ? params.get('sort') : 'date';
    const fallbackDir = SORTS.find((sort) => sort.key === sortKey).dir;
    const dir = ['asc', 'desc'].includes(params.get('dir')) ? params.get('dir') : fallbackDir;
    const layout = params.get('layout') === 'justified' ? 'justified' : 'square';
    const size = Math.min(SIZES.max, Math.max(SIZES.min, Number(params.get('size')) || SIZES.fallback));
    return { filters, sort: { key: sortKey, dir }, layout, tileSize: size };
  }

  /** The filtered, sorted list for the current settings (memoised). */
  visibleItems(settings) {
    const { filters, sort } = settings;
    const key = [
      this.catalog.version,
      this.supportVersion,
      JSON.stringify(filters),
      sort.key,
      sort.dir,
      filters.dateBasis,
    ].join('|');
    if (key === this.listCache.key) return this.listCache;
    const albumId = this.album?.id;
    const context = {
      searchKey: (item) => this.searchKey(item),
      viewable: (item) => isViewable(albumId, item),
      folderPath: (item) => this.folderPathOf(item.folderId),
      dateBasis: filters.dateBasis,
      seed: this.seed,
    };
    const base = filterItems(this.catalog.list, { ...filters, kind: 'all' }, context);
    let images = 0;
    for (const item of base) if (item.kind === 'image') images += 1;
    const chosen = filters.kind === 'all' ? base : base.filter((item) => item.kind === filters.kind);
    const items = sortItems(chosen, sort.key, sort.dir, context);
    this.listCache = { key, items, counts: { all: base.length, image: images, video: base.length - images } };
    return this.listCache;
  }

  searchKey(item) {
    let key = this.searchKeys.get(item);
    if (key === undefined) {
      key = normalize(`${this.folderPathOf(item.folderId)}/${item.name}`);
      this.searchKeys.set(item, key);
    }
    return key;
  }

  folderPathOf(folderId) {
    let path = this.folderPaths.get(folderId);
    if (path === undefined) {
      path = this.catalog.folderPath(folderId);
      this.folderPaths.set(folderId, path);
    }
    return path;
  }

  /** Recompute the list and redraw the toolbar and the current view. */
  refresh(force = false) {
    if (this.screen !== 'album' || !this.view) return;
    this.lastRefresh = Date.now();
    const route = this.router.current;
    const settings = this.settings(route);
    const { items, counts } = this.visibleItems(settings);
    Object.assign(this.ctx, settings, { items, params: route.params, supportVersion: this.supportVersion });
    this.renderToolbar(settings, counts, items);
    this.renderTabs();
    if (this.filtersOpen) this.filterPanel.render(settings.filters, this.facts());
    this.view.update(force);
    if (this.viewer.isOpen) this.viewer.setSequence(this.view.sequence());
    else this.openFromRoute();
  }

  onRoute(route) {
    if (this.screen !== 'album') return;
    const previous = this.lastSettings;
    const settings = this.settings(route);
    this.lastSettings = JSON.stringify([settings.filters, settings.sort]);
    const wantedView = findView(route.view).id;
    if (wantedView !== this.viewId) {
      this.mountView(wantedView);
    } else {
      this.refresh();
      if (previous && previous !== this.lastSettings) this.view.resetScroll?.();
    }
    if (!route.params.has('item') && this.viewer.isOpen) {
      const item = this.viewer.item;
      this.viewer.close({ notify: false });
      this.viewerPushed = false;
      if (item) requestAnimationFrame(() => this.view?.reveal(item));
    }
  }

  openFromRoute() {
    const wanted = Number(this.router.current.params.get('item'));
    if (!this.router.current.params.has('item') || !this.catalog.loaded || this.viewer.isOpen) return;
    const item = this.catalog.items.get(wanted);
    const sequence = this.view.sequence();
    const index = item ? sequence.findIndex((entry) => entry.id === item.id) : -1;
    if (index < 0) {
      if (this.album.status === 'ready') this.router.patch({ item: null }, { replace: true });
      return;
    }
    this.viewer.open(sequence, index);
  }

  /**
   * Open the viewer on `item`. The URL changes first (a new history entry, so
   * the back button closes the viewer); the route handler then opens it with
   * the current view's sequence, exactly as for a link to the item.
   */
  openItem(item) {
    this.viewerPushed = true;
    this.router.patch({ item: item.id }, { replace: false });
  }

  onViewerClosed(item) {
    if (this.viewerPushed) {
      this.viewerPushed = false;
      history.back(); // onRoute sees the item param disappear
    } else {
      this.router.patch({ item: null }, { replace: true });
    }
    if (item) requestAnimationFrame(() => this.view?.reveal(item));
  }

  /* ---- toolbar ------------------------------------------------------------------------ */

  renderTabs() {
    this.viewTabs.replaceChildren(
      ...VIEWS.map((view) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': String(view.id === this.viewId),
            'aria-pressed': String(view.id === this.viewId),
            title: view.label,
            onClick: () => this.switchView(view.id),
          },
          icon(view.icon, { size: 16 }),
          h('span', { class: 'label', text: view.label }),
        ),
      ),
    );
  }

  switchView(id) {
    if (id === this.viewId) return;
    const params = new URLSearchParams(this.router.current.params);
    params.delete('item');
    if (!['folders', 'tree'].includes(id)) {
      params.delete('folder');
      params.delete('sub');
    }
    if (id !== 'timeline') params.delete('group');
    this.router.go(id, params);
  }

  renderToolbar(settings, counts, items) {
    const { filters, sort } = settings;
    const kinds = [
      { key: 'all', label: 'All', count: counts.all },
      { key: 'image', label: 'Images', count: counts.image },
      { key: 'video', label: 'Videos', count: counts.video },
    ];
    this.kindControl.replaceChildren(
      ...kinds.map((kind) =>
        h(
          'button',
          { type: 'button', 'aria-pressed': String(filters.kind === kind.key), onClick: () => this.setFilters({ kind: kind.key }) },
          kind.key === 'image' ? icon('image', { size: 15 }) : kind.key === 'video' ? icon('video', { size: 15 }) : null,
          h('span', { text: kind.label }),
          h('span', { class: 'count', text: number(kind.count) }),
        ),
      ),
    );
    if (document.activeElement !== this.searchInput && this.searchInput.value !== filters.q) this.searchInput.value = filters.q;
    const total = items.reduce((sum, item) => sum + item.size, 0);
    this.summary.textContent = `${plural(items.length, 'item')} · ${bytes(total)}`;
    const sortInfo = SORTS.find((entry) => entry.key === sort.key);
    this.sortButton.replaceChildren(
      icon(sort.dir === 'asc' ? 'sort-asc' : 'sort-desc', { size: 17 }),
      h('span', { text: sortInfo.label }),
    );
    this.sortButton.title = `Sorted by ${sortInfo.label.toLowerCase()}, ${sort.dir === 'asc' ? 'ascending' : 'descending'}`;
    const active = activeFilterCount(filters);
    this.filterButton.setAttribute('aria-pressed', String(this.filtersOpen));
    this.filterButton.querySelector('.count-badge')?.remove();
    if (active) this.filterButton.append(h('span', { class: 'count-badge', text: String(active) }));
    const tiles = this.definition.tiles;
    this.layoutButtons.hidden = !tiles;
    this.sizeControl.hidden = !tiles;
    this.layoutButtons.replaceChildren(
      h('button', { type: 'button', title: 'Square grid', 'aria-label': 'Square grid', 'aria-pressed': String(settings.layout === 'square'), onClick: () => this.router.patch({ layout: null }) }, icon('grid', { size: 16 })),
      h('button', { type: 'button', title: 'Keep proportions', 'aria-label': 'Keep proportions', 'aria-pressed': String(settings.layout === 'justified'), onClick: () => this.router.patch({ layout: 'justified' }) }, icon('justified', { size: 16 })),
    );
    if (document.activeElement !== this.sizeInput) this.sizeInput.value = String(settings.tileSize);
    this.renderChips(filters);
  }

  renderChips(filters) {
    const chips = [];
    const chip = (label, patch) =>
      h('span', { class: 'chip' }, h('span', { text: label }), h('button', { type: 'button', 'aria-label': `Remove filter: ${label}`, onClick: () => this.setFilters(patch) }, icon('x', { size: 13 })));
    const labels = new Map(this.formats.map((format) => [format.key, format.label]));
    if (filters.types.length) chips.push(chip(`Type: ${filters.types.map((key) => labels.get(key) || key).join(', ')}`, { types: [] }));
    if (filters.from || filters.to) chips.push(chip(`Date: ${filters.from || '…'} → ${filters.to || '…'}`, { from: '', to: '' }));
    if (filters.minSize !== null || filters.maxSize !== null) {
      chips.push(chip(`Size: ${filters.minSize !== null ? bytes(filters.minSize) : '0'} – ${filters.maxSize !== null ? bytes(filters.maxSize) : '∞'}`, { minSize: null, maxSize: null }));
    }
    if (filters.orientation) chips.push(chip(filters.orientation[0].toUpperCase() + filters.orientation.slice(1), { orientation: '' }));
    if (filters.minMegapixels !== null) chips.push(chip(`≥ ${filters.minMegapixels} MP`, { minMegapixels: null }));
    if (filters.minDuration !== null || filters.maxDuration !== null) {
      chips.push(chip(`Length: ${filters.minDuration ?? 0} s – ${filters.maxDuration !== null ? `${filters.maxDuration} s` : '∞'}`, { minDuration: null, maxDuration: null }));
    }
    if (filters.camera) chips.push(chip(`Camera: ${filters.camera}`, { camera: '' }));
    if (!filters.hidden) chips.push(chip('No hidden files', { hidden: true }));
    if (filters.viewable) chips.push(chip('Viewable here only', { viewable: false }));
    if (filters.animated) chips.push(chip('Animated only', { animated: false }));
    if (chips.length > 1) {
      chips.push(h('button', { type: 'button', class: 'btn ghost small', text: 'Clear all', onClick: () => this.setFilters(advancedDefaults()) }));
    }
    this.chips.replaceChildren(...chips);
    this.chips.hidden = !chips.length;
  }

  openSortMenu() {
    const { sort } = this.settings();
    const entries = [{ heading: 'Sort by' }];
    for (const option of SORTS) {
      entries.push({
        label: option.label,
        checked: option.key === sort.key,
        onSelect: () => this.router.patch({ sort: option.key === 'date' ? null : option.key, dir: null }),
      });
    }
    if (sort.key !== 'random') {
      const labels = {
        date: ['Newest first', 'Oldest first'],
        modified: ['Newest first', 'Oldest first'],
        created: ['Newest first', 'Oldest first'],
        size: ['Largest first', 'Smallest first'],
        pixels: ['Largest first', 'Smallest first'],
        duration: ['Longest first', 'Shortest first'],
      }[sort.key] || ['Z to A', 'A to Z'];
      const fallback = SORTS.find((entry) => entry.key === sort.key).dir;
      entries.push('separator', { heading: 'Order' });
      entries.push({ label: labels[0], checked: sort.dir === 'desc', onSelect: () => this.router.patch({ dir: fallback === 'desc' ? null : 'desc' }) });
      entries.push({ label: labels[1], checked: sort.dir === 'asc', onSelect: () => this.router.patch({ dir: fallback === 'asc' ? null : 'asc' }) });
    } else {
      entries.push('separator', { label: 'Shuffle again', icon: 'shuffle', onSelect: () => {
        this.seed = Math.floor(Math.random() * 2 ** 31);
        this.listCache.key = '';
        this.refresh(true);
      } });
    }
    showMenu(this.sortButton, entries);
  }

  toggleFilters(open = !this.filtersOpen) {
    this.filtersOpen = open;
    this.filterPanel.el.hidden = !open;
    this.filterPanel.backdrop.hidden = !open;
    if (open) this.filterPanel.render(this.settings().filters, this.facts());
    this.filterButton.setAttribute('aria-pressed', String(open));
  }

  /** Numbers the filter panel shows: formats present, cameras, date range. */
  facts() {
    const derived = this.catalog.derived();
    const basis = this.settings().filters.dateBasis;
    if (this.factsCache && this.factsCache.version === this.catalog.version && this.factsCache.basis === basis) {
      return this.factsCache;
    }
    let low = null;
    let high = null;
    let hasVideos = false;
    let hasAnimated = false;
    for (const item of derived.list) {
      const when = dateOf(item, basis);
      if (when !== null) {
        if (low === null || when < low) low = when;
        if (high === null || when > high) high = when;
      }
      if (item.kind === 'video') hasVideos = true;
      if (item.animated) hasAnimated = true;
    }
    this.factsCache = {
      version: this.catalog.version,
      basis,
      formats: this.formats,
      formatCounts: derived.formatCounts,
      cameras: [...derived.cameras.entries()].sort((a, b) => b[1] - a[1] || compareNames(a[0], b[0])),
      dateRange: low !== null ? `${wallDate(low)} – ${wallDate(high)}` : '',
      hasVideos,
      hasAnimated,
    };
    return this.factsCache;
  }

  setFilters(patch) {
    const current = this.settings().filters;
    const next = { ...current };
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) next[key] = value;
    const params = filtersToParams(next, new URLSearchParams(this.router.current.params));
    params.delete('item');
    this.router.go(this.router.current.view || 'grid', params, { replace: true });
  }

  /* ---- header ------------------------------------------------------------------------- */

  updateHeader() {
    const album = this.album;
    if (this.screen !== 'album' || !album || album.status === 'empty') return;
    document.title = `${album.name} · Lurker`;
    this.titleName.textContent = album.name;
    this.titlePath.replaceChildren(h('bdi', { text: album.root }));
    this.titlePath.title = album.root;
    const counts = album.counts;
    const probe = album.probe;
    const bar = this.scanbar.firstChild;
    let text;
    let spinning = true;
    if (album.status === 'scanning') {
      text = album.scan.rescan
        ? `Rescanning… ${number(album.scan.directories)} folders`
        : `Scanning… ${plural(counts.items, 'file')} in ${plural(album.scan.directories, 'folder')}`;
      this.scanbar.hidden = false;
      this.scanbar.classList.add('indeterminate');
    } else if (probe.done < probe.total) {
      const percent = Math.floor((probe.done / probe.total) * 100);
      text = `Reading details ${percent}%`;
      this.scanbar.hidden = false;
      this.scanbar.classList.remove('indeterminate');
      bar.style.width = `${percent}%`;
    } else {
      spinning = false;
      text = '';
      this.scanbar.hidden = true;
    }
    // Once everything is read the toolbar's summary says it all; the line stays empty.
    this.statusLine.replaceChildren(...(spinning ? [h('span', { class: 'spinner' }), h('span', { class: 'status-text', text })] : []));
    if (album.scan.skipped && album.status === 'ready') {
      this.statusLine.title = `${plural(album.scan.skipped, 'folder')} could not be read: ${album.scan.errors.map((error) => error.path).join(', ')}`;
    } else {
      this.statusLine.title = '';
    }
    this.rescanButton.disabled = album.status === 'scanning';
  }

  emptyState(items) {
    if (items.length) return null;
    const album = this.album;
    if (!this.catalog.loaded || (album.status === 'scanning' && this.catalog.items.size === 0)) {
      return h(
        'div',
        { class: 'empty' },
        h('span', { class: 'spinner' }),
        h('h2', { text: 'Looking for images and videos…' }),
        h('p', { text: `Reading ${album.root} and every folder inside it.` }),
      );
    }
    if (this.catalog.items.size === 0) {
      return emptyState({
        glyph: 'image-off',
        title: 'No images or videos here',
        text: `Lurker looked through ${plural(album.scan.directories, 'folder')} of ${album.root} and found nothing to show.`,
        action: h(
          'div',
          { class: 'input-group' },
          h('button', { type: 'button', class: 'btn primary', onClick: () => this.closeAlbum(false) }, 'Choose another directory'),
          h('button', { type: 'button', class: 'btn', onClick: () => this.rescan() }, icon('refresh', { size: 16 }), 'Rescan'),
        ),
      });
    }
    return emptyState({
      glyph: 'search',
      title: 'Nothing matches',
      text: 'No image or video in this album matches the current search and filters.',
      action: h(
        'button',
        {
          type: 'button',
          class: 'btn primary',
          onClick: () => this.setFilters({ ...advancedDefaults(), kind: 'all', q: '' }),
        },
        'Clear search and filters',
      ),
    });
  }

  /* ---- actions ------------------------------------------------------------------------- */

  async closeAlbum(ask = true) {
    if (ask) {
      const confirmed = await confirmDialog({
        title: 'Close this album?',
        text: 'Everyone connected to this Lurker goes back to choosing a directory. Nothing is deleted.',
        confirm: 'Close album',
      });
      if (!confirmed) return;
    }
    this.closingHere = true;
    try {
      const status = await api.close();
      this.router.go('grid', new URLSearchParams(), { replace: true });
      this.onAlbum(status);
    } catch (error) {
      this.closingHere = false;
      toast(error.message, { kind: 'error' });
    }
  }

  async rescan() {
    try {
      await api.rescan(this.album.id);
      toast('Looking for new, changed and deleted files…');
    } catch (error) {
      toast(error.message, { kind: 'error' });
    }
  }

  async logout() {
    try {
      await api.logout();
    } finally {
      location.assign('/login');
    }
  }

  cycleTheme() {
    this.theme = THEMES[(THEMES.indexOf(this.theme) + 1) % THEMES.length];
    this.applyTheme();
    toast(this.theme === 'auto' ? 'Theme: follows the system' : `Theme: ${this.theme}`, { timeout: 1600 });
  }

  applyTheme() {
    if (this.theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = this.theme;
    if (this.themeButton) {
      this.themeButton.replaceChildren(icon(this.theme === 'dark' ? 'moon' : this.theme === 'light' ? 'sun' : 'contrast'));
      this.themeButton.title = `Theme: ${this.theme === 'auto' ? 'system' : this.theme}`;
    }
  }

  onKey(event) {
    if (this.screen !== 'album' || this.viewer.isOpen) return;
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (event.key === '/' && !typing) {
      event.preventDefault();
      this.searchInput.focus();
      this.searchInput.select();
    } else if (event.key === 'Escape' && this.filtersOpen && !typing) {
      this.toggleFilters(false);
    }
  }
}
