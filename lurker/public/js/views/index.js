/**
 * The album views, in the order of the view switcher. A view module exports
 * { id, label, icon, tiles, create(ctx) -> { el, update, sequence, reveal,
 * resetScroll, destroy } }. To add a view, write the module and add it here.
 * `sequence()` returns the items in the order shown: the viewer steps through
 * it. The first view is the default: the whole album in one grid.
 */
import folders from './folders.js';
import grid from './grid.js';
import list from './list.js';
import timeline from './timeline.js';
import tree from './tree.js';

export const VIEWS = [grid, folders, tree, timeline, list];

export function findView(id) {
  return VIEWS.find((view) => view.id === id) || VIEWS[0];
}
