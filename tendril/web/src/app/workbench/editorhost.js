/**
 * An editor host: owns one editor instance (CodeMirror or Monaco) for one
 * editor group (workbench/groups.js) and switches it between engines.
 *
 * Each group has its own host; both use the same engine. Switching asks the
 * current adapter for every document's text (so unsaved changes survive),
 * destroys it to free its memory, then loads the other one lazily: Monaco's
 * bundle is fetched from the server only the first time it is chosen.
 *
 * `hooks` connect the host to its group:
 *   isActive()                 whether its group is the active one (only the
 *                              active group reports the cursor)
 *   onFocus()                  its editor got the focus
 *   onLocalChanges(doc, changes)  CodeMirror edits typed here, to replay in
 *                              the other group's view of the same document
 *   liveText(doc)              the text of `doc` in another group, used when
 *                              this host shows a document it has not opened
 *
 * Adapter interface (see editors/codemirror/adapter.js for the reference):
 *   open(doc)                  show `doc`, creating its state on first use
 *   close(doc)                 forget `doc`'s state
 *   getText(doc)               current text, or null if never opened here
 *   setText(doc, text, {keepDirty})   replace the content (reload, cleanups)
 *   markSaved(doc)             the current content is now the saved baseline
 *   setLanguage(doc)           re-apply doc.language
 *   setDocOptions(doc)         re-apply doc.indent / doc.readonly
 *   setOptions(options)        global options (font, wrap, minimap...)
 *   setTheme()                 re-read the theme's CSS variables
 *   exec(command, ...args)     editor commands (undo, find, gotoLine, ...)
 *   supports(command)          whether exec(command) does anything here
 *   cursor()                   { line, col, selected, cursors }
 *   applyRemoteChanges(doc, changes)  edits made in the other group's view
 *                              (CodeMirror; Monaco editors share models)
 *   focus(), layout(), destroy()
 *
 * Adapters report through the context: onDirty, onCursor, onFocusChange,
 * onSaveRequest, onLocalChanges and onChange (any edit, for live previews).
 */
import { cssVar } from '../core/themes.js';

export const EDITORS = [
  { id: 'codemirror', name: 'CodeMirror' },
  { id: 'monaco', name: 'Monaco' },
];

export function createEditorHost(app, container, hooks = {}) {
  let kind = null;
  let adapter = null;
  let switching = null;
  let activeDoc = null;

  /** Global options derived from settings.json. */
  function options() {
    const e = app.settings.all.editor || {};
    return {
      fontSize: e.font_size || 14,
      fontFamily: e.font_family || cssVar('--font-mono'),
      tabSize: e.tab_size || 4,
      insertSpaces: e.insert_spaces !== false,
      wordWrap: !!e.word_wrap,
      minimap: !!e.minimap,
      lineNumbers: e.line_numbers !== false,
      renderWhitespace: !!e.render_whitespace,
      highlightActiveLine: e.highlight_active_line !== false,
      autoCloseBrackets: e.auto_close_brackets !== false,
      cursorBlink: e.cursor_blink !== false,
    };
  }

  const context = {
    container,
    options,
    onDirty: (doc, dirty) => app.documents.setDirty(doc, dirty),
    onCursor: (info) => {
      if (!hooks.isActive || hooks.isActive()) app.bus.emit('editor:cursor', info);
    },
    onFocusChange: (focused) => {
      if (focused) hooks.onFocus?.();
      app.bus.emit(focused ? 'editor:focus' : 'editor:blur', activeDoc);
    },
    onSaveRequest: () => app.commands.run('file.save'),
    onLocalChanges: (doc, changes) => hooks.onLocalChanges?.(doc, changes),
    onChange: (doc) => app.bus.emit('doc:edited', doc),
  };

  async function load(next) {
    container.classList.add('loading');
    try {
      if (next === 'monaco') {
        const { createMonacoAdapter } = await import('../editors/monaco/adapter.js');
        return await createMonacoAdapter(context);
      }
      const { createCodeMirrorAdapter } = await import('../editors/codemirror/adapter.js');
      return await createCodeMirrorAdapter(context);
    } finally {
      container.classList.remove('loading');
    }
  }

  async function switchTo(next) {
    if (switching) await switching;
    if (adapter && kind === next) return;
    switching = (async () => {
      if (adapter) {
        for (const doc of app.documents.all()) {
          if (doc.kind !== 'text') continue;
          const text = adapter.getText(doc);
          if (text !== null) doc.text = text;
        }
        adapter.destroy();
        adapter = null;
        container.replaceChildren();
      }
      let loaded;
      try {
        loaded = await load(next);
        kind = next;
      } catch (err) {
        console.error(err);
        app.ui.toast.error(`Could not load ${next === 'monaco' ? 'Monaco' : 'CodeMirror'}: ${err.message}`);
        if (next === 'codemirror') throw err;
        loaded = await load('codemirror');
        kind = 'codemirror';
      }
      adapter = loaded;
      if (activeDoc && app.documents.get(activeDoc.path) === activeDoc) adapter.open(activeDoc);
      app.bus.emit('editor:switched', kind);
    })();
    try {
      await switching;
    } finally {
      switching = null;
    }
  }

  const host = {
    get kind() {
      return kind;
    },
    get ready() {
      return !!adapter;
    },
    options,
    switchTo,

    async ensure() {
      if (switching) await switching;
      if (!adapter) await switchTo(app.settings.get('default_editor', 'codemirror'));
    },

    async show(doc) {
      activeDoc = doc;
      await host.ensure();
      if (activeDoc !== doc) return;
      // First time here: start from the other group's live text, which may
      // hold edits that doc.text does not have yet.
      if (adapter.getText(doc) === null) {
        const live = hooks.liveText?.(doc);
        if (typeof live === 'string') doc.text = live;
      }
      adapter.open(doc);
    },

    getText: (doc) => (adapter ? (adapter.getText(doc) ?? doc.text) : doc.text),

    /** The text of `doc` in this host's editor, or null if it is not open here. */
    liveText: (doc) => adapter?.getText(doc) ?? null,

    applyRemoteChanges: (doc, changes) => adapter?.applyRemoteChanges?.(doc, changes),

    replaceText(doc, text, { keepDirty = false } = {}) {
      doc.text = text;
      adapter?.setText(doc, text, { keepDirty });
    },

    markSaved: (doc) => adapter?.markSaved(doc),
    close(doc) {
      if (activeDoc === doc) activeDoc = null;
      adapter?.close(doc);
    },
    exec: (command, ...args) => adapter?.exec(command, ...args),
    focus: () => adapter?.focus(),
    layout: () => adapter?.layout(),
    cursor: () => adapter?.cursor() || null,
    setLanguage: (doc) => adapter?.setLanguage(doc),
    setDocOptions: (doc) => adapter?.setDocOptions(doc),
    applyOptions: () => adapter?.setOptions(options()),
    applyTheme: () => adapter?.setTheme(),
    supports: (command) => !!adapter?.supports?.(command),
  };

  const unsubscribe = [app.bus.on('settings:changed', () => host.applyOptions()), app.bus.on('theme:changed', () => host.applyTheme())];

  /** Frees the editor (its group was closed). */
  host.destroy = () => {
    unsubscribe.forEach((off) => off());
    adapter?.destroy();
    adapter = null;
    container.replaceChildren();
  };
  return host;
}
