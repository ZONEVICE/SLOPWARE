/** Small, dependency-free DOM primitives. Never pass model/user text to innerHTML. */
export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && !key.startsWith('aria')) node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  children.flat(Infinity).forEach(child => { if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child))); });
  return node;
}

export function button(text, onClick, className = 'button secondary', attributes = {}) {
  return el('button', { type: 'button', class: className, text, onClick, ...attributes });
}

export function badge(text, type = '') { return el('span', { class: `badge ${type}`, text }); }
export function shortModel(model) { return model.replace(/^hf\.co\//, '').split('/').pop() || 'No model selected'; }
export function configurationBadge(chat) { return badge(chat.configMode === 'custom' ? 'Custom config' : 'Global snapshot', chat.configMode); }
export function formatDate(value) { return new Date(value).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }); }
export function chatStatus(chat) { return chat.turns.find(turn => turn.status === 'running')?.status || chat.turns.find(turn => turn.status === 'queued')?.status || chat.turns.at(-1)?.status || 'draft'; }
export function statusLabel(status) { return ({ draft: 'Ready to prompt', running: 'Generating', queued: 'Queued', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' })[status] || status; }
export function jobForTurn(state, turnId) { return state.jobs.findLast(job => job.turnId === turnId); }
export function submitShortcut(textarea, form) {
  textarea.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
}

/** Intentionally small, safe Markdown subset. Raw HTML remains literal text. */
function inline(text) {
  const fragment = document.createDocumentFragment();
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith('`') && part.endsWith('`')) fragment.append(el('code', { text: part.slice(1, -1) }));
    else if (part.startsWith('**') && part.endsWith('**')) fragment.append(el('strong', { text: part.slice(2, -2) }));
    else fragment.append(document.createTextNode(part));
  }
  return fragment;
}

export function renderMarkdown(text) {
  const fragment = document.createDocumentFragment();
  let code = null, language = '', paragraph = [], list = null;
  const flush = () => { if (paragraph.length) { fragment.append(el('p', {}, inline(paragraph.join('\n')))); paragraph = []; } list = null; };
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (code !== null) { fragment.append(el('pre', { 'data-language': language }, el('code', { text: code.join('\n') }))); code = null; }
      else { flush(); language = line.trim().slice(3); code = []; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { flush(); fragment.append(el(`h${Math.min(heading[1].length + 2, 6)}`, {}, inline(heading[2]))); continue; }
    const item = /^\s*([-*]|\d+\.)\s+(.+)$/.exec(line);
    if (item) {
      const type = /\d/.test(item[1]) ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== type) { flush(); list = el(type); fragment.append(list); }
      list.append(el('li', {}, inline(item[2]))); continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  if (code !== null) fragment.append(el('pre', { 'data-language': language }, el('code', { text: code.join('\n') })));
  return fragment;
}

export function downloadJson(value, filename) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = el('a', { href: url, download: filename });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
