/**
 * Fuzzy matching for the quick pickers ("Go to File", the command palette):
 * the query's characters must appear in order; consecutive runs, word and
 * path-segment starts, and matches in the file name score higher.
 */

/**
 * Scores `text` against `query`. Returns null when it does not match, else
 * `{ score, positions }` (indices of the matched characters).
 */
export function fuzzyMatch(query, text) {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions = [];
  let score = 0;
  let ti = 0;
  let previous = -2;
  const nameStart = text.lastIndexOf('/') + 1;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi];
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    let bonus = 1;
    if (found === previous + 1) bonus += 5;
    const before = text[found - 1];
    if (found === 0 || before === '/' || before === '_' || before === '-' || before === '.' || before === ' ') bonus += 4;
    if (text[found] !== t[found] && before && before === before.toLowerCase()) bonus += 2; // camelCase hump
    if (found >= nameStart) bonus += 2;
    score += bonus;
    positions.push(found);
    previous = found;
    ti = found + 1;
  }
  score -= text.length * 0.02;
  if (t.startsWith(q, nameStart)) score += 10;
  return { score, positions };
}

/** Filters and sorts items by `key(item)`, best first, at most `limit`. */
export function fuzzyFilter(query, items, key, limit = 200) {
  if (!query.trim()) return items.slice(0, limit).map((item) => ({ item, positions: [] }));
  const results = [];
  for (const item of items) {
    const match = fuzzyMatch(query.trim(), key(item));
    if (match) results.push({ item, score: match.score, positions: match.positions });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
