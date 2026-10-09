// MASKED: full CRUD for the four master functions (keyboard shortcuts,
// open/run launchers, clipboard snippets, and code), plus running them. Items
// are persisted server-side as editable JSON; this tab reads and writes them
// over the HTTP API and the list hot-reloads when a file is hand-edited.

import { $, el, api, haptic, toast, openModal, holdToConfirm } from './util.js';

const CATS = [
  { id: 'shortcuts', label: 'Shortcuts', icon: '⌨' },
  { id: 'launchers', label: 'Open / Run', icon: '🚀' },
  { id: 'clipboard', label: 'Clipboard', icon: '📋' },
  { id: 'scripts', label: 'Code', icon: '⚡' },
];

let active = 'shortcuts';
let appRef = null;

export function initMasked(app) {
  appRef = app;
  const nav = $('#masked-nav');
  CATS.forEach(cat => {
    nav.appendChild(el('button', {
      class: 'chip', text: `${cat.icon} ${cat.label}`, 'data-cat': cat.id,
      onclick: () => { active = cat.id; refreshNav(); loadCategory(); },
    }));
  });
  app.registerShow('masked', () => { refreshNav(); loadCategory(); });
}

function refreshNav() {
  [...$('#masked-nav').children].forEach(c => c.classList.toggle('active', c.dataset.cat === active));
}

async function loadCategory() {
  const body = $('#masked-body');
  body.innerHTML = '';
  const cat = CATS.find(c => c.id === active);
  const toolbar = el('div', { class: 'masked-toolbar' }, [
    el('h2', { text: cat.label }),
    el('button', { class: 'btn btn-primary btn-sm', text: '+ New', onclick: () => openEditor(null) }),
  ]);
  body.appendChild(toolbar);

  let list = [];
  try {
    list = await api(`/api/masked?category=${active}`);
  } catch (e) {
    body.appendChild(el('p', { class: 'empty', text: 'Could not load items.' }));
    return;
  }
  const items = Array.isArray(list) ? list.slice().sort((a, b) => (a.order || 0) - (b.order || 0)) : [];
  if (items.length === 0) {
    body.appendChild(el('p', { class: 'empty', text: 'Nothing here yet. Tap “+ New” to add one.' }));
    return;
  }
  items.forEach(item => body.appendChild(renderCard(item)));
}

function renderCard(item) {
  const head = el('div', { class: 'card-head' }, [
    el('span', { class: 'card-title', text: item.name || '(unnamed)' }),
    item.showInBand ? el('span', { class: 'badge band', text: 'band' }) : null,
  ]);
  const sub = el('div', { class: 'card-sub', text: summarize(item) });
  const actions = el('div', { class: 'card-actions' });

  const runBtn = el('button', { class: 'btn btn-sm btn-primary', text: 'Run', onclick: () => runItem(item) });
  const editBtn = el('button', { class: 'btn btn-sm', text: 'Edit', onclick: () => openEditor(item) });
  const delBtn = el('button', { class: 'btn btn-sm btn-danger', text: 'Hold to delete' });
  holdToConfirm(delBtn, 1000, () => deleteItem(item));

  actions.append(runBtn, editBtn, delBtn);
  const card = el('div', { class: 'card' }, [head, sub, actions]);
  return card;
}

function summarize(item) {
  switch (active) {
    case 'shortcuts': return item.combo || (item.keys ? item.keys.join('+') : '');
    case 'launchers': return item.target + (item.args ? ' ' + item.args : '');
    case 'clipboard': return (item.mode === 'type' ? 'Type: ' : 'Paste: ') + preview(item.text);
    case 'scripts': return `${item.lang || 'cmd'} · ${item.source === 'file' ? (item.path || 'file') : 'inline'}`;
    default: return item.description || '';
  }
}
function preview(t) { t = t || ''; return t.length > 40 ? t.slice(0, 40) + '…' : t; }

async function runItem(item) {
  haptic(12);
  if (active === 'scripts' && item.confirm !== false) {
    const ok = await confirmRun(item);
    if (!ok) return;
  }
  try {
    const res = await api('/api/run', { method: 'POST', body: { category: active, id: item.id } });
    reportResult(res);
  } catch (e) {
    toast('Run failed', 'error');
  }
}

function reportResult(res) {
  if (!res || res.ok === false) { toast((res && res.error) || 'Failed', 'error'); return; }
  if (res.kind === 'script' && res.launched && !res.detached) {
    showScriptOutput(res);
  } else {
    toast('Done', 'ok');
  }
}

function showScriptOutput(res) {
  const content = el('div', {}, [
    el('h2', { text: res.timedOut ? 'Script timed out' : `Script exited (${res.exitCode})` }),
    res.stdout ? el('pre', { class: 'logs', text: res.stdout }) : null,
    res.stderr ? el('pre', { class: 'logs', text: res.stderr, style: 'color:var(--danger)' }) : null,
    res.truncated ? el('p', { class: 'set-desc', text: 'Output was truncated.' }) : null,
    el('div', { class: 'modal-actions' }, [el('button', { class: 'btn', text: 'Close', onclick: () => close() })]),
  ]);
  const close = openModal(content);
}

async function deleteItem(item) {
  try {
    await api('/api/masked/delete', { method: 'POST', body: { category: active, id: item.id } });
    toast('Deleted', 'ok');
    loadCategory();
  } catch (e) { toast('Delete failed', 'error'); }
}

// ---- Editor modal ----------------------------------------------------------

function openEditor(item) {
  const isNew = !item;
  item = item || {};
  const form = el('form', { class: 'editor' });
  form.appendChild(el('h2', { text: `${isNew ? 'New' : 'Edit'} ${CATS.find(c => c.id === active).label}` }));

  const fName = textField('Name', item.name || '', 'name');
  const fDesc = textField('Description', item.description || '', 'description');
  form.append(fName.wrap, fDesc.wrap);

  const specific = [];
  if (active === 'shortcuts') {
    const combo = textField('Combination (e.g. Ctrl+Shift+Esc)', item.combo || (item.keys ? item.keys.join('+') : ''), 'combo');
    specific.push(combo);
  } else if (active === 'launchers') {
    specific.push(textField('Target (path, URL or .exe)', item.target || '', 'target'));
    specific.push(textField('Arguments (optional)', item.args || '', 'args'));
  } else if (active === 'clipboard') {
    specific.push(areaField('Text', item.text || '', 'text'));
    specific.push(selectField('Mode', [['paste', 'Paste (Ctrl+V)'], ['type', 'Type out']], item.mode || 'paste', 'mode'));
    specific.push(switchField('Restore previous clipboard', item.restore || false, 'restore'));
  } else if (active === 'scripts') {
    const lang = selectField('Language', [['cmd', 'CMD'], ['python', 'Python'], ['node', 'NodeJS'], ['ahkV1', 'AutoHotkey v1'], ['ahkV2', 'AutoHotkey v2'], ['other', 'Other']], item.lang || 'cmd', 'lang');
    const source = selectField('Source', [['inline', 'Inline code'], ['file', 'File on host']], item.source || 'inline', 'source');
    const code = areaField('Code', item.code || '', 'code');
    const path = textField('File path on host', item.path || '', 'path');
    const args = textField('Arguments (optional)', item.args || '', 'args');
    const detached = switchField('Run detached (no wait, for resident scripts)', item.runDetached || false, 'runDetached');
    const confirm = switchField('Ask before running', item.confirm !== false, 'confirm');
    const syncSource = () => {
      const v = source.input.value;
      code.wrap.hidden = v !== 'inline';
      path.wrap.hidden = v !== 'file';
    };
    source.input.addEventListener('change', syncSource);
    specific.push(lang, source, code, path, args, detached, confirm);
    setTimeout(syncSource, 0);
  }
  specific.forEach(f => form.appendChild(f.wrap));

  const band = switchField('Show on the shortcut band', item.showInBand || false, 'showInBand');
  const color = textField('Band dot colour (optional, e.g. #ff7fb6)', item.color || '', 'color');
  form.append(band.wrap, color.wrap);

  const actions = el('div', { class: 'modal-actions' }, [
    el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => close() }),
    el('button', { type: 'submit', class: 'btn btn-primary', text: 'Save' }),
  ]);
  form.appendChild(actions);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = collect(form);
    if (!item.id && !payload.name) { toast('Name is required', 'error'); return; }
    payload.id = item.id || undefined;
    try {
      await api('/api/masked/save', { method: 'POST', body: { category: active, item: payload } });
      toast('Saved', 'ok');
      close();
      loadCategory();
    } catch (err) { toast('Save failed', 'error'); }
  });

  const close = openModal(form);
}

function collect(form) {
  const out = {};
  form.querySelectorAll('[data-field]').forEach(node => {
    const key = node.dataset.field;
    if (node.type === 'checkbox') out[key] = node.checked;
    else out[key] = node.value;
  });
  // Normalise shortcut combos into both representations the server accepts.
  if (active === 'shortcuts' && out.combo) out.keys = out.combo.split('+').map(s => s.trim()).filter(Boolean);
  return out;
}

// ---- Field builders --------------------------------------------------------
function textField(label, value, key) {
  const input = el('input', { class: 'input', value, 'data-field': key });
  return { wrap: el('div', { class: 'field' }, [el('label', { text: label }), input]), input };
}
function areaField(label, value, key) {
  const input = el('textarea', { class: 'textarea', 'data-field': key });
  input.value = value;
  return { wrap: el('div', { class: 'field' }, [el('label', { text: label }), input]), input };
}
function selectField(label, options, value, key) {
  const input = el('select', { 'data-field': key });
  options.forEach(([v, l]) => {
    const o = el('option', { value: v, text: l });
    if (v === value) o.selected = true;
    input.appendChild(o);
  });
  return { wrap: el('div', { class: 'field' }, [el('label', { text: label }), input]), input };
}
function switchField(label, checked, key) {
  const input = el('input', { type: 'checkbox', 'data-field': key });
  input.checked = !!checked;
  const sw = el('label', { class: 'switch' }, [input, el('span', { class: 'track' }), el('span', { class: 'thumb' })]);
  return { wrap: el('div', { class: 'switch-row' }, [el('span', { class: 'label', text: label }), sw]), input };
}

function confirmRun(item) {
  return new Promise(resolve => {
    const content = el('div', {}, [
      el('h2', { text: 'Run this code?' }),
      el('p', { class: 'set-desc', text: `${item.name} — ${item.lang || 'cmd'}. This runs on the host.` }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn', text: 'Cancel', onclick: () => { close(); resolve(false); } }),
        el('button', { class: 'btn btn-danger', text: 'Run', onclick: () => { close(); resolve(true); } }),
      ]),
    ]);
    const close = openModal(content);
  });
}
