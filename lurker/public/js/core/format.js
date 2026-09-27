/** Numbers, sizes, durations and dates for people. */

const numberFormat = new Intl.NumberFormat();

export function number(value) {
  return numberFormat.format(value || 0);
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${number(count)} ${count === 1 ? singular : pluralForm}`;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 1536 -> "1.5 KB" (powers of 1024, like file managers). */
export function bytes(value) {
  let size = Number(value) || 0;
  let unit = 0;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${parseFloat(size.toFixed(digits))} ${UNITS[unit]}`;
}

/** 83.2 -> "1:23"; 3723 -> "1:02:03". */
export function duration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function pixels(width, height) {
  if (!width || !height) return '';
  const megapixels = (width * height) / 1e6;
  return `${width} × ${height}${megapixels >= 0.95 ? ` (${megapixels.toFixed(megapixels >= 10 ? 0 : 1)} MP)` : ''}`;
}

/*
 * Dates are compared and grouped as "wall-clock seconds": the local calendar
 * time expressed as if it were UTC. EXIF dates already are (a camera writes
 * the time it showed, with no time zone); real instants such as a file's
 * modification time are converted with the browser's time zone. Formatting
 * then always uses timeZone: 'UTC' so nothing shifts a second time.
 */
export function wallClock(instantSeconds) {
  const date = new Date(instantSeconds * 1000);
  return (
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()) /
    1000
  );
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
const longDayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});
const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

export function wallDateTime(wall) {
  return wall === null || wall === undefined ? '' : dateTimeFormat.format(new Date(wall * 1000));
}

export function wallDate(wall) {
  return wall === null || wall === undefined ? '' : dateFormat.format(new Date(wall * 1000));
}

export function wallDay(wall) {
  return longDayFormat.format(new Date(wall * 1000));
}

export function wallMonth(wall) {
  const text = monthFormat.format(new Date(wall * 1000));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function wallYear(wall) {
  return String(new Date(wall * 1000).getUTCFullYear());
}

/** "2024-05-01" (a date input's value) -> wall-clock seconds at 00:00 that day. */
export function parseDateInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const [y, m, d] = value.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 1000;
}

/** Wall-clock seconds -> "2024-05-01". */
export function toDateInput(wall) {
  const date = new Date(wall * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function todayWall() {
  return wallClock(Date.now() / 1000);
}
