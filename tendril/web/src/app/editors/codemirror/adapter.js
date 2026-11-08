/**
 * CodeMirror 6 adapter (the default editor). Implements the adapter
 * interface documented in workbench/editorhost.js.
 *
 * One EditorView is mounted; every open document keeps its own EditorState
 * (text, undo history, selection, folds) in a Map, swapped into the view on
 * activation. Options that can change at run time live in Compartments and
 * are reconfigured in every stored state, not just the visible one.
 *
 * Colors come from CSS variables (styles/themes.css) directly in the theme
 * and the highlight style, so switching the Tendril theme needs no
 * reconfiguration at all; only the dark/light flag is updated.
 *
 * "Unsaved" is decided by comparing the document with the content saved
 * last (CodeMirror's Text is a persistent tree, so keeping that snapshot is
 * cheap): undoing back to the saved text makes the tab clean again.
 *
 * With the editor split, each group has its own adapter. A document open in
 * both keeps one state per view: edits typed in one are replayed in the
 * other (`onLocalChanges` -> `applyRemoteChanges`, outside its undo history,
 * like CodeMirror's split-view example), and the saved snapshot is shared.
 */
import {
  autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord, completionKeymap,
} from '@codemirror/autocomplete';
import {
  addCursorAbove, addCursorBelow, copyLineDown, copyLineUp, cursorCharLeft, cursorCharRight, cursorLineDown, cursorLineUp,
  defaultKeymap, deleteLine, history, historyKeymap, indentLess, indentMore, indentWithTab, moveLineDown, moveLineUp, redo,
  selectAll, selectParentSyntax, toggleBlockComment, toggleComment, undo,
} from '@codemirror/commands';
import {
  bracketMatching, foldAll, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting, unfoldAll,
} from '@codemirror/language';
import {
  findNext, findPrevious, highlightSelectionMatches, openSearchPanel, search, searchKeymap, selectNextOccurrence,
  selectSelectionMatches,
} from '@codemirror/search';
import { Annotation, Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, highlightWhitespace, keymap, lineNumbers, rectangularSelection, scrollPastEnd,
} from '@codemirror/view';

import { currentTheme } from '../../core/themes.js';
import { loadLanguage } from './languages.js';
import { highlightStyle, theme } from './theme.js';

/** Marks transactions that must not be replayed in the other group's view. */
const noReplay = Annotation.define();

/**
 * Saved snapshots shared by every adapter (one per editor group):
 * doc.id -> { saved: Text | null, users }. `null` means "unknown, dirty".
 */
const savedTexts = new Map();

/** The smallest single replacement turning `before` into `after`. */
function minimalChange(before, after) {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore -= 1;
    endAfter -= 1;
  }
  return { from: start, to: endBefore, insert: after.slice(start, endAfter) };
}

export async function createCodeMirrorAdapter(ctx) {
  const { container } = ctx;
  let options = ctx.options();
  let minimapExtension = [];

  const c = {
    language: new Compartment(),
    indent: new Compartment(),
    readOnly: new Compartment(),
    wrap: new Compartment(),
    gutters: new Compartment(),
    activeLine: new Compartment(),
    whitespace: new Compartment(),
    brackets: new Compartment(),
    cursor: new Compartment(),
    minimap: new Compartment(),
    dark: new Compartment(),
  };

  const states = new Map(); // doc.id -> EditorState (inactive documents)
  const scroll = new Map(); // doc.id -> scroll snapshot effect
  const docs = new Map(); // doc.id -> doc (opened in this adapter)
  let current = null;
  let dirtyTimer = null;

  const globalExtensions = () => ({
    wrap: options.wordWrap ? EditorView.lineWrapping : [],
    gutters: options.lineNumbers ? [lineNumbers(), foldGutter()] : [foldGutter()],
    activeLine: options.highlightActiveLine ? [highlightActiveLine(), highlightActiveLineGutter()] : [],
    whitespace: options.renderWhitespace ? highlightWhitespace() : [],
    brackets: options.autoCloseBrackets ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : [],
    cursor: drawSelection({ cursorBlinkRate: options.cursorBlink ? 1200 : 0 }),
    minimap: minimapExtension,
    dark: EditorView.darkTheme.of(currentTheme().kind === 'dark'),
  });

  const docExtensions = (doc) => ({
    indent: [EditorState.tabSize.of(doc.indent.size), indentUnit.of(doc.indent.tabs ? '\t' : ' '.repeat(doc.indent.size))],
    readOnly: [EditorState.readOnly.of(!!doc.readonly), EditorView.editable.of(true)],
  });

  const base = [
    highlightSpecialChars(),
    history(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(highlightStyle),
    bracketMatching(),
    autocompletion({ activateOnTyping: true }),
    EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    search({ top: true }),
    scrollPastEnd(),
    keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
    theme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged && current && !update.transactions.some((tr) => tr.annotation(noReplay))) {
        scheduleDirty();
        ctx.onLocalChanges?.(current, update.changes);
        ctx.onChange?.(current);
      }
      if (update.selectionSet || update.docChanged) reportCursor();
    }),
    EditorView.domEventHandlers({
      focus: () => ctx.onFocusChange(true),
      blur: () => ctx.onFocusChange(false),
    }),
  ];

  function createState(doc) {
    const g = globalExtensions();
    const d = docExtensions(doc);
    const state = EditorState.create({
      doc: doc.text,
      extensions: [
        base,
        c.language.of([]),
        c.indent.of(d.indent),
        c.readOnly.of(d.readOnly),
        ...['wrap', 'gutters', 'activeLine', 'whitespace', 'brackets', 'cursor', 'minimap', 'dark'].map((k) => c[k].of(g[k])),
      ],
    });
    let shared = savedTexts.get(doc.id);
    if (!shared) {
      shared = { saved: doc.dirty ? null : state.doc, users: 0 };
      savedTexts.set(doc.id, shared);
    }
    shared.users += 1;
    docs.set(doc.id, doc);
    loadLanguage(doc.language.id).then((ext) => {
      if (ext && docs.get(doc.id) === doc) reconfigure(doc, [c.language.reconfigure(ext)]);
    });
    return state;
  }

  minimapExtension = await ensureMinimap();
  const view = new EditorView({ parent: container, state: EditorState.create({ doc: '' }) });
  view.dom.classList.add('tendril-cm');
  applyCssOptions();

  /** Applies effects to a document's state, visible or stored. */
  function reconfigure(doc, effects) {
    if (current === doc) view.dispatch({ effects });
    else if (states.has(doc.id)) states.set(doc.id, states.get(doc.id).update({ effects }).state);
  }

  function stateOf(doc) {
    return current === doc ? view.state : states.get(doc.id);
  }

  function computeDirty(doc) {
    const state = stateOf(doc);
    if (!state) return doc.dirty;
    const baseline = savedTexts.get(doc.id)?.saved;
    if (!baseline) return true;
    return state.doc.length !== baseline.length || !state.doc.eq(baseline);
  }

  function scheduleDirty() {
    if (!current) return;
    clearTimeout(dirtyTimer);
    const doc = current;
    // Typing makes a clean document dirty at once; the full comparison
    // (to detect "undone back to saved") is debounced.
    if (!doc.dirty) ctx.onDirty(doc, true);
    dirtyTimer = setTimeout(() => ctx.onDirty(doc, computeDirty(doc)), 250);
  }

  function reportCursor() {
    const state = view.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    let selected = 0;
    for (const range of state.selection.ranges) selected += range.to - range.from;
    ctx.onCursor({ line: line.number, col: head - line.from + 1, selected, cursors: state.selection.ranges.length, lines: state.doc.lines });
  }

  /** Forgets this adapter's use of a document's shared snapshot. */
  function release(docId) {
    const shared = savedTexts.get(docId);
    if (shared && (shared.users -= 1) <= 0) savedTexts.delete(docId);
  }

  function setSaved(doc, text) {
    const shared = savedTexts.get(doc.id);
    if (shared) shared.saved = text;
  }

  function applyCssOptions() {
    container.style.setProperty('--editor-font-size', `${options.fontSize}px`);
    container.style.setProperty('--editor-font-family', options.fontFamily);
  }

  async function ensureMinimap() {
    if (!options.minimap) return [];
    const { showMinimap } = await import('@replit/codemirror-minimap');
    return showMinimap.compute(['doc'], () => ({
      create: () => ({ dom: document.createElement('div') }),
      displayText: 'blocks',
      showOverlay: 'always',
    }));
  }

  function transform(fn) {
    const state = view.state;
    const changes = state.selection.ranges
      .filter((r) => !r.empty)
      .map((r) => ({ from: r.from, to: r.to, insert: fn(state.sliceDoc(r.from, r.to)) }));
    if (changes.length) view.dispatch({ changes, scrollIntoView: true });
  }

  function sortLines() {
    const state = view.state;
    const sel = state.selection.main;
    const from = sel.empty ? 0 : state.doc.lineAt(sel.from).from;
    const to = sel.empty ? state.doc.length : state.doc.lineAt(sel.to).to;
    const sorted = state.sliceDoc(from, to).split('\n').sort((a, b) => a.localeCompare(b)).join('\n');
    view.dispatch({ changes: { from, to, insert: sorted } });
  }

  function trimTrailing() {
    const state = view.state;
    const changes = [];
    for (let i = 1; i <= state.doc.lines; i += 1) {
      const line = state.doc.line(i);
      const match = /[ \t]+$/.exec(line.text);
      if (match) changes.push({ from: line.from + match.index, to: line.to });
    }
    if (changes.length) view.dispatch({ changes });
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      view.dispatch(view.state.replaceSelection(text));
    } catch {
      ctx.onPasteBlocked?.();
      throw new Error('The browser blocked clipboard access. Use Ctrl+V.');
    }
  }

  const commands = {
    undo: () => undo(view),
    redo: () => redo(view),
    find: () => openSearchPanel(view),
    replace: () => {
      openSearchPanel(view);
      requestAnimationFrame(() => view.dom.querySelector('.cm-search input[name=replace]')?.focus());
    },
    findNext: () => findNext(view),
    findPrevious: () => findPrevious(view),
    selectAll: () => selectAll(view),
    toggleComment: () => toggleComment(view),
    toggleBlockComment: () => toggleBlockComment(view),
    moveLineUp: () => moveLineUp(view),
    moveLineDown: () => moveLineDown(view),
    copyLineUp: () => copyLineUp(view),
    copyLineDown: () => copyLineDown(view),
    addCursorAbove: () => addCursorAbove(view),
    addCursorBelow: () => addCursorBelow(view),
    selectNextOccurrence: () => selectNextOccurrence(view),
    selectAllOccurrences: () => selectSelectionMatches(view),
    expandSelection: () => selectParentSyntax(view),
    indent: () => indentMore(view),
    outdent: () => indentLess(view),
    deleteLine: () => deleteLine(view),
    foldAll: () => foldAll(view),
    unfoldAll: () => unfoldAll(view),
    upperCase: () => transform((s) => s.toUpperCase()),
    lowerCase: () => transform((s) => s.toLowerCase()),
    sortLines,
    trimTrailing,
    cut: () => document.execCommand('cut'),
    copy: () => document.execCommand('copy'),
    paste,
    cursorLeft: () => cursorCharLeft(view),
    cursorRight: () => cursorCharRight(view),
    cursorUp: () => cursorLineUp(view),
    cursorDown: () => cursorLineDown(view),
    insertText: (text) => view.dispatch(view.state.replaceSelection(text)),
    goto: (line, col = 1) => {
      const doc = view.state.doc;
      const target = doc.line(Math.min(Math.max(1, line), doc.lines));
      const pos = Math.min(target.from + Math.max(0, col - 1), target.to);
      view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    },
  };

  return {
    id: 'codemirror',

    open(doc) {
      if (current === doc) return;
      if (current) {
        states.set(current.id, view.state);
        scroll.set(current.id, view.scrollSnapshot());
      }
      const state = states.get(doc.id) || createState(doc);
      states.delete(doc.id);
      current = doc;
      view.setState(state);
      const snapshot = scroll.get(doc.id);
      if (snapshot) view.dispatch({ effects: snapshot });
      reportCursor();
    },

    close(doc) {
      if (current === doc) {
        current = null;
        view.setState(EditorState.create({ doc: '' }));
      }
      states.delete(doc.id);
      scroll.delete(doc.id);
      if (docs.delete(doc.id)) release(doc.id);
    },

    getText(doc) {
      const state = stateOf(doc);
      return state ? state.doc.toString() : null;
    },

    setText(doc, text, { keepDirty = false } = {}) {
      const state = stateOf(doc);
      if (!state) return;
      const change = minimalChange(state.doc.toString(), text);
      // Every group's editor is given the new text: never replay it.
      const annotations = noReplay.of(true);
      if (change.from !== change.to || change.insert) {
        if (current === doc) view.dispatch({ changes: change, annotations });
        else states.set(doc.id, state.update({ changes: change, annotations }).state);
      }
      if (!keepDirty) {
        setSaved(doc, stateOf(doc).doc);
        ctx.onDirty(doc, false);
      }
    },

    markSaved(doc) {
      const state = stateOf(doc);
      if (state) setSaved(doc, state.doc);
    },

    applyRemoteChanges(doc, changes) {
      const spec = { changes, annotations: [noReplay.of(true), Transaction.addToHistory.of(false)] };
      if (current === doc) view.dispatch(spec);
      else if (states.has(doc.id)) states.set(doc.id, states.get(doc.id).update(spec).state);
    },

    setLanguage(doc) {
      loadLanguage(doc.language.id).then((ext) => reconfigure(doc, [c.language.reconfigure(ext || [])]));
    },

    setDocOptions(doc) {
      const d = docExtensions(doc);
      reconfigure(doc, [c.indent.reconfigure(d.indent), c.readOnly.reconfigure(d.readOnly)]);
    },

    async setOptions(next) {
      options = next;
      applyCssOptions();
      minimapExtension = await ensureMinimap();
      const g = globalExtensions();
      const effects = ['wrap', 'gutters', 'activeLine', 'whitespace', 'brackets', 'cursor', 'minimap', 'dark'].map((k) => c[k].reconfigure(g[k]));
      view.dispatch({ effects });
      for (const [id, state] of states) states.set(id, state.update({ effects }).state);
      view.requestMeasure();
    },

    setTheme() {
      const effects = [c.dark.reconfigure(EditorView.darkTheme.of(currentTheme().kind === 'dark'))];
      view.dispatch({ effects });
      for (const [id, state] of states) states.set(id, state.update({ effects }).state);
    },

    supports: (command) => command in commands,

    exec(command, ...args) {
      const fn = commands[command];
      if (!fn) return false;
      view.focus();
      return fn(...args);
    },

    cursor() {
      if (!current) return null;
      const state = view.state;
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      return { line: line.number, col: head - line.from + 1, lines: state.doc.lines };
    },

    focus: () => view.focus(),
    layout: () => view.requestMeasure(),

    destroy() {
      clearTimeout(dirtyTimer);
      view.destroy();
      for (const id of docs.keys()) release(id);
      states.clear();
      scroll.clear();
      docs.clear();
    },
  };
}
