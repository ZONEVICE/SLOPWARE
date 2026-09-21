/**
 * Formatting helpers: timestamps, file sizes, initials and link detection.
 * Pure functions, no DOM, so they are trivially testable.
 */

/** Two-letter initials for an avatar, emoji-aware. */
export function initials(name) {
  const text = String(name || '').trim();
  if (!text) return '?';
  const words = text.split(/\s+/).filter(Boolean);
  const take = (word) => [...word][0] || '';
  if (words.length === 1) {
    const letters = [...words[0]];
    return (letters[0] + (letters[1] || '')).toUpperCase();
  }
  return (take(words[0]) + take(words[1])).toUpperCase();
}

/** "14:05" in the viewer's locale. */
export function clockTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "Today", "Yesterday" or a full date, for the day separators. */
export function dayLabel(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const startOf = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(date)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
  return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Compact relative time for room activity, e.g. "3m", "2h", "Apr 4". */
export function relativeTime(timestamp) {
  const delta = Date.now() - timestamp;
  if (delta < 45000) return 'just now';
  const minutes = Math.round(delta / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Human file size: 1.4 MB, 812 KB, 96 B. */
export function fileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || Number.isInteger(size) ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

/** Uppercase extension for the file card badge, e.g. "PDF". */
export function extensionLabel(name) {
  const match = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  return match ? match[1].toUpperCase() : '';
}

/** "3 people" / "1 person", used in the room header and Home cards. */
export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** mm:ss for a video duration. */
export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * Split text into plain and link segments.
 *
 * Returns descriptors rather than HTML so the caller can build real nodes; this
 * is what keeps message rendering free of `innerHTML`.
 * @param {string} text
 * @returns {{ type: 'text'|'link', value: string, href?: string }[]}
 */
export function linkify(text) {
  const pattern = /\b(https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"])/gi;
  const out = [];
  let last = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push({ type: 'text', value: text.slice(last, match.index) });
    out.push({ type: 'link', value: match[0], href: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}
