/**
 * Filtering and sorting, as pure functions of (items, filters, sort).
 * The whole state lives in the URL (#/grid?kind=video&sort=size...), so a
 * reload, the back button or a copied link bring back the same view.
 */
import { compareNames } from './catalog.js';
import { parseDateInput, wallClock } from './format.js';

export const DEFAULT_FILTERS = Object.freeze({
  kind: 'all', // all | image | video
  q: '',
  types: [], // format keys; empty means every type
  dateBasis: 'best', // best | taken | modified | created
  from: '',
  to: '',
  minSize: null, // bytes
  maxSize: null,
  orientation: '', // '' | landscape | portrait | square | panorama
  minMegapixels: null,
  minDuration: null, // seconds
  maxDuration: null,
  hidden: true, // include hidden files and folders
  viewable: false, // only what this browser can display
  animated: false, // only animated images
  camera: '',
});

export const SORTS = [
  { key: 'date', label: 'Date', dir: 'desc' },
  { key: 'modified', label: 'Date modified', dir: 'desc' },
  { key: 'created', label: 'Date created', dir: 'desc' },
  { key: 'name', label: 'Name', dir: 'asc' },
  { key: 'size', label: 'Size', dir: 'desc' },
  { key: 'pixels', label: 'Resolution', dir: 'desc' },
  { key: 'duration', label: 'Duration', dir: 'desc' },
  { key: 'type', label: 'Type', dir: 'asc' },
  { key: 'folder', label: 'Folder', dir: 'asc' },
  { key: 'random', label: 'Shuffle', dir: 'asc' },
];

export const DATE_BASES = [
  { key: 'best', label: 'Taken, else the earliest file date' },
  { key: 'taken', label: 'Taken (camera date)' },
  { key: 'created', label: 'Created (file system)' },
  { key: 'modified', label: 'Modified' },
];

/**
 * Wall-clock seconds of an item for a date basis, or null.
 *
 * "best" is the capture date when the file has one (EXIF, video metadata),
 * else the earlier of the file's creation and modification times: copying a
 * file gives it a new creation time but usually keeps its modification time,
 * and editing it does the opposite, so the earlier one is closest to when the
 * picture was made.
 */
export function dateOf(item, basis = 'best') {
  const taken = item.taken === null ? null : item.takenUtc ? wallClock(item.taken) : item.taken;
  const created = item.birth === null ? null : wallClock(item.birth);
  const modified = wallClock(item.mtime);
  switch (basis) {
    case 'taken':
      return taken;
    case 'created':
      return created;
    case 'modified':
      return modified;
    default:
      return taken ?? (created === null ? modified : Math.min(created, modified));
  }
}

export function normalize(text) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * @param {object[]} items
 * @param {object} filters
 * @param {{ searchKey: (item) => string, viewable: (item) => boolean }} context
 */
export function filterItems(items, filters, context) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const words = normalize(f.q.trim()).split(/\s+/).filter(Boolean);
  const types = f.types.length ? new Set(f.types) : null;
  const from = parseDateInput(f.from);
  const toStart = parseDateInput(f.to);
  const to = toStart === null ? null : toStart + 86400; // "to" includes that whole day
  const minPixels = f.minMegapixels ? f.minMegapixels * 1e6 : 0;
  return items.filter((item) => {
    if (f.kind !== 'all' && item.kind !== f.kind) return false;
    if (types && !types.has(item.format.key)) return false;
    if (!f.hidden && item.hidden) return false;
    if (f.minSize !== null && item.size < f.minSize) return false;
    if (f.maxSize !== null && item.size > f.maxSize) return false;
    if (from !== null || to !== null) {
      const when = dateOf(item, f.dateBasis);
      if (when === null) return false;
      if (from !== null && when < from) return false;
      if (to !== null && when >= to) return false;
    }
    if (f.orientation) {
      if (!item.width || !item.height) return false;
      const ratio = item.width / item.height;
      if (f.orientation === 'landscape' && !(ratio > 1.05)) return false;
      if (f.orientation === 'portrait' && !(ratio < 0.95)) return false;
      if (f.orientation === 'square' && !(ratio >= 0.95 && ratio <= 1.05)) return false;
      if (f.orientation === 'panorama' && !(ratio >= 2 || ratio <= 0.5)) return false;
    }
    if (minPixels && !(item.width && item.height && item.width * item.height >= minPixels)) return false;
    if (f.minDuration !== null || f.maxDuration !== null) {
      if (item.kind !== 'video' || item.duration === null) return false;
      if (f.minDuration !== null && item.duration < f.minDuration) return false;
      if (f.maxDuration !== null && item.duration > f.maxDuration) return false;
    }
    if (f.animated && !item.animated) return false;
    if (f.camera && item.camera !== f.camera) return false;
    if (f.viewable && !context.viewable(item)) return false;
    if (words.length) {
      const key = context.searchKey(item);
      for (const word of words) if (!key.includes(word)) return false;
    }
    return true;
  });
}

/** Stable sort; items without the sort value go last whatever the direction. */
export function sortItems(items, sortKey, dir, context) {
  const sign = dir === 'asc' ? 1 : -1;
  const byName = (a, b) => compareNames(a.name, b.name) || a.id - b.id;
  let value;
  switch (sortKey) {
    case 'name':
      return [...items].sort((a, b) => sign * byName(a, b));
    case 'type':
      return [...items].sort((a, b) => sign * (compareNames(a.format.label, b.format.label) || byName(a, b)));
    case 'folder':
      return [...items].sort((a, b) => sign * (compareNames(context.folderPath(a), context.folderPath(b)) || byName(a, b)));
    case 'random':
      return shuffled(items, context.seed || 1);
    case 'modified':
      value = (item) => item.mtime;
      break;
    case 'created':
      value = (item) => item.birth;
      break;
    case 'size':
      value = (item) => item.size;
      break;
    case 'pixels':
      value = (item) => (item.width && item.height ? item.width * item.height : null);
      break;
    case 'duration':
      value = (item) => item.duration;
      break;
    default:
      value = (item) => dateOf(item, context.dateBasis || 'best');
  }
  const keyed = items.map((item) => [value(item), item]);
  keyed.sort((a, b) => {
    const missingA = a[0] === null || a[0] === undefined;
    const missingB = b[0] === null || b[0] === undefined;
    if (missingA || missingB) return missingA === missingB ? byName(a[1], b[1]) : missingA ? 1 : -1;
    return sign * (a[0] - b[0]) || byName(a[1], b[1]);
  });
  return keyed.map((pair) => pair[1]);
}

/** A deterministic shuffle, so "Shuffle" does not reshuffle on every update. */
function shuffled(items, seed) {
  let state = seed >>> 0 || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const copy = [...items].sort((a, b) => a.id - b.id);
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/* ---- URL <-> state ------------------------------------------------------ */

const numberOrNull = (value) => (value === null || value === '' || Number.isNaN(Number(value)) ? null : Number(value));

export function filtersFromParams(params) {
  return {
    kind: ['image', 'video'].includes(params.get('kind')) ? params.get('kind') : 'all',
    q: params.get('q') || '',
    types: (params.get('types') || '').split(',').filter(Boolean),
    dateBasis: DATE_BASES.some((b) => b.key === params.get('date')) ? params.get('date') : 'best',
    from: params.get('from') || '',
    to: params.get('to') || '',
    minSize: numberOrNull(params.get('minsize')),
    maxSize: numberOrNull(params.get('maxsize')),
    orientation: ['landscape', 'portrait', 'square', 'panorama'].includes(params.get('orient')) ? params.get('orient') : '',
    minMegapixels: numberOrNull(params.get('minmp')),
    minDuration: numberOrNull(params.get('mindur')),
    maxDuration: numberOrNull(params.get('maxdur')),
    hidden: params.get('hidden') !== '0',
    viewable: params.get('viewable') === '1',
    animated: params.get('animated') === '1',
    camera: params.get('camera') || '',
  };
}

/** Write filters into URLSearchParams, leaving defaults out. */
export function filtersToParams(filters, params) {
  const set = (key, value, isDefault) => (isDefault ? params.delete(key) : params.set(key, String(value)));
  set('kind', filters.kind, filters.kind === 'all');
  set('q', filters.q, !filters.q);
  set('types', filters.types.join(','), !filters.types.length);
  set('date', filters.dateBasis, filters.dateBasis === 'best');
  set('from', filters.from, !filters.from);
  set('to', filters.to, !filters.to);
  set('minsize', filters.minSize, filters.minSize === null);
  set('maxsize', filters.maxSize, filters.maxSize === null);
  set('orient', filters.orientation, !filters.orientation);
  set('minmp', filters.minMegapixels, filters.minMegapixels === null);
  set('mindur', filters.minDuration, filters.minDuration === null);
  set('maxdur', filters.maxDuration, filters.maxDuration === null);
  set('hidden', '0', filters.hidden);
  set('viewable', '1', !filters.viewable);
  set('animated', '1', !filters.animated);
  set('camera', filters.camera, !filters.camera);
  return params;
}

/** How many advanced filters differ from the defaults (the kind and search are separate controls). */
export function activeFilterCount(filters) {
  let count = 0;
  if (filters.types.length) count += 1;
  if (filters.from || filters.to) count += 1;
  if (filters.minSize !== null || filters.maxSize !== null) count += 1;
  if (filters.orientation) count += 1;
  if (filters.minMegapixels !== null) count += 1;
  if (filters.minDuration !== null || filters.maxDuration !== null) count += 1;
  if (!filters.hidden) count += 1;
  if (filters.viewable) count += 1;
  if (filters.animated) count += 1;
  if (filters.camera) count += 1;
  return count;
}
