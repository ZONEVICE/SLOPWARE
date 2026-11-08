/**
 * Runs before the first paint on both pages: applies the theme saved in this
 * browser or, the first time, the system's light/dark preference. A classic
 * script (not a module) so it blocks rendering for the microseconds it takes,
 * which avoids a flash of the wrong theme.
 *
 * Keep THEMES in sync with app/core/themes.js.
 */
(function () {
  var THEMES = ['dark', 'light', 'kirby', 'gorbino', 'oled', 'dos', 'nuclear', 'ambar', 'eyeburned'];
  var theme = null;
  try {
    theme = JSON.parse(localStorage.getItem('tendril.theme'));
  } catch (e) {
    theme = null;
  }
  if (THEMES.indexOf(theme) < 0) {
    var light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    theme = light ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
