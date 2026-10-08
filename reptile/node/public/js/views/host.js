/**
 * "Host a directory".
 *
 *  1. The absolute path, validated while typing.
 *  2. An optional display name (defaults to the directory's own name).
 *  3. A PIN, generated automatically and editable.
 *  4. The content tree: everything checked by default; only checked items are
 *     shared. It appears as soon as the path is verified.
 *
 * "Host" starts hosting and returns to the start screen.
 */
import { api } from '../core/api.js';
import { h, icon, replace, withBusy } from '../core/dom.js';
import { lastSegment } from '../core/format.js';
import { createPathField } from '../components/pathField.js';
import { createPinInput } from '../components/pinInput.js';
import { toast } from '../components/toast.js';
import { createTree } from '../components/tree.js';

export function hostView({ store, navigate }) {
  const formError = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const modeNote = h('div');
  const submit = h('button', { type: 'submit', class: 'btn primary', disabled: true }, icon('host'), 'Host');

  const treeStatus = h('p', { class: 'hint' });
  const tree = createTree({ onChange: () => updateSubmit() });
  const treeSection = h(
    'section',
    { class: 'panel step', hidden: true },
    h('div', { class: 'step-title' }, h('span', { class: 'step-number', text: '4' }), h('h2', { text: 'Content to share' })),
    h('p', { class: 'hint', text: 'Only checked items are shared with the instance that connects. Unchecked items never leave this computer and cannot be changed from the other side. Unchecking a folder unchecks everything inside it.' }),
    h(
      'div',
      { class: 'tree-toolbar' },
      tree.summary,
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'btn small', text: 'Select all', onclick: () => tree.selectAll() }),
        h('button', { type: 'button', class: 'btn small', text: 'Select none', onclick: () => tree.selectNone() }),
        h('button', { type: 'button', class: 'btn ghost small', text: 'Expand all', onclick: () => tree.expandAll() }),
        h('button', { type: 'button', class: 'btn ghost small', text: 'Collapse all', onclick: () => tree.collapseAll() }),
      ),
    ),
    treeStatus,
    tree.el,
  );

  let treeFor = null;
  let treeSequence = 0;

  const loadTree = async (path) => {
    const mine = ++treeSequence;
    treeFor = path;
    treeSection.hidden = false;
    treeStatus.textContent = 'Reading the directory…';
    tree.clear();
    updateSubmit();
    try {
      const answer = await api.post('/api/paths/tree', { path });
      if (mine !== treeSequence) return;
      tree.setData(answer.tree);
      treeStatus.textContent = answer.truncated ? `Only the first ${answer.total} entries are listed; everything else is shared unless it is inside an unchecked folder.` : '';
    } catch (error) {
      if (mine !== treeSequence) return;
      treeStatus.textContent = error.message;
    }
    updateSubmit();
  };

  const pathField = createPathField({
    purpose: 'host',
    id: 'host-path',
    placeholder: '/home/you/Documents',
    onResult: (result) => {
      if (result?.ok) {
        nameInput.placeholder = lastSegment(result.path) || 'Directory name';
        if (treeFor !== result.path) loadTree(result.path);
      } else {
        treeSequence += 1;
        treeFor = null;
        treeSection.hidden = true;
        tree.clear();
      }
      updateSubmit();
    },
  });

  const nameInput = h('input', { id: 'host-name', class: 'input', type: 'text', maxlength: '80', placeholder: 'Directory name', autocomplete: 'off' });
  const pinInput = createPinInput({ label: 'PIN' });
  const pinError = h('p', { class: 'check error', hidden: true });
  const randomPin = async () => {
    try {
      const { pin } = await api.get('/api/host/pin/suggest');
      pinInput.value = pin;
    } catch {
      pinInput.value = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    }
  };
  randomPin();

  function updateSubmit() {
    const ready = pathField.result?.ok && tree.hasSelection && treeFor === pathField.result.path;
    submit.disabled = !ready || store.get()?.mode === 'hosting';
  }

  const form = h(
    'form',
    { class: 'setup', novalidate: true },
    modeNote,
    h(
      'section',
      { class: 'panel step' },
      h('div', { class: 'step-title' }, h('span', { class: 'step-number', text: '1' }), h('label', { for: 'host-path' }, h('h2', { text: 'Directory' }))),
      h('p', { class: 'hint', text: 'The absolute path of the directory on this computer.' }),
      pathField.input,
      pathField.status,
    ),
    h(
      'section',
      { class: 'panel step' },
      h('div', { class: 'step-title' }, h('span', { class: 'step-number', text: '2' }), h('label', { for: 'host-name' }, h('h2', null, 'Name', h('span', { class: 'optional', text: 'optional' })))),
      h('p', { class: 'hint', text: 'How other instances see this directory. Leave it empty to use the directory’s own name.' }),
      nameInput,
    ),
    h(
      'section',
      { class: 'panel step' },
      h('div', { class: 'step-title' }, h('span', { class: 'step-number', text: '3' }), h('h2', { text: 'PIN' })),
      h('p', { class: 'hint', text: 'The instance that connects must type these 4 digits. It is a symbolic protection only: there is no limit on attempts. You can change it at any time, even while hosting.' }),
      h('div', { class: 'input-row' }, pinInput.el, h('button', { type: 'button', class: 'btn', onclick: randomPin }, icon('dice'), 'New random PIN')),
      pinError,
    ),
    treeSection,
    formError,
    h('div', { class: 'form-actions' }, submit, h('a', { class: 'btn', href: '#/', text: 'Cancel' })),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    formError.hidden = true;
    pinError.hidden = true;
    if (!pinInput.valid) {
      pinError.textContent = 'The PIN must be exactly 4 digits.';
      pinError.hidden = false;
      pinInput.markInvalid();
      return;
    }
    await withBusy(submit, async () => {
      try {
        const status = await api.post('/api/host', {
          path: pathField.result?.path || pathField.value,
          name: nameInput.value.trim(),
          pin: pinInput.value,
          excluded: tree.excluded(),
        });
        toast(`Hosting “${status.name}” with PIN ${status.pin}.`);
        navigate('#/');
      } catch (error) {
        formError.textContent = error.message;
        formError.hidden = false;
      }
    });
    updateSubmit();
  });

  const el = h(
    'div',
    { class: 'page' },
    h('header', { class: 'page-head' }, h('a', { class: 'back', href: '#/' }, icon('back'), 'Start'), h('h1', { text: 'Host a directory' }), h('p', { text: 'Share one directory from this computer with one other Reptile instance on this network.' })),
    form,
  );

  const unsubscribe = store.subscribe((state) => {
    if (state.mode === 'hosting') {
      replace(modeNote, h('div', { class: 'notice warning' }, icon('alert'), h('span', null, `This instance is already hosting “${state.hosting?.name}”. Stop hosting it on the start screen before hosting another directory.`)));
    } else if (state.mode === 'syncing') {
      replace(modeNote, h('div', { class: 'notice warning' }, icon('alert'), h('span', null, `Hosting will stop syncing “${state.syncing?.share?.name || 'the current directory'}”: an instance either hosts or syncs.`)));
    } else {
      replace(modeNote);
    }
    updateSubmit();
  });

  setTimeout(() => pathField.focus(), 0);

  return {
    el,
    destroy() {
      unsubscribe();
      pathField.destroy();
    },
  };
}
