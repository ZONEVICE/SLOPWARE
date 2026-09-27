/**
 * Tile geometry. Both layouts produce rows of { items, height, widths } so
 * every view can hand them to the same virtual list.
 */

/** Uniform square tiles, as many columns as fit around the target size. */
export function squareRows(items, width, { target = 180, gap = 4 } = {}) {
  const columns = Math.max(1, Math.round((width + gap) / (target + gap)));
  const size = Math.max(40, Math.floor((width - gap * (columns - 1)) / columns));
  const rows = [];
  for (let start = 0; start < items.length; start += columns) {
    const slice = items.slice(start, start + columns);
    rows.push({ items: slice, height: size, widths: slice.map(() => size) });
  }
  return { rows, columns, size };
}

/**
 * Justified rows (like Flickr or Google Photos): each row keeps the photos'
 * aspect ratios and is scaled to fill the width exactly. The last row keeps
 * the target height instead of being stretched.
 */
export function justifiedRows(items, width, { target = 180, gap = 4, aspect = (item) => 1 } = {}) {
  const rows = [];
  let row = [];
  let ratios = [];
  let ratioSum = 0;
  const flush = (last) => {
    if (!row.length) return;
    const spare = width - gap * (row.length - 1);
    let height = spare / ratioSum;
    if (last && height > target * 1.2) height = target;
    height = Math.max(40, Math.min(height, target * 2.5));
    const widths = ratios.map((ratio) => Math.max(24, Math.floor(ratio * height)));
    if (!last || height !== target) {
      // Give the rounding leftovers to the last tile so the row ends flush.
      const used = widths.reduce((sum, value) => sum + value, 0) + gap * (row.length - 1);
      widths[widths.length - 1] += Math.floor(width - used);
    }
    rows.push({ items: row, height: Math.round(height), widths });
    row = [];
    ratios = [];
    ratioSum = 0;
  };
  for (const item of items) {
    const ratio = Math.min(4, Math.max(0.25, aspect(item) || 1));
    row.push(item);
    ratios.push(ratio);
    ratioSum += ratio;
    if (ratioSum * target + gap * (row.length - 1) >= width) flush(false);
  }
  flush(true);
  return { rows };
}
