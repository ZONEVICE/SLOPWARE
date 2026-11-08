/**
 * Icons: one inline SVG sprite of hand-drawn 16x16 symbols, inserted once
 * into the page and reused everywhere with <use href="#i-name">.
 *
 * Conventions: stroke-based (`currentColor`, 1.4px, round joins) so icons
 * inherit the text color of the theme; shapes that must be solid carry the
 * class "fill". To add an icon, add one entry to ICONS.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const p = (d, cls = '') => `<path d="${d}"${cls ? ` class="${cls}"` : ''}/>`;
const dot = (cx, cy, r = 0.9) => `<circle cx="${cx}" cy="${cy}" r="${r}" class="fill"/>`;
const box = '<rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5"/>';
const sheet = p('M4 1.75h5.25L12.5 5v9.25H4z') + p('M9 1.75V5.25h3.5');
const gear =
  'M12.82 6.34 L14.55 6.61 L14.55 9.39 L12.82 9.66 L12.58 10.24 L13.62 11.65 L11.65 13.62 L10.24 12.58 L9.66 12.82 ' +
  'L9.39 14.55 L6.61 14.55 L6.34 12.82 L5.76 12.58 L4.35 13.62 L2.38 11.65 L3.42 10.24 L3.18 9.66 L1.45 9.39 ' +
  'L1.45 6.61 L3.18 6.34 L3.42 5.76 L2.38 4.35 L4.35 2.38 L5.76 3.42 L6.34 3.18 L6.61 1.45 L9.39 1.45 L9.66 3.18 ' +
  'L10.24 3.42 L11.65 2.38 L13.62 4.35 L12.58 5.76Z';
const lens = '<circle cx="6.75" cy="6.75" r="4.5"/>' + p('M10.25 10.25 14 14');
const trayBase = p('M2.25 10.25v2.5c0 .69.56 1.25 1.25 1.25h9c.69 0 1.25-.56 1.25-1.25v-2.5');
const twoSheets =
  '<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.25"/>' +
  p('M10.75 5.25V3.5c0-.69-.56-1.25-1.25-1.25H3.5c-.69 0-1.25.56-1.25 1.25v6c0 .69.56 1.25 1.25 1.25h1.75');

export const ICONS = {
  // Brand: a vine stem curling into a spiral, with one leaf.
  logo:
    p('M3.6 14.6C3 10.4 4.8 6.7 8.8 5.7c2.3-.6 4 .9 3.6 2.7-.3 1.4-1.8 2-2.8 1.3-.8-.5-.6-1.7.3-1.8') +
    p('M6.7 6.3C5.5 4 6.4 1.8 9.1 1.4c.4 2.6-.6 4.4-2.4 4.9z', 'fill'),
  file: sheet,
  'file-code': sheet + p('M7 8.25 5.75 9.75 7 11.25M9.5 8.25l1.25 1.5-1.25 1.5'),
  'file-text': sheet + p('M6 8.5h4.5M6 11h3'),
  'file-binary': sheet + p('M6.25 8.25v3') + '<rect x="8.25" y="8.25" width="2" height="3" rx=".6"/>',
  folder: p('M1.75 3.75c0-.55.45-1 1-1h3.1l1.5 1.5h5.9c.55 0 1 .45 1 1v6.95c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z'),
  'folder-open':
    p('M1.75 12.5V3.75c0-.55.45-1 1-1h3.1l1.5 1.5h4.9c.55 0 1 .45 1 1v1.5') +
    p('M1.75 12.5l1.9-5.1c.15-.4.5-.65.95-.65h9.5c.7 0 1.2.7.95 1.35l-1.65 4.4c-.15.4-.5.65-.95.65H2.6c-.5 0-.85-.3-.85-.65z'),
  'new-file': p('M8.5 14.25H4V1.75h5.25L12.5 5v3') + p('M9 1.75V5.25h3.5') + p('M12 10.25v4.5M9.75 12.5h4.5'),
  'new-folder':
    p('M7.75 13.25h-5c-.55 0-1-.45-1-1V3.75c0-.55.45-1 1-1h3.1l1.5 1.5h5.9c.55 0 1 .45 1 1v3') +
    p('M12 9.5v4.5M9.75 11.75h4.5'),
  save:
    p('M2.75 2h8.5l2 2v9.25c0 .41-.34.75-.75.75h-9.75a.75.75 0 0 1-.75-.75V2.75c0-.41.34-.75.75-.75z') +
    p('M5 2v3.25h5V2M4.75 14V9.5h6.5V14'),
  'save-all':
    p('M5 1.75h7l2 2v7.5') + p('M2.25 4.25h7.25l1.75 1.75v7.75H2.25z') + p('M4.25 4.25v2.5h4v-2.5M4 13.75v-3.5h5.25v3.5'),
  undo: p('M5.5 3.25 2.25 6.5l3.25 3.25') + p('M2.5 6.5h7a3.75 3.75 0 0 1 0 7.5H7.5'),
  redo: p('M10.5 3.25l3.25 3.25-3.25 3.25') + p('M13.5 6.5h-7a3.75 3.75 0 0 0 0 7.5h2'),
  search: lens,
  replace: p('M2 4.5h8M7.5 2l2.5 2.5L7.5 7') + p('M14 11.5H6M8.5 9 6 11.5 8.5 14'),
  wrap: p('M2 3.5h12M2 7.5h9.25a2.25 2.25 0 0 1 0 4.5H8') + p('M9.75 10.25 8 12l1.75 1.75') + p('M2 11.75h3.5'),
  minimap: box + p('M10.25 2.25v11.5') + p('M11.75 4.75h1M11.75 6.5h1M11.75 8.25h.5M4 4.75h4M4 6.5h3M4 8.25h4.5M4 10h2.5'),
  terminal: box + p('M4.5 6l2.25 2-2.25 2M8.5 10.5h3'),
  'sidebar-left': box + p('M6 2.25v11.5') + p('M3.5 4.75h1M3.5 6.75h1M3.5 8.75h1'),
  'sidebar-right': box + p('M10 2.25v11.5') + p('M11.5 4.75h1M11.5 6.75h1M11.5 8.75h1'),
  'swap-side': p('M2 5h11M10.25 2.25 13 5l-2.75 2.75') + p('M14 11H3M5.75 8.25 3 11l2.75 2.75'),
  panel: box + p('M1.75 9.75h12.5') + p('M4 11.75h4'),
  // Editor groups and previews.
  split: box + p('M8 2.25v11.5'),
  preview: box + p('M8 2.25v11.5') + p('M3.75 5.75h2.25M3.75 8h2.25M3.75 10.25h1.5') + '<circle cx="11.1" cy="7.6" r="1.6"/>' + p('M12.25 8.75l1.25 1.25'),
  // Git: a branch (two commits on one line, one off to the side), a commit, a diff.
  'source-control': '<circle cx="4.5" cy="3.25" r="1.5"/><circle cx="4.5" cy="12.75" r="1.5"/><circle cx="11.5" cy="5.25" r="1.5"/>' + p('M4.5 4.75v6.5') + p('M11.5 6.75c0 2.5-2.25 3-4.25 3.5-1.25.3-2.25.9-2.6 1.65'),
  'git-branch': '<circle cx="4.75" cy="3.5" r="1.4"/><circle cx="4.75" cy="12.5" r="1.4"/><circle cx="11.25" cy="5.25" r="1.4"/>' + p('M4.75 4.9v6.2') + p('M11.25 6.65c0 2.6-6.5 1.9-6.5 4.45'),
  'git-commit': '<circle cx="8" cy="8" r="2.6"/>' + p('M1.5 8h3.9M10.6 8h3.9'),
  diff: '<rect x="1.75" y="2.25" width="5.5" height="11.5" rx="1"/><rect x="8.75" y="2.25" width="5.5" height="11.5" rx="1"/>' + p('M3.25 6h2.5M10.25 6h2.5M11.5 4.75v2.5M3.25 10h2.5'),
  settings: p(gear) + '<circle cx="8" cy="8" r="2.1"/>',
  close: p('M4 4l8 8M12 4l-8 8'),
  'chevron-right': p('M6 3.5 10.5 8 6 12.5'),
  'chevron-down': p('M3.5 6 8 10.5 12.5 6'),
  'chevron-up': p('M3.5 10 8 5.5 12.5 10'),
  more: dot(3.5, 8, 1.15) + dot(8, 8, 1.15) + dot(12.5, 8, 1.15),
  refresh: p('M13.25 8A5.25 5.25 0 1 1 11.7 4.3') + p('M13 1.75v3.25H9.75'),
  'collapse-all':
    '<rect x="4.5" y="4.5" width="9.5" height="9.5" rx="1.25"/>' + p('M2 11V3.25C2 2.56 2.56 2 3.25 2H11') + p('M7 9.25h4.5'),
  upload: p('M8 10.5V2.25M4.75 5.5 8 2.25l3.25 3.25') + trayBase,
  download: p('M8 2.25v8.25M4.75 7.25 8 10.5l3.25-3.25') + trayBase,
  copy: twoSheets,
  paste:
    p('M10.5 3h1.25c.69 0 1.25.56 1.25 1.25v8.5c0 .69-.56 1.25-1.25 1.25h-7.5C3.56 14 3 13.44 3 12.75v-8.5C3 3.56 3.56 3 4.25 3H5.5') +
    '<rect x="5.5" y="1.75" width="5" height="2.5" rx=".75"/>',
  cut: '<circle cx="4.5" cy="11.75" r="2"/><circle cx="11.5" cy="11.75" r="2"/>' + p('M5.9 10.3 12 2.25M10.1 10.3 4 2.25'),
  trash:
    p('M2.5 4h11M6.25 4V2.5h3.5V4') +
    p('M3.75 4l.7 9.1c.05.65.6 1.15 1.25 1.15h4.6c.65 0 1.2-.5 1.25-1.15l.7-9.1') +
    p('M6.5 6.75v4.5M9.5 6.75v4.5'),
  rename: p('M10.75 2.25l3 3-7.75 7.75H3v-3z') + p('M9.25 3.75l3 3'),
  duplicate: twoSheets + p('M9.5 7.5v4M7.5 9.5h4'),
  image: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/>' + '<circle cx="5.5" cy="6.25" r="1.25"/>' + p('M14.25 10.5 10.5 7l-6.75 6.25'),
  video: '<rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5"/>' + p('M6.5 5.75v4.5L10.25 8z'),
  audio: p('M6 12.25V3.5l7.25-1.5v8.75') + '<circle cx="4.25" cy="12.25" r="1.75"/><circle cx="11.5" cy="10.75" r="1.75"/>',
  pdf: sheet + p('M5.5 12.25c1.5-1.25 2.5-3 3-5 .25-1-.75-1.25-.85-.4-.2 1.6 1.3 3.4 3.1 3.65.75.1.85-.85.1-.95-1.75-.25-3.85.55-5.35 2.7'),
  json: p('M5.5 2.25c-1.5 0-1.75.75-1.75 2v1.5c0 1-.75 1.75-1.75 2.25 1 .5 1.75 1.25 1.75 2.25v1.5c0 1.25.25 2 1.75 2') +
    p('M10.5 2.25c1.5 0 1.75.75 1.75 2v1.5c0 1 .75 1.75 1.75 2.25-1 .5-1.75 1.25-1.75 2.25v1.5c0 1.25-.25 2-1.75 2'),
  markdown: '<rect x="1.25" y="3.25" width="13.5" height="9.5" rx="1.5"/>' + p('M3.75 10.25v-4.5l2 2.25 2-2.25v4.5') + p('M11.25 5.75v4.5M9.75 8.75l1.5 1.5 1.5-1.5'),
  archive: '<rect x="2.25" y="1.75" width="11.5" height="12.5" rx="1.25"/>' + p('M8 1.75v1.5M8 4.25v1.5M8 6.75v1.5') + '<rect x="6.75" y="9.25" width="2.5" height="2.5" rx=".5"/>',
  lock: '<rect x="3" y="7" width="10" height="7.25" rx="1.5"/>' + p('M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2') + dot(8, 10.6),
  eye: p('M1.5 8s2.4-4.75 6.5-4.75S14.5 8 14.5 8 12.1 12.75 8 12.75 1.5 8 1.5 8z') + '<circle cx="8" cy="8" r="2"/>',
  'eye-off':
    p('M6.4 3.45A6.8 6.8 0 0 1 8 3.25C12.1 3.25 14.5 8 14.5 8a11 11 0 0 1-1.7 2.3M10.1 10.6a3 3 0 0 1-4.7-1.7M4.1 4.6C2.4 5.8 1.5 8 1.5 8s2.4 4.75 6.5 4.75c1 0 1.9-.25 2.7-.65') +
    p('M2 2l12 12'),
  power: p('M8 1.75v6') + p('M4.6 3.9a5.25 5.25 0 1 0 6.8 0'),
  palette:
    p('M8 1.75a6.25 6.25 0 1 0 0 12.5c.9 0 1.35-.6 1.35-1.25 0-.9-.85-1.2-.85-2 0-.7.55-1.25 1.25-1.25h1.5a3 3 0 0 0 3-3C14.25 4.2 11.45 1.75 8 1.75z') +
    dot(4.75, 7.5) + dot(6.5, 4.6) + dot(9.9, 4.75),
  command: p('M3 4.25 6.75 8 3 11.75M8.5 12h4.5'),
  home: p('M2 7.25 8 2l6 5.25') + p('M3.75 6v7.25h3.25V9.75h2v3.5h3.25V6'),
  drive: '<rect x="1.75" y="4.5" width="12.5" height="7" rx="1.5"/>' + p('M4.25 8h3') + dot(11.25, 8),
  'arrow-up': p('M8 13.5V2.75M3.75 7 8 2.75 12.25 7'),
  'arrow-left': p('M13.5 8H2.75M7 3.75 2.75 8 7 12.25'),
  check: p('M3 8.5 6.5 12 13 4.5'),
  warning: p('M8 2.25 14.25 13.25H1.75z') + p('M8 6.5v3') + dot(8, 11.25, 0.8),
  info: '<circle cx="8" cy="8" r="6.25"/>' + p('M8 7.25v4') + dot(8, 5, 0.8),
  error: '<circle cx="8" cy="8" r="6.25"/>' + p('M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5'),
  help: '<circle cx="8" cy="8" r="6.25"/>' + p('M6.25 6.25a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.75.65-.75 1.15v.25') + dot(8, 11.25, 0.8),
  plus: p('M8 3v10M3 8h10'),
  minus: p('M3 8h10'),
  files: p('M5.5 1.75h4.75l3 3v7.5h-7.75z') + p('M10 1.75v3.25h3.25') + p('M3.5 4.75v9.5h7'),
  link: p('M6.75 9.25 9.25 6.75') + p('M7.5 4.5 8.75 3.25a2.47 2.47 0 0 1 3.5 3.5L11 8M9 11.5l-1.25 1.25a2.47 2.47 0 0 1-3.5-3.5L5.5 8'),
  hourglass:
    p('M4 1.75h8M4 14.25h8') + p('M5 1.75v2.5c0 1.6 3 2.4 3 3.75 0-1.35 3-2.15 3-3.75v-2.5') + p('M5 14.25v-2.5c0-1.6 3-2.4 3-3.75 0 1.35 3 2.15 3 3.75v2.5'),
  logout: p('M6 2.25H3.25c-.55 0-1 .45-1 1v9.5c0 .55.45 1 1 1H6') + p('M10.25 4.75 13.5 8l-3.25 3.25M13.5 8H6'),
  keyboard:
    '<rect x="1.25" y="3.75" width="13.5" height="8.5" rx="1.5"/>' +
    dot(4, 6.5, 0.7) + dot(6.67, 6.5, 0.7) + dot(9.33, 6.5, 0.7) + dot(12, 6.5, 0.7) + dot(4, 9.25, 0.7) + dot(12, 9.25, 0.7) +
    p('M6.25 9.25h3.5'),
  format: p('M2 3.5h12M2 6.5h8M2 9.5h12M2 12.5h8'),
  comment: p('M6 3.5 4 12.5M10 3.5 8 12.5'),
  'zoom-in': lens + p('M6.75 4.75v4M4.75 6.75h4'),
  'zoom-out': lens + p('M4.75 6.75h4'),
  fit: p('M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5'),
  'actual-size': box + p('M5 10V6l-1 .75M10.5 10V6l-1 .75') + dot(7.75, 7, 0.55) + dot(7.75, 9.25, 0.55),
  external: p('M9.5 2.25h4.25V6.5M13.5 2.5 7.5 8.5') + p('M11.75 9.5v3.25c0 .55-.45 1-1 1h-7.5c-.55 0-1-.45-1-1v-7.5c0-.55.45-1 1-1H6.5'),
  menu: p('M2.5 4h11M2.5 8h11M2.5 12h11'),
  maximize: p('M2.25 5.75v-3.5h3.5M10.25 2.25h3.5v3.5M13.75 10.25v3.5h-3.5M5.75 13.75h-3.5v-3.5'),
  restore: p('M5.75 2.25v3.5h-3.5M13.75 5.75h-3.5v-3.5M10.25 13.75v-3.5h3.5M2.25 10.25h3.5v3.5'),
  clear: p('M2 4h12M2 8h7M2 12h5') + p('M10.5 9.5l3.5 3.5M14 9.5l-3.5 3.5'),
  'go-to-file': sheet + p('M5.5 10.25h4.5M8.25 8.25l2 2-2 2'),
  'case': p('M1.75 12.5 4.5 3.5l2.75 9M2.75 9.5h3.5') + p('M12.75 8.25v4.25M12.75 10.25a2 2 0 1 1-4 0 2 2 0 0 1 4 0z'),
  'whole-word': p('M1.75 13.25h12.5') + p('M2.5 4.5l1 6 1.5-4.5 1.5 4.5 1-6') + p('M13.25 6.5v4.25M13.25 8.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0z'),
  sun: '<circle cx="8" cy="8" r="3"/>' + p('M8 1.25v1.5M8 13.25v1.5M1.25 8h1.5M13.25 8h1.5M3.2 3.2l1.05 1.05M11.75 11.75l1.05 1.05M3.2 12.8l1.05-1.05M11.75 4.25l1.05-1.05'),
  moon: p('M13.5 9.75A5.75 5.75 0 0 1 6.25 2.5a5.75 5.75 0 1 0 7.25 7.25z'),
  'circle-dot': '<circle cx="8" cy="8" r="3.5" class="fill"/>',
  editor: box + p('M4.25 5.25h4M4.25 7.5h7M4.25 9.75h5.5'),
  play: p('M5 3.25v9.5L12.5 8z'),
};

/** Inserts the sprite into the document (once). */
export function installIcons(doc = document) {
  if (doc.getElementById('tendril-icons')) return;
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.id = 'tendril-icons';
  svg.setAttribute('aria-hidden', 'true');
  svg.style.display = 'none';
  svg.innerHTML = Object.entries(ICONS)
    .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 16 16">${body}</symbol>`)
    .join('');
  doc.body.prepend(svg);
}

/**
 * An <svg class="icon"> element showing `name`.
 * @param {string} name key of ICONS
 * @param {string} [extraClass]
 */
export function icon(name, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon icon-${name}${extraClass ? ` ${extraClass}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
