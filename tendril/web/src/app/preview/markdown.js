/**
 * Markdown to safe HTML for the preview (features/markdown.js). Loaded only
 * when a preview opens, as its own chunk.
 *
 * - GitHub-flavoured Markdown through `marked`: tables, task lists,
 *   strikethrough, autolinks; headings get GitHub-style ids for #anchors.
 * - Everything `marked` produces, including raw HTML written in the
 *   Markdown, goes through an allowlist sanitizer in an inert document
 *   before it reaches the page: unknown elements are unwrapped, dangerous
 *   ones dropped with their content, attributes and URL schemes filtered.
 *   Tendril's Content-Security-Policy forbids inline scripts and event
 *   handlers anyway, so a gap here still could not run code.
 * - Relative links and images point into the workspace; remote images are
 *   allowed by the CSP (https, and http when Tendril itself runs on http).
 * - Code blocks are colored with the CodeMirror grammars (same chunks as
 *   the editor) and the theme's syntax colors.
 */
import { classHighlighter, highlightCode } from '@lezer/highlight';
import { Marked } from 'marked';

import { api } from '../core/api.js';
import { LANGUAGES } from '../core/languages.js';
import { dirname, resolve } from '../core/paths.js';
import { loadLanguage } from '../editors/codemirror/languages.js';

const marked = new Marked({ gfm: true, breaks: false, async: false });

/** Allowed elements and, for each, its allowed attributes. */
const ALLOWED = new Map(Object.entries({
  a: ['href', 'title', 'name'],
  abbr: ['title'],
  b: [], blockquote: [], br: [], caption: [], center: [], cite: [], code: ['class'], col: [], colgroup: [],
  dd: [], del: [], details: ['open'], dfn: [], div: ['align'], dl: [], dt: [], em: [],
  figcaption: [], figure: [], h1: ['align'], h2: ['align'], h3: ['align'], h4: ['align'], h5: ['align'], h6: ['align'],
  hr: [], i: [], img: ['src', 'alt', 'title', 'width', 'height', 'align'], input: ['type', 'checked', 'disabled'],
  ins: [], kbd: [], li: ['value'], mark: [], ol: ['start', 'type'], p: ['align'], pre: [], q: ['cite'], s: [],
  samp: [], small: [], span: [], strike: [], strong: [], sub: [], summary: [], sup: [],
  table: [], tbody: [], td: ['align', 'colspan', 'rowspan'], tfoot: [], th: ['align', 'colspan', 'rowspan'],
  thead: [], tr: [], tt: [], u: [], ul: [], var: [],
}));

/** Removed together with their content. */
const DROPPED = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'textarea',
  'select', 'button', 'option', 'svg', 'math', 'template', 'noscript', 'link', 'meta', 'base', 'head', 'title',
  'video', 'audio', 'source', 'track', 'canvas', 'portal', 'dialog',
]);

/** Fence names that are not a language id or extension of core/languages.js. */
const ALIASES = { sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', shellsession: 'shell', ps1: 'powershell', pwsh: 'powershell', py: 'python', rs: 'rust', yml: 'yaml', js: 'javascript', ts: 'typescript', md: 'markdown', 'c++': 'cpp', cs: 'csharp', kt: 'kotlin', golang: 'go', docker: 'dockerfile', patch: 'diff' };

function languageOfFence(info) {
  const name = info.trim().toLowerCase();
  if (!name) return null;
  const id = ALIASES[name] || name;
  return LANGUAGES.find((l) => l.id === id || (l.ext || []).includes(id))?.id || null;
}

/** A URL the preview may use: web and mail links, anchors, workspace paths. */
function safeUrl(value, { image = false } = {}) {
  const url = value.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (!scheme) return url; // relative, rooted or #anchor
  if (scheme === 'http' || scheme === 'https') return url;
  if (!image && scheme === 'mailto') return url;
  if (image && /^data:image\/(png|gif|jpe?g|webp|avif|bmp);/i.test(url)) return url;
  return null;
}

/** Sanitizes `root` in place (an element of an inert document). */
function sanitize(root) {
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.localName;
      if (DROPPED.has(tag)) {
        child.remove();
        continue;
      }
      walk(child);
      const allowed = ALLOWED.get(tag);
      if (!allowed) {
        child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attr of [...child.attributes]) {
        if (!allowed.includes(attr.name)) child.removeAttribute(attr.name);
      }
      if (tag === 'input') {
        if (child.getAttribute('type') !== 'checkbox') {
          child.remove();
          continue;
        }
        // Task-list boxes: inert (CSS ignores clicks, no focus) but not
        // `disabled`, which browsers draw too faint to read.
        child.removeAttribute('disabled');
        child.setAttribute('tabindex', '-1');
        child.setAttribute('aria-readonly', 'true');
      }
      if (tag === 'code' && !/^language-[\w+#.-]+$/.test(child.getAttribute('class') || '')) child.removeAttribute('class');
      for (const name of ['href', 'src', 'cite']) {
        if (!child.hasAttribute(name)) continue;
        const safe = safeUrl(child.getAttribute(name), { image: name === 'src' });
        if (safe === null) child.removeAttribute(name);
        else child.setAttribute(name, safe);
      }
    }
  };
  walk(root);
}

/** GitHub-style heading ids, so "#section" links work. */
function addHeadingIds(root) {
  const seen = new Map();
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const base = heading.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    heading.id = count ? `${base}-${count}` : base;
  }
}

/** Points relative images at the workspace file API. */
function resolveImages(root, path) {
  const base = dirname(path);
  for (const img of root.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) continue;
    const target = resolve(base, decodeURIComponent(src.split(/[?#]/)[0]));
    if (target === null) img.removeAttribute('src');
    else img.setAttribute('src', api.fileUrl(target));
    img.setAttribute('loading', 'lazy');
  }
}

/** Colors fenced code with the CodeMirror grammar of its language. */
async function highlightBlocks(root) {
  const jobs = [...root.querySelectorAll('pre > code[class^="language-"]')].map(async (code) => {
    const id = languageOfFence(code.className.slice('language-'.length));
    if (!id) return;
    const support = await loadLanguage(id);
    const parser = support?.language?.parser || support?.parser;
    if (!parser) return;
    const text = code.textContent;
    const out = document.createDocumentFragment();
    highlightCode(
      text,
      parser.parse(text),
      classHighlighter,
      (piece, classes) => {
        if (!classes) out.append(piece);
        else {
          const span = document.createElement('span');
          span.className = classes;
          span.textContent = piece;
          out.append(span);
        }
      },
      () => out.append('\n'),
    );
    code.replaceChildren(out);
  });
  await Promise.all(jobs);
}

/**
 * Renders Markdown `text` of the workspace file `path` into a fresh
 * `<article class="markdown-body">`.
 */
export async function renderMarkdown(text, path) {
  const html = marked.parse(text);
  const inert = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  const body = inert.body;
  sanitize(body);
  addHeadingIds(body);
  resolveImages(body, path);
  const article = document.createElement('article');
  article.className = 'markdown-body';
  article.append(...[...body.childNodes].map((node) => document.importNode(node, true)));
  await highlightBlocks(article);
  return article;
}

/** Exposed for the unit tests. */
export const internals = { safeUrl, languageOfFence };
