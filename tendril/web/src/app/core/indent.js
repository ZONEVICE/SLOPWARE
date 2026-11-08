/**
 * Guesses a file's indentation (tabs or spaces, and the width) from its
 * content, like VS Code's "detect indentation". Looks at the first lines
 * only, so it is cheap even for big files.
 */
export function detectIndent(text, fallback = { tabs: false, size: 4 }) {
  let tabLines = 0;
  let spaceLines = 0;
  const widths = new Map();
  let previous = 0;
  let checked = 0;
  for (const line of text.split('\n', 2000)) {
    if (!line.trim()) continue;
    checked += 1;
    if (line[0] === '\t') {
      tabLines += 1;
      continue;
    }
    const spaces = line.length - line.trimStart().length;
    if (line[spaces - 1] === '\t') continue;
    if (spaces > 0) spaceLines += 1;
    const delta = Math.abs(spaces - previous);
    if (delta > 1 && delta <= 8) widths.set(delta, (widths.get(delta) || 0) + 1);
    previous = spaces;
  }
  if (checked === 0 || (tabLines === 0 && spaceLines === 0)) return fallback;
  if (tabLines > spaceLines) return { tabs: true, size: fallback.size };
  let best = fallback.size;
  let bestCount = 0;
  for (const [width, count] of widths) {
    if (count > bestCount || (count === bestCount && width < best)) {
      best = width;
      bestCount = count;
    }
  }
  return { tabs: false, size: bestCount ? best : fallback.size };
}
