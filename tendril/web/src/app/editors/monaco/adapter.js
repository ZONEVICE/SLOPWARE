/**
 * Monaco Editor adapter. Implements the adapter interface documented in
 * workbench/editorhost.js.
 *
 * Monaco is big, so it is a separate bundle loaded by URL the first time it
 * is chosen (never from a CDN: the bundle and its web workers are embedded in
 * the Tendril binary). Each open document gets a Monaco model; view state
 * (scroll, cursor, folds) is saved per document when switching tabs. With
 * the editor split, the groups' editors share each document's model, so a
 * file open in both is edited once and shown twice.
 *
 * Monaco needs concrete colors, so its theme is rebuilt from the CSS
 * variables of the current Tendril theme on every theme change.
 */
import { basename, extname } from '../../core/paths.js';
import { cssVar, currentTheme, hexVar } from '../../core/themes.js';

/**
 * Models shared by every adapter (one per editor group):
 * doc.id -> { model, users, savedVersion, listener }.
 */
const sharedModels = new Map();

const BASE = '/assets/app/monaco/';
const BUNDLE = `${BASE}monaco.js`;
let loading = null;

/** Which worker file serves a Monaco worker label. */
function workerFile(label) {
  if (label === 'json') return 'json';
  if (['css', 'scss', 'less'].includes(label)) return 'css';
  if (['html', 'handlebars', 'razor'].includes(label)) return 'html';
  if (['typescript', 'javascript'].includes(label)) return 'ts';
  return 'editor';
}

function loadMonaco() {
  if (!loading) {
    loading = (async () => {
      self.MonacoEnvironment = {
        getWorker: (_moduleId, label) => new Worker(`${BASE}workers/${workerFile(label)}.js`, { name: label }),
      };
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${BASE}monaco.css`;
      const css = new Promise((resolve) => {
        link.onload = resolve;
        link.onerror = resolve;
      });
      document.head.append(link);
      const [mod] = await Promise.all([import(BUNDLE), css]);
      return mod.default || mod;
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

function defineTheme(monaco) {
  const v = (name) => hexVar(name).slice(1);
  const c = (name) => hexVar(name);
  const italic = cssVar('--syn-comment-style') === 'italic' ? 'italic' : '';
  monaco.editor.defineTheme('tendril', {
    base: currentTheme().kind === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: v('--editor-fg') },
      { token: 'comment', foreground: v('--syn-comment'), fontStyle: italic },
      { token: 'keyword', foreground: v('--syn-keyword') },
      { token: 'string', foreground: v('--syn-string') },
      { token: 'string.escape', foreground: v('--syn-regexp') },
      { token: 'number', foreground: v('--syn-number') },
      { token: 'regexp', foreground: v('--syn-regexp') },
      { token: 'type', foreground: v('--syn-type') },
      { token: 'type.identifier', foreground: v('--syn-type') },
      { token: 'identifier', foreground: v('--syn-variable') },
      { token: 'variable', foreground: v('--syn-variable') },
      { token: 'variable.predefined', foreground: v('--syn-constant') },
      { token: 'constant', foreground: v('--syn-constant') },
      { token: 'predefined', foreground: v('--syn-function') },
      { token: 'delimiter', foreground: v('--syn-punct') },
      { token: 'operator', foreground: v('--syn-operator') },
      { token: 'tag', foreground: v('--syn-tag') },
      { token: 'metatag', foreground: v('--syn-meta') },
      { token: 'attribute.name', foreground: v('--syn-attr') },
      { token: 'attribute.value', foreground: v('--syn-string') },
      { token: 'annotation', foreground: v('--syn-meta') },
      { token: 'invalid', foreground: v('--syn-invalid') },
      { token: 'emphasis', fontStyle: 'italic' },
      { token: 'strong', fontStyle: 'bold' },
      { token: 'keyword.md', foreground: v('--syn-heading'), fontStyle: 'bold' },
      // Semantic tokens (TypeScript/JavaScript).
      { token: 'function', foreground: v('--syn-function') },
      { token: 'method', foreground: v('--syn-function') },
      { token: 'class', foreground: v('--syn-type') },
      { token: 'interface', foreground: v('--syn-type') },
      { token: 'enum', foreground: v('--syn-type') },
      { token: 'namespace', foreground: v('--syn-type') },
      { token: 'typeParameter', foreground: v('--syn-type') },
      { token: 'property', foreground: v('--syn-property') },
      { token: 'enumMember', foreground: v('--syn-constant') },
      { token: 'parameter', foreground: v('--syn-variable') },
    ],
    colors: {
      'editor.background': c('--editor-bg'),
      'editor.foreground': c('--editor-fg'),
      'editorGutter.background': c('--editor-gutter'),
      'editorLineNumber.foreground': c('--editor-gutter-fg'),
      'editorLineNumber.activeForeground': c('--editor-gutter-active'),
      'editor.lineHighlightBackground': c('--editor-line'),
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': c('--editor-selection'),
      'editor.inactiveSelectionBackground': c('--editor-selection'),
      'editor.selectionHighlightBackground': c('--editor-match'),
      'editor.wordHighlightBackground': c('--editor-match'),
      'editor.wordHighlightStrongBackground': c('--editor-match'),
      'editor.findMatchBackground': c('--editor-selection'),
      'editor.findMatchHighlightBackground': c('--editor-match'),
      'editorCursor.foreground': c('--editor-cursor'),
      'editorWhitespace.foreground': c('--editor-guide'),
      'editorIndentGuide.background1': c('--editor-guide'),
      'editorIndentGuide.activeBackground1': c('--fg-subtle'),
      'editorBracketMatch.background': c('--editor-bracket'),
      'editorBracketMatch.border': '#00000000',
      'editorWidget.background': c('--surface'),
      'editorWidget.foreground': c('--surface-fg'),
      'editorWidget.border': c('--border'),
      'editorSuggestWidget.background': c('--surface'),
      'editorSuggestWidget.foreground': c('--surface-fg'),
      'editorSuggestWidget.border': c('--border'),
      'editorSuggestWidget.selectedBackground': c('--accent-soft'),
      'editorSuggestWidget.highlightForeground': c('--accent'),
      'editorHoverWidget.background': c('--surface'),
      'editorHoverWidget.foreground': c('--surface-fg'),
      'editorHoverWidget.border': c('--border'),
      'input.background': c('--bg-alt'),
      'input.foreground': c('--fg'),
      'input.border': c('--border'),
      focusBorder: c('--focus'),
      'list.hoverBackground': c('--hover'),
      'list.activeSelectionBackground': c('--accent-soft'),
      'list.activeSelectionForeground': c('--surface-fg'),
      'list.highlightForeground': c('--accent'),
      'scrollbarSlider.background': c('--scrollbar'),
      'scrollbarSlider.hoverBackground': c('--scrollbar-hover'),
      'scrollbarSlider.activeBackground': c('--scrollbar-hover'),
      'minimap.background': c('--editor-bg'),
      'editorOverviewRuler.border': '#00000000',
      'editorStickyScroll.background': c('--editor-bg'),
      'menu.background': c('--surface'),
      'menu.foreground': c('--surface-fg'),
      'menu.selectionBackground': c('--accent-soft'),
      'menu.selectionForeground': c('--surface-fg'),
      'widget.shadow': '#00000040',
    },
  });
}

export async function createMonacoAdapter(ctx) {
  const monaco = await loadMonaco();
  defineTheme(monaco);
  const { container } = ctx;
  const toMonacoOptions = (o) => ({
    fontSize: o.fontSize,
    fontFamily: o.fontFamily,
    wordWrap: o.wordWrap ? 'on' : 'off',
    minimap: { enabled: o.minimap },
    lineNumbers: o.lineNumbers ? 'on' : 'off',
    renderWhitespace: o.renderWhitespace ? 'all' : 'selection',
    renderLineHighlight: o.highlightActiveLine ? 'all' : 'none',
    autoClosingBrackets: o.autoCloseBrackets ? 'languageDefined' : 'never',
    autoClosingQuotes: o.autoCloseBrackets ? 'languageDefined' : 'never',
    cursorBlinking: o.cursorBlink ? 'blink' : 'solid',
  });

  const editor = monaco.editor.create(container, {
    model: null,
    theme: 'tendril',
    automaticLayout: true,
    fixedOverflowWidgets: true,
    scrollBeyondLastLine: true,
    smoothScrolling: false,
    mouseWheelZoom: false,
    contextmenu: true,
    padding: { top: 4 },
    bracketPairColorization: { enabled: true },
    'semanticHighlighting.enabled': true,
    ...toMonacoOptions(ctx.options()),
  });

  const entries = new Map(); // doc.id -> { model, shared, viewState, doc }
  let current = null;

  function languageId(doc) {
    const ext = `.${extname(doc.path)}`;
    const name = basename(doc.path).toLowerCase();
    const known = monaco.languages.getLanguages().find(
      (l) => (l.filenames || []).some((f) => f.toLowerCase() === name) || (ext !== '.' && (l.extensions || []).includes(ext)),
    );
    return known?.id || doc.language.monaco || 'plaintext';
  }

  function entryFor(doc) {
    let entry = entries.get(doc.id);
    if (entry) return entry;
    let shared = sharedModels.get(doc.id);
    if (!shared) {
      const uri = monaco.Uri.from({ scheme: 'file', path: `/${doc.id}/${doc.path}` });
      monaco.editor.getModel(uri)?.dispose();
      const model = monaco.editor.createModel(doc.text, languageId(doc), uri);
      model.setEOL(monaco.editor.EndOfLineSequence.LF);
      model.updateOptions({ tabSize: doc.indent.size, insertSpaces: !doc.indent.tabs });
      const record = { model, users: 0, savedVersion: doc.dirty ? -1 : model.getAlternativeVersionId() };
      record.listener = model.onDidChangeContent(() => {
        const dirty = model.getAlternativeVersionId() !== record.savedVersion;
        if (dirty !== doc.dirty) ctx.onDirty(doc, dirty);
        ctx.onChange?.(doc);
      });
      shared = record;
      sharedModels.set(doc.id, shared);
    }
    shared.users += 1;
    entry = { model: shared.model, shared, viewState: null, doc };
    entries.set(doc.id, entry);
    return entry;
  }

  /** Drops this editor's use of a model; the last user disposes it. */
  function release(docId) {
    const entry = entries.get(docId);
    if (!entry) return;
    entries.delete(docId);
    const shared = entry.shared;
    shared.users -= 1;
    if (shared.users <= 0) {
      shared.listener.dispose();
      shared.model.dispose();
      sharedModels.delete(docId);
    }
  }

  function reportCursor() {
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position) return;
    const selections = editor.getSelections() || [];
    let selected = 0;
    for (const s of selections) selected += model.getValueLengthInRange(s);
    ctx.onCursor({ line: position.lineNumber, col: position.column, selected, cursors: selections.length, lines: model.getLineCount() });
  }

  editor.onDidChangeCursorSelection(reportCursor);
  editor.onDidFocusEditorText(() => ctx.onFocusChange(true));
  editor.onDidBlurEditorText(() => ctx.onFocusChange(false));
  // Ctrl+S inside Monaco: the global shortcut handler already catches it in
  // the capture phase; this is a fallback for embedded widgets.
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => ctx.onSaveRequest());

  const ACTIONS = {
    undo: 'undo',
    redo: 'redo',
    find: 'actions.find',
    replace: 'editor.action.startFindReplaceAction',
    findNext: 'editor.action.nextMatchFindAction',
    findPrevious: 'editor.action.previousMatchFindAction',
    selectAll: 'editor.action.selectAll',
    toggleComment: 'editor.action.commentLine',
    toggleBlockComment: 'editor.action.blockComment',
    moveLineUp: 'editor.action.moveLinesUpAction',
    moveLineDown: 'editor.action.moveLinesDownAction',
    copyLineUp: 'editor.action.copyLinesUpAction',
    copyLineDown: 'editor.action.copyLinesDownAction',
    addCursorAbove: 'editor.action.insertCursorAbove',
    addCursorBelow: 'editor.action.insertCursorBelow',
    selectNextOccurrence: 'editor.action.addSelectionToNextFindMatch',
    selectAllOccurrences: 'editor.action.selectHighlights',
    expandSelection: 'editor.action.smartSelect.expand',
    indent: 'editor.action.indentLines',
    outdent: 'editor.action.outdentLines',
    deleteLine: 'editor.action.deleteLines',
    foldAll: 'editor.foldAll',
    unfoldAll: 'editor.unfoldAll',
    upperCase: 'editor.action.transformToUppercase',
    lowerCase: 'editor.action.transformToLowercase',
    sortLines: 'editor.action.sortLinesAscending',
    trimTrailing: 'editor.action.trimTrailingWhitespace',
    format: 'editor.action.formatDocument',
    gotoSymbol: 'editor.action.quickOutline',
    cut: 'editor.action.clipboardCutAction',
    copy: 'editor.action.clipboardCopyAction',
    paste: 'editor.action.clipboardPasteAction',
    cursorLeft: 'cursorLeft',
    cursorRight: 'cursorRight',
    cursorUp: 'cursorUp',
    cursorDown: 'cursorDown',
  };

  return {
    id: 'monaco',

    open(doc) {
      if (current === doc) return;
      if (current && entries.has(current.id)) entries.get(current.id).viewState = editor.saveViewState();
      const entry = entryFor(doc);
      current = doc;
      editor.setModel(entry.model);
      editor.updateOptions({ readOnly: !!doc.readonly });
      if (entry.viewState) editor.restoreViewState(entry.viewState);
      reportCursor();
    },

    close(doc) {
      const entry = entries.get(doc.id);
      if (!entry) return;
      if (current === doc) {
        current = null;
        editor.setModel(null);
      }
      release(doc.id);
    },

    getText(doc) {
      const entry = entries.get(doc.id);
      return entry ? entry.model.getValue(monaco.editor.EndOfLinePreference.LF) : null;
    },

    setText(doc, text, { keepDirty = false } = {}) {
      const entry = entries.get(doc.id);
      if (!entry) return;
      const model = entry.model;
      const before = model.getValue(monaco.editor.EndOfLinePreference.LF);
      if (before !== text) {
        let start = 0;
        const max = Math.min(before.length, text.length);
        while (start < max && before.charCodeAt(start) === text.charCodeAt(start)) start += 1;
        let endA = before.length;
        let endB = text.length;
        while (endA > start && endB > start && before.charCodeAt(endA - 1) === text.charCodeAt(endB - 1)) {
          endA -= 1;
          endB -= 1;
        }
        const from = model.getPositionAt(start);
        const to = model.getPositionAt(endA);
        model.pushEditOperations([], [{ range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: text.slice(start, endB) }], () => null);
      }
      if (!keepDirty) {
        entry.shared.savedVersion = model.getAlternativeVersionId();
        ctx.onDirty(doc, false);
      }
    },

    markSaved(doc) {
      const entry = entries.get(doc.id);
      if (entry) entry.shared.savedVersion = entry.model.getAlternativeVersionId();
    },

    setLanguage(doc) {
      const entry = entries.get(doc.id);
      if (entry) monaco.editor.setModelLanguage(entry.model, languageId(doc));
    },

    setDocOptions(doc) {
      const entry = entries.get(doc.id);
      if (entry) entry.model.updateOptions({ tabSize: doc.indent.size, insertSpaces: !doc.indent.tabs });
      if (current === doc) editor.updateOptions({ readOnly: !!doc.readonly });
    },

    setOptions(options) {
      editor.updateOptions(toMonacoOptions(options));
    },

    setTheme() {
      defineTheme(monaco);
      monaco.editor.setTheme('tendril');
    },

    supports: (command) => command in ACTIONS || ['goto', 'insertText'].includes(command),

    exec(command, ...args) {
      editor.focus();
      if (command === 'goto') {
        const [line, col = 1] = args;
        editor.setPosition({ lineNumber: line, column: col });
        editor.revealPositionInCenter({ lineNumber: line, column: col });
        return true;
      }
      if (command === 'insertText') {
        editor.trigger('keyboard', 'type', { text: args[0] });
        return true;
      }
      const action = ACTIONS[command];
      if (!action) return false;
      const contributed = editor.getAction(action);
      // Formatting needs a formatter for the model's language; report the
      // lack of one instead of running an action that does nothing.
      if (command === 'format' && !contributed?.isSupported()) return false;
      if (contributed) return contributed.run();
      editor.trigger('tendril', action, null);
      return true;
    },

    cursor() {
      const position = editor.getPosition();
      const model = editor.getModel();
      return position && model ? { line: position.lineNumber, col: position.column, lines: model.getLineCount() } : null;
    },

    focus: () => editor.focus(),
    layout: () => editor.layout(),

    destroy() {
      editor.setModel(null);
      for (const id of [...entries.keys()]) release(id);
      editor.dispose();
    },
  };
}
