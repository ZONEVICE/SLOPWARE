/**
 * Tools menu: the editor engine (CodeMirror or Monaco, also a toolbar
 * drop-down), the active file's language, indentation, line endings and
 * BOM, and the image preview of SVG files.
 */
import { h, isNarrow, isTouch } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { LANGUAGES, languageById } from '../core/languages.js';
import { basename, extname } from '../core/paths.js';
import { EDITORS } from '../workbench/editorhost.js';
import { dropdown } from '../ui/menu.js';
import { quickPick } from '../ui/quickpick.js';
import { renderImage } from '../viewers/media.js';

const activeText = (app) => app.tabs.activeDoc?.kind === 'text';

export function register(app) {
  const c = (def) => app.commands.register({ category: 'Tools', ...def });

  async function useEditor(id) {
    if (app.editors.kind === id) return;
    if (id === 'monaco' && (isNarrow() || isTouch())) {
      app.ui.toast.warn('Monaco works poorly on touch screens and small displays. CodeMirror is recommended here.', { timeout: 7000 });
    }
    await app.editors.switchTo(id);
    // Remember the choice for every browser (settings.json).
    if (app.settings.get('default_editor') !== id) app.settings.set('default_editor', id).catch(() => {});
  }

  for (const editor of EDITORS) {
    c({
      id: `editor.use.${editor.id}`,
      title: `Use ${editor.name}`,
      menuTitle: editor.name,
      checked: () => app.editors.kind === editor.id,
      run: () => useEditor(editor.id),
    });
  }

  c({
    id: 'editor.language',
    title: 'Change Language Mode…',
    when: activeText,
    run: () => {
      const doc = app.tabs.activeDoc;
      quickPick({
        placeholder: `Language for ${doc.name}`,
        items: (q) => LANGUAGES.filter((l) => l.name.toLowerCase().includes(q.toLowerCase())).map((l) => ({
          label: l.name,
          description: l.id === doc.language.id ? 'current' : l.ext.slice(0, 4).map((e) => `.${e}`).join(' '),
          id: l.id,
        })),
        onAccept: (item) => {
          doc.language = languageById(item.id);
          app.editors.setLanguage(doc);
          app.bus.emit('doc:language', doc);
        },
      });
    },
  });

  c({
    id: 'editor.indentation',
    title: 'Change Indentation…',
    when: activeText,
    run: () => {
      const doc = app.tabs.activeDoc;
      const options = [
        ...[2, 4, 8].map((size) => ({ label: `Spaces: ${size}`, indent: { tabs: false, size } })),
        ...[2, 4, 8].map((size) => ({ label: `Tabs (width ${size})`, indent: { tabs: true, size } })),
        { label: 'Detect from content', detect: true },
      ].map((o) => ({ ...o, description: !o.detect && o.indent.tabs === doc.indent.tabs && o.indent.size === doc.indent.size ? 'current' : '' }));
      quickPick({
        placeholder: 'Indentation for this file',
        items: options,
        onAccept: (item) => {
          if (item.detect) app.documents.applyIndentation(Object.assign(doc, { text: app.editors.getText(doc) }));
          else doc.indent = item.indent;
          app.editors.setDocOptions(doc);
          app.bus.emit('doc:indent', doc);
        },
      });
    },
  });

  c({
    id: 'editor.eol',
    title: 'Change Line Endings (LF / CRLF)',
    when: activeText,
    run: () => {
      const doc = app.tabs.activeDoc;
      quickPick({
        placeholder: 'Line endings used when saving',
        items: [
          { label: 'LF', description: doc.eol === 'lf' ? 'current' : 'Unix, macOS', eol: 'lf' },
          { label: 'CRLF', description: doc.eol === 'crlf' ? 'current' : 'Windows', eol: 'crlf' },
        ],
        onAccept: (item) => {
          if (item.eol === doc.eol) return;
          doc.eol = item.eol;
          app.documents.setDirty(doc, true);
          app.bus.emit('doc:eol', doc);
        },
      });
    },
  });

  c({
    id: 'editor.bom',
    title: 'Toggle UTF-8 BOM',
    when: activeText,
    checked: () => !!app.tabs.activeDoc?.bom,
    run: () => {
      const doc = app.tabs.activeDoc;
      doc.bom = !doc.bom;
      app.documents.setDirty(doc, true);
      app.bus.emit('doc:eol', doc);
    },
  });

  c({
    id: 'tools.previewImage',
    title: 'Preview Image',
    icon: 'image',
    when: () => extname(app.tabs.activeDoc?.path || '') === 'svg',
    run: () => {
      const path = app.tabs.activeDoc.path;
      app.tabs.openPage({ id: `preview:${path}`, title: `${basename(path)} (preview)`, icon: 'image', render: (el) => renderImage(app, path, el) });
    },
  });

  app.menus.add('tools', {
    label: 'Editor',
    icon: 'editor',
    group: '1_editor',
    order: 1,
    submenu: () => EDITORS.map((e) => app.menus.commandItem(`editor.use.${e.id}`)),
  });
  const add = (command, group, order) => app.menus.add('tools', { command, group, order });
  add('editor.language', '2_file', 1);
  add('editor.indentation', '2_file', 2);
  add('editor.eol', '2_file', 3);
  add('editor.bom', '2_file', 4);
  add('tools.previewImage', '3_preview', 1);

  // The editor drop-down in the toolbar.
  const label = h('span.editor-pick-label');
  const button = h('button.btn.small.editor-pick', { type: 'button', 'data-tip': 'Editor engine', 'aria-haspopup': 'menu' }, icon('editor'), label, icon('chevron-down'));
  const updateLabel = () => {
    label.textContent = EDITORS.find((e) => e.id === (app.editors.kind || app.settings.get('default_editor')))?.name || 'Editor';
  };
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    dropdown(button, () => EDITORS.map((e) => app.menus.commandItem(`editor.use.${e.id}`)), { alignRight: true });
  });
  app.bus.on('editor:switched', updateLabel);
  updateLabel();
  app.toolbar.addElement(button, { group: '7', order: 1 });
}
