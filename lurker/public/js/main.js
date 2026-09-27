/** Entry point: start the application once the page has loaded. */
import { App } from './app.js';
import { h } from './core/dom.js';

const root = document.getElementById('app');
const app = new App(root);
window.lurker = app; // handy from the browser console, and used by the end-to-end tests

app.start().catch((error) => {
  console.error(error);
  root.replaceChildren(
    h(
      'div',
      { class: 'empty' },
      h('h2', { text: 'Lurker could not start' }),
      h('p', { text: error.message || String(error) }),
      h('button', { type: 'button', class: 'btn primary', onClick: () => location.reload() }, 'Try again'),
    ),
  );
});
