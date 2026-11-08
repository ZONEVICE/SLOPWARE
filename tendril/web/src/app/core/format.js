/** Human-readable sizes, durations and dates. */

export function bytes(n) {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** "2h 05m", "12m", "45s". */
export function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 86400 * 2) return `${Math.floor(s / 86400)}d`;
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

export function dateTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString();
}
