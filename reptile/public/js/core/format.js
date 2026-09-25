/**
 * Formatting helpers for the interface.
 */

/** "1.4 MB", "12 KB", "999 B". */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

/** "just now", "12 s ago", "3 min ago", "2 h ago". */
export function timeAgo(timestamp, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(timestamp).toLocaleString();
}

/** "3 files", "1 file". */
export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "HTTP" / "HTTPS". */
export function protocolLabel(protocol) {
  return String(protocol || '').toUpperCase();
}

/** Last segment of an absolute path, for either separator. */
export function lastSegment(path) {
  const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || '';
}
