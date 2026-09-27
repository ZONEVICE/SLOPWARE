/**
 * Video tiles need a still frame, and the standard library cannot decode
 * video on the server, so the browser makes one: a hidden <video> loads the
 * file, seeks a little way in, and the frame is drawn onto a canvas and kept
 * as a small JPEG blob. Three videos are processed at a time, those on screen
 * first, from the top; requests from tiles that left the page are dropped.
 * Posters live in memory until the album changes.
 */
const LIMIT = 3;
const MAX_WIDTH = 640;
const TIMEOUT = 20000;

const cache = new Map(); // key -> { state, src, duration, url, width, height, waiters }
const queue = [];
let active = 0;

export function posterFor(key) {
  const entry = cache.get(key);
  return entry && entry.state === 'ready' ? entry : null;
}

/**
 * Ask for the poster of the video at `src`. `callback(entry | null)` runs
 * once, with null when no frame could be made. Returns { cancel, setVisible }:
 * visible requests are served first, in the order they became visible (top
 * to bottom on screen); the others only when nothing visible is waiting.
 */
export function requestPoster(key, src, duration, callback) {
  let entry = cache.get(key);
  if (entry && (entry.state === 'ready' || entry.state === 'failed')) {
    callback(entry.state === 'ready' ? entry : null);
    return { cancel() {}, setVisible() {} };
  }
  if (!entry) {
    entry = { state: 'idle', src, duration, url: null, width: 0, height: 0, waiters: new Set(), visible: 0, since: 0 };
    cache.set(key, entry);
  }
  const waiter = { callback, visible: false };
  entry.waiters.add(waiter);
  if (entry.state === 'idle') {
    entry.state = 'queued';
    queue.push(key);
  }
  const setVisible = (visible) => {
    if (waiter.visible === visible) return;
    waiter.visible = visible;
    entry.visible += visible ? 1 : -1;
    if (visible) entry.since = ++clock;
    pump();
  };
  pump();
  return {
    setVisible,
    cancel() {
      setVisible(false);
      entry.waiters.delete(waiter);
      if (!entry.waiters.size && entry.state === 'queued') {
        const index = queue.indexOf(key);
        if (index >= 0) queue.splice(index, 1);
        entry.state = 'idle';
      }
    },
  };
}

let clock = 0;

export function clearPosters() {
  for (const entry of cache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  cache.clear();
  queue.length = 0;
}

function next() {
  let best = -1;
  for (let index = 0; index < queue.length; index += 1) {
    const entry = cache.get(queue[index]);
    if (entry && entry.visible > 0 && (best < 0 || entry.since < cache.get(queue[best]).since)) best = index;
  }
  if (best < 0) best = 0; // nothing on screen is waiting: prefetch the oldest request
  return queue.splice(best, 1)[0];
}

function pump() {
  while (active < LIMIT && queue.length) {
    const key = next();
    const entry = cache.get(key);
    if (!entry || entry.state !== 'queued') continue;
    entry.state = 'working';
    active += 1;
    capture(entry)
      .then((result) => {
        Object.assign(entry, result, { state: 'ready' });
      })
      .catch(() => {
        entry.state = 'failed';
      })
      .finally(() => {
        active -= 1;
        const waiters = [...entry.waiters];
        entry.waiters.clear();
        entry.visible = 0;
        for (const waiter of waiters) waiter.callback(entry.state === 'ready' ? entry : null);
        pump();
      });
  }
}

function capture(entry) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    let finished = false;
    const done = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load(); // releases the decoder and the connection
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => done(new Error('timeout')), TIMEOUT);
    video.addEventListener('error', () => done(new Error('decode')));
    video.addEventListener('loadedmetadata', () => {
      const length = Number.isFinite(video.duration) ? video.duration : entry.duration || 0;
      // A tenth of the way in skips black intros, but never more than 10 s.
      const target = length > 0 ? Math.min(10, Math.max(0.05, length * 0.1)) : 0.5;
      try {
        video.currentTime = Math.min(target, Math.max(0, length - 0.05) || target);
      } catch {
        done(new Error('seek'));
      }
    });
    video.addEventListener('seeked', () => {
      if (!video.videoWidth || !video.videoHeight) {
        done(new Error('no video track'));
        return;
      }
      const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      try {
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      } catch (error) {
        done(error);
        return;
      }
      canvas.toBlob(
        (blob) => {
          if (!blob) done(new Error('encode'));
          else done(null, { url: URL.createObjectURL(blob), width: video.videoWidth, height: video.videoHeight });
        },
        'image/jpeg',
        0.82,
      );
    });
    video.src = entry.src;
  });
}
