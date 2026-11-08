/**
 * A file's changes for git (features/git.js): the text git has (HEAD or the
 * index) against the newer one (the index or the working tree), in
 * read-only CodeMirror views from @codemirror/merge with the editor's
 * colors. Side by side; one unified column on narrow screens. Loaded only
 * when a diff opens, whichever editor engine is in use.
 */
import { syntaxHighlighting } from '@codemirror/language';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, highlightSpecialChars, lineNumbers } from '@codemirror/view';

import { currentTheme } from '../core/themes.js';
import { loadLanguage } from '../editors/codemirror/languages.js';
import { highlightStyle, theme } from '../editors/codemirror/theme.js';

/** Unchanged runs longer than this fold away, keeping some context. */
const COLLAPSE = { margin: 3, minSize: 6 };

/**
 * Renders the diff of `original` -> `modified` into `el`. Returns a function
 * that frees the views.
 */
export async function renderDiff(el, { original, modified, languageId, narrow }) {
  const language = (await loadLanguage(languageId)) || [];
  const extensions = [
    lineNumbers(),
    highlightSpecialChars(),
    syntaxHighlighting(highlightStyle),
    theme,
    EditorView.darkTheme.of(currentTheme().kind === 'dark'),
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    language,
  ];
  el.replaceChildren();
  if (narrow) {
    const view = new EditorView({
      parent: el,
      doc: modified,
      extensions: [...extensions, unifiedMergeView({ original, mergeControls: false, gutter: true, collapseUnchanged: COLLAPSE })],
    });
    return () => view.destroy();
  }
  const merge = new MergeView({
    a: { doc: original, extensions },
    b: { doc: modified, extensions },
    parent: el,
    gutter: true,
    highlightChanges: true,
    collapseUnchanged: COLLAPSE,
  });
  return () => merge.destroy();
}
