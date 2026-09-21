/**
 * User colour handling.
 *
 * A colour is stored as a single HUE (0-359), never as a hex string. The client
 * turns the hue into a real colour with theme-dependent saturation/lightness
 * (see `public/css/theme.css`), which guarantees that every user colour stays
 * readable in both light and dark mode without maintaining two palettes.
 */

/**
 * Evenly spaced, visually distinguishable hues offered in Settings and used for
 * the random assignment that happens when a client first picks a username.
 */
export const HUE_PALETTE = Object.freeze([
  0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 320, 340,
]);

/**
 * Pick a hue for a new user.
 *
 * The point of the colour is telling people apart, so instead of a blind draw
 * this picks at random among the palette entries that are used the LEAST right
 * now. With fewer users than palette entries every colour is unique; beyond
 * that, reuse spreads out evenly instead of clustering.
 *
 * @param {Iterable<number>} [taken] Hues already in use.
 * @returns {number}
 */
export function randomHue(taken = []) {
  /** @type {Map<number, number>} palette hue -> how many users have it */
  const usage = new Map(HUE_PALETTE.map((hue) => [hue, 0]));
  for (const value of taken) {
    const hue = normalizeHue(value);
    if (hue === null || !usage.has(hue)) continue;
    usage.set(hue, usage.get(hue) + 1);
  }

  const fewest = Math.min(...usage.values());
  const candidates = HUE_PALETTE.filter((hue) => usage.get(hue) === fewest);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Normalise anything a client sends into a valid hue, or return null when the
 * value cannot be interpreted as one.
 * @param {unknown} value
 * @returns {number|null}
 */
export function normalizeHue(value) {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) return null;
  const rounded = Math.round(num);
  // Wrap instead of rejecting: hue is a circle, 360 and -20 are meaningful.
  return ((rounded % 360) + 360) % 360;
}

/**
 * Server-side hex rendering of a hue. Nothing in the UI needs it (the browser
 * builds colours from the hue directly), but it keeps the REST payload usable
 * for non-browser clients and for tests.
 * @param {number} hue
 * @param {number} [saturation] 0-100
 * @param {number} [lightness] 0-100
 */
export function hueToHex(hue, saturation = 65, lightness = 58) {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = Math.min(Math.max(saturation, 0), 100) / 100;
  const l = Math.min(Math.max(lightness, 0), 100) / 100;

  if (s === 0) {
    const grey = Math.round(l * 255);
    return `#${grey.toString(16).padStart(2, '0').repeat(3)}`;
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };

  const rgb = [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map((v) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0'),
  );
  return `#${rgb.join('')}`;
}
