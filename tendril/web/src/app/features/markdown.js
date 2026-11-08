/**
 * Markdown preview: the active Markdown file rendered beside its editor (in
 * the other editor group; in the same group on phones), following the edits
 * as they are typed. Rendering lives in preview/markdown.js, loaded the first
 * time a preview opens.
 *
 * Links in the preview: "#anchor" scrolls it, a relative path opens that
 * workspace file, web and mail links open in a new browser tab.
 */
import { dirname, resolve } from '../core/paths.js';

const isMarkdown = (doc) => doc?.kind === 'text' && doc.language?.id === 'markdown';

/** A page (see workbench/tabs.js) that previews `doc`. */
function previewPage(app, doc) {
  let pane = null;
  let timer = null;
  let generation = 0;
  let unsubscribe = [];

  async function update() {
    const mine = ++generation;
    try {
      const { renderMarkdown } = await import('../preview/markdown.js');
      const article = await renderMarkdown(app.editors.getText(doc) ?? '', doc.path);
      if (mine !== generation || !pane) return; // a newer render is on its way
      const top = pane.scrollTop;
      pane.replaceChildren(article);
      pane.scrollTop = top;
    } catch (err) {
      console.error('[markdown] preview failed', err);
      app.ui.toast.error(`Could not render the preview: ${err.message}`);
    }
  }

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 200);
  };

  function onClick(event) {
    const link = event.target.closest('a[href]');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href');
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      pane.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
    } else if (/^(https?|mailto):/i.test(href)) {
      window.open(href, '_blank', 'noopener');
    } else {
      const path = resolve(dirname(doc.path), decodeURIComponent(href.split('#')[0]));
      if (path) app.tabs.open(path);
    }
  }

  return {
    id: `preview:${doc.path}`,
    title: `Preview ${doc.name}`,
    tip: `Preview of ${doc.path}`,
    icon: 'preview',
    render(el) {
      pane = el;
      el.classList.add('markdown-preview');
      el.addEventListener('click', onClick);
      unsubscribe = [
        app.bus.on('doc:edited', (edited) => edited === doc && schedule()),
        app.bus.on('doc:reloaded', (reloaded) => reloaded === doc && schedule()),
      ];
      update();
    },
    onClose() {
      unsubscribe.forEach((off) => off());
      unsubscribe = [];
      clearTimeout(timer);
      pane = null;
    },
  };
}

export function register(app) {
  const active = () => app.tabs.activeDoc;
  app.commands.register({
    id: 'markdown.previewSide',
    title: 'Open Preview to the Side',
    category: 'Markdown',
    icon: 'preview',
    keys: 'Mod+Shift+V',
    when: () => isMarkdown(active()),
    run: () => app.groups.openPageBeside(previewPage(app, active())),
  });
  app.commands.register({
    id: 'markdown.preview',
    title: 'Open Preview',
    category: 'Markdown',
    icon: 'preview',
    when: () => isMarkdown(active()),
    run: () => app.tabs.openPage(previewPage(app, active())),
  });
  app.menus.add('view', { command: 'markdown.previewSide', group: '6_preview', order: 1 });
  app.menus.add('view', { command: 'markdown.preview', group: '6_preview', order: 2 });
  app.groups.addAction({ command: 'markdown.previewSide', icon: 'preview', title: 'Open Preview to the Side', when: (tab) => isMarkdown(tab?.doc) });
  app.bus.on('doc:language', () => app.groups.refreshActions());
}
