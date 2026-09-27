/**
 * Line icons on a 24x24 grid, drawn with currentColor so they follow the text
 * colour. icon('grid') returns a fresh <svg>.
 */
import { svg } from './dom.js';

const P = (d) => ['path', { d }];
const C = (cx, cy, r) => ['circle', { cx, cy, r }];
const R = (x, y, width, height, rx = 0) => ['rect', { x, y, width, height, rx }];
const L = (x1, y1, x2, y2) => ['line', { x1, y1, x2, y2 }];

const ICONS = {
  grid: [R(3, 3, 7, 7, 1.5), R(14, 3, 7, 7, 1.5), R(3, 14, 7, 7, 1.5), R(14, 14, 7, 7, 1.5)],
  justified: [R(3, 4, 10, 7, 1.5), R(15, 4, 6, 7, 1.5), R(3, 13, 5, 7, 1.5), R(10, 13, 11, 7, 1.5)],
  folder: [P('M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z')],
  'folder-open': [P('M3 17V7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1'), P('M3 17l2.4-6.2A2 2 0 0 1 7.3 9.5H20a1 1 0 0 1 .95 1.3L19 17a3 3 0 0 1-2.8 2H5a2 2 0 0 1-2-2z')],
  tree: [P('M4 5h6'), P('M4 5v14'), P('M4 12h5'), P('M4 19h5'), R(12, 3, 9, 4, 1), R(12, 10, 9, 4, 1), R(12, 17, 9, 4, 1)],
  calendar: [R(3, 5, 18, 16, 2), L(3, 10, 21, 10), L(8, 3, 8, 7), L(16, 3, 16, 7)],
  list: [L(9, 6, 21, 6), L(9, 12, 21, 12), L(9, 18, 21, 18), C(4.5, 6, 1), C(4.5, 12, 1), C(4.5, 18, 1)],
  image: [R(3, 4, 18, 16, 2.5), C(9, 10, 2), P('M21 16l-5-5-9 9')],
  video: [R(2.5, 5, 14, 14, 2.5), P('M16.5 10l5-3v10l-5-3z')],
  film: [R(3, 3, 18, 18, 2.5), L(7, 3, 7, 21), L(17, 3, 17, 21), L(3, 8, 7, 8), L(3, 16, 7, 16), L(17, 8, 21, 8), L(17, 16, 21, 16)],
  play: [P('M7 4.5v15l12.5-7.5z')],
  x: [L(6, 6, 18, 18), L(18, 6, 6, 18)],
  'chevron-left': [P('M15 5l-7 7 7 7')],
  'chevron-right': [P('M9 5l7 7-7 7')],
  'chevron-down': [P('M5 9l7 7 7-7')],
  'chevron-up': [P('M5 15l7-7 7 7')],
  'zoom-in': [C(10.5, 10.5, 6.5), L(15.5, 15.5, 21, 21), L(10.5, 7.5, 10.5, 13.5), L(7.5, 10.5, 13.5, 10.5)],
  'zoom-out': [C(10.5, 10.5, 6.5), L(15.5, 15.5, 21, 21), L(7.5, 10.5, 13.5, 10.5)],
  fit: [R(3, 4, 18, 16, 2.5), R(7.5, 8.5, 9, 7, 1.2)],
  fullscreen: [P('M4 9V4h5'), P('M20 9V4h-5'), P('M4 15v5h5'), P('M20 15v5h-5')],
  'exit-fullscreen': [P('M9 4v5H4'), P('M15 4v5h5'), P('M9 20v-5H4'), P('M15 20v-5h5')],
  download: [P('M12 4v11'), P('M7 10.5l5 5 5-5'), P('M4 19.5h16')],
  info: [C(12, 12, 9), L(12, 11, 12, 16.5), P('M12 7.6v.1')],
  'rotate-right': [P('M20 12a8 8 0 1 1-2.3-5.6'), P('M20 4v4.6h-4.6')],
  'rotate-left': [P('M4 12a8 8 0 1 0 2.3-5.6'), P('M4 4v4.6h4.6')],
  refresh: [P('M20 11a8 8 0 0 0-14.3-4.8L4 8'), P('M4 4v4h4'), P('M4 13a8 8 0 0 0 14.3 4.8L20 16'), P('M20 20v-4h-4')],
  lock: [R(4.5, 10.5, 15, 10.5, 2), P('M8 10.5V7.5a4 4 0 0 1 8 0v3')],
  sun: [C(12, 12, 4), P('M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4')],
  moon: [P('M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z')],
  contrast: [C(12, 12, 9), P('M12 3a9 9 0 0 1 0 18z')],
  sliders: [L(4, 7, 11, 7), L(15, 7, 20, 7), C(13, 7, 2), L(4, 17, 7, 17), L(11, 17, 20, 17), C(9, 17, 2)],
  search: [C(11, 11, 7), L(16, 16, 21, 21)],
  'sort-desc': [P('M7 4v16'), P('M3.5 16.5L7 20l3.5-3.5'), L(13, 6, 21, 6), L(13, 11, 19, 11), L(13, 16, 16, 16)],
  'sort-asc': [P('M7 20V4'), P('M3.5 7.5L7 4l3.5 3.5'), L(13, 6, 16, 6), L(13, 11, 19, 11), L(13, 16, 21, 16)],
  check: [P('M4.5 12.5l5 5 10-11')],
  alert: [P('M12 3.5l9.5 16.5h-19z'), L(12, 10, 12, 14), P('M12 17.2v.1')],
  home: [P('M3.5 11L12 4l8.5 7'), P('M6 9.5V20h12V9.5')],
  clock: [C(12, 12, 9), P('M12 7v5l3 2')],
  eye: [P('M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z'), C(12, 12, 3)],
  slideshow: [R(3, 4, 18, 13, 2), P('M10 8.5v5l4-2.5z'), L(8, 21, 16, 21)],
  shuffle: [P('M16 3.5h4.5V8'), P('M4 20L20.5 3.5'), P('M20.5 16v4.5H16'), P('M15 15l5.5 5.5'), P('M4 4l5 5')],
  external: [P('M14 4h6v6'), L(20, 4, 11, 13), P('M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10')],
  file: [P('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z'), P('M14 3v5h5')],
  'image-off': [P('M3 3l18 18'), P('M9 4.5h10a2 2 0 0 1 2 2V17'), P('M3.5 6.2A2.5 2.5 0 0 0 3 7.5v10a2.5 2.5 0 0 0 2.5 2.5h13.3'), P('M14 14l-2.5-2.5L6 17')],
  more: [C(5, 12, 1.3), C(12, 12, 1.3), C(19, 12, 1.3)],
};

/**
 * @param {keyof ICONS} name
 * @param {{ size?: number, class?: string, label?: string }} [options]
 */
export function icon(name, { size = 20, class: className = '', label } = {}) {
  const shapes = ICONS[name] || ICONS.file;
  const el = svg(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: name === 'play' ? 'currentColor' : 'none',
      stroke: 'currentColor',
      'stroke-width': 1.8,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      class: ['icon', className].filter(Boolean).join(' '),
      'aria-hidden': label ? null : 'true',
      role: label ? 'img' : null,
      'aria-label': label || null,
    },
    shapes.map(([tag, attrs]) => svg(tag, attrs)),
  );
  return el;
}

/** The brand mark: the same eye as /icon.svg, as an <img>. */
export function logo(size = 28) {
  const img = document.createElement('img');
  img.src = '/icon.svg';
  img.width = size;
  img.height = size;
  img.alt = '';
  img.className = 'logo';
  img.draggable = false;
  return img;
}
