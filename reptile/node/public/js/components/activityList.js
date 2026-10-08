/**
 * The feed of recent synchronisation activity shown on both sides.
 */
import { h, replace } from '../core/dom.js';
import { formatBytes, timeAgo } from '../core/format.js';

const GLYPHS = {
  write: '⬤',
  mkdir: '▣',
  unlink: '✕',
  rmdir: '✕',
  rename: '→',
};

const VERBS = {
  sent: { write: 'Sent', mkdir: 'Created folder on the other side', unlink: 'Deleted on the other side', rmdir: 'Deleted folder on the other side', rename: 'Renamed on the other side' },
  received: { write: 'Received', mkdir: 'Created folder', unlink: 'Deleted', rmdir: 'Deleted folder', rename: 'Renamed' },
};

function describe(entry) {
  if (entry.op && (entry.kind === 'sent' || entry.kind === 'received')) {
    const verb = VERBS[entry.kind][entry.op] || entry.op;
    const target = entry.to ? `${entry.path} → ${entry.to}` : entry.path;
    const size = entry.op === 'write' && Number.isFinite(entry.size) ? ` (${formatBytes(entry.size)})` : '';
    return `${verb}: ${target}${size}`;
  }
  return entry.message || '';
}

function glyph(entry) {
  if (entry.kind === 'sent') return entry.op === 'write' ? '↑' : GLYPHS[entry.op] || '↑';
  if (entry.kind === 'received') return entry.op === 'write' ? '↓' : GLYPHS[entry.op] || '↓';
  if (entry.kind === 'warning') return '!';
  if (entry.kind === 'error') return '✕';
  return '•';
}

export function createActivityList() {
  const list = h('ul', { class: 'activity', 'aria-label': 'Recent activity' });
  let lastKey = '';

  return {
    el: list,
    /** @param {object[]} entries Most recent first. */
    update(entries = []) {
      const now = Date.now();
      const key = `${entries.map((entry) => entry.id).join(',')}|${Math.floor(now / 10_000)}`;
      if (key === lastKey) return;
      lastKey = key;
      if (entries.length === 0) {
        replace(list, h('li', { class: 'muted' }, h('span', { class: 'glyph', text: '·' }), h('span', { class: 'what', text: 'Nothing has happened yet.' })));
        return;
      }
      replace(
        list,
        entries.map((entry) =>
          h(
            'li',
            { class: entry.kind },
            h('span', { class: 'glyph', 'aria-hidden': 'true', text: glyph(entry) }),
            h('span', { class: 'what', text: describe(entry) }),
            h('time', { class: 'when', datetime: new Date(entry.at).toISOString(), text: timeAgo(entry.at, now) }),
          ),
        ),
      );
    },
  };
}
