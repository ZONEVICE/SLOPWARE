/**
 * The CodeMirror look of Tendril: editor chrome and syntax colors taken from
 * the CSS variables of the current theme (styles/themes.css), so switching
 * themes needs no reconfiguration. Shared by the editor adapter and the
 * diff viewer (viewers/diff.js).
 */
import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

export const theme = EditorView.theme({
  '&': {
    color: 'var(--editor-fg)',
    backgroundColor: 'var(--editor-bg)',
    height: '100%',
    fontSize: 'var(--editor-font-size, 14px)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--editor-font-family)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--editor-cursor)', padding: '4px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--editor-cursor)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--editor-selection) !important',
  },
  '.cm-activeLine': { backgroundColor: 'var(--editor-line)' },
  '.cm-gutters': {
    backgroundColor: 'var(--editor-gutter)',
    color: 'var(--editor-gutter-fg)',
    border: 'none',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--editor-gutter-active)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 14px', minWidth: '36px' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--fg-subtle)', padding: '0 4px', cursor: 'pointer' },
  '.cm-searchMatch': { backgroundColor: 'var(--editor-match)', outline: '1px solid var(--accent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--editor-selection)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--editor-match)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--editor-bracket)', outline: 'none' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'transparent', outline: '1px solid var(--danger)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-2)', border: 'none', color: 'var(--fg-muted)', padding: '0 4px' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    boxShadow: 'var(--shadow)',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--editor-font-family)' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 10px 2px 6px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--fg)' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent)', fontWeight: '600' },
  '.cm-panels': { backgroundColor: 'var(--bg-alt)', color: 'var(--fg)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-highlightSpace': { backgroundImage: 'radial-gradient(circle at 50% 55%, var(--fg-subtle) 12%, transparent 13%)' },
  '.cm-highlightTab': { backgroundImage: 'none', borderBottom: '1px dotted var(--editor-guide)' },
  '.cm-specialChar': { color: 'var(--danger)' },
});

export const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.character, t.inserted, t.attributeValue], color: 'var(--syn-string)' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'var(--syn-comment-style)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName), t.definition(t.typeName)], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--syn-property)' },
  { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--syn-variable)' },
  { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator], color: 'var(--syn-operator)' },
  { tag: [t.punctuation, t.bracket, t.separator, t.angleBracket, t.squareBracket, t.paren, t.brace], color: 'var(--syn-punct)' },
  { tag: [t.tagName], color: 'var(--syn-tag)' },
  { tag: [t.attributeName], color: 'var(--syn-attr)' },
  { tag: [t.constant(t.variableName), t.standard(t.variableName), t.self, t.special(t.variableName)], color: 'var(--syn-constant)' },
  { tag: [t.regexp, t.escape, t.special(t.regexp)], color: 'var(--syn-regexp)' },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: 'var(--syn-heading)', fontWeight: 'bold' },
  { tag: [t.link, t.url], color: 'var(--syn-link)', textDecoration: 'underline' },
  { tag: [t.meta, t.annotation, t.processingInstruction, t.documentMeta], color: 'var(--syn-meta)' },
  { tag: t.invalid, color: 'var(--syn-invalid)' },
  { tag: t.deleted, color: 'var(--danger)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
]);
