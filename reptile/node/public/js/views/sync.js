/**
 * "Sync a directory".
 *
 *  1. Choose the instance: one click on a discovered instance that hosts a
 *     directory, or type its IP and port and let Reptile verify it.
 *  2. The absolute local path where the synced directory is stored.
 *  3. The PIN. A wrong one can be retried as often as needed.
 *
 * "Connect" verifies everything with the host before this instance changes
 * mode, so a wrong PIN never stops an ongoing hosting.
 */
import { api } from '../core/api.js';
import { h, icon, replace, withBusy } from '../core/dom.js';
import { protocolLabel } from '../core/format.js';
import { createInstanceList, unavailableReason } from '../components/instanceList.js';
import { createPathField } from '../components/pathField.js';
import { createPinInput } from '../components/pinInput.js';
import { toast } from '../components/toast.js';

export function syncView({ store, navigate, query }) {
  /** The chosen source: { uuid, hostname, address, port, protocol, hosting }. */
  let target = null;
  let pathWasSuggested = false;

  const formError = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const modeNote = h('div');
  const selected = h('div', { class: 'selected-target', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn primary', disabled: true }, icon('sync'), 'Connect');

  const instances = createInstanceList({ selectable: true, onSelect: (instance) => choose(instance) });

  // --- Manual entry -------------------------------------------------------------
  const manualAddress = h('input', { class: 'input mono', type: 'text', inputmode: 'decimal', placeholder: '192.168.1.20', 'aria-label': 'IP address', autocomplete: 'off', spellcheck: 'false' });
  const manualPort = h('input', { class: 'input mono port', type: 'number', min: '1', max: '65535', value: '55667', 'aria-label': 'Port' });
  const manualResult = h('div', { class: 'check', 'aria-live': 'polite' });
  const manualCheck = h('button', { type: 'button', class: 'btn' }, icon('check'), 'Verify');
  const manual = h(
    'details',
    { class: 'manual' },
    h('summary', { text: 'The instance is not listed? Enter its address' }),
    h('p', { class: 'hint', text: 'The IP address and port shown in the status bar of the other instance.' }),
    h('div', { class: 'input-row' }, manualAddress, manualPort, manualCheck),
    manualResult,
  );

  const showManual = (kind, text) => {
    manualResult.className = `check ${kind}`;
    replace(manualResult, kind === 'ok' ? icon('check') : kind === 'error' ? icon('x') : null, h('span', { text }));
  };

  const verifyManual = async () => {
    const address = manualAddress.value.trim();
    const port = Number(manualPort.value);
    if (!address) {
      showManual('error', 'Type the IP address of the other instance.');
      manualAddress.focus();
      return;
    }
    await withBusy(manualCheck, async () => {
      showManual('pending', `Contacting ${address}:${port}…`);
      try {
        const answer = await api.post('/api/sync/inspect', { address, port });
        const info = answer.info;
        if (answer.self) {
          showManual('error', 'That is this same instance.');
          return;
        }
        if (!answer.compatible) {
          showManual('error', `Found Reptile on ${info.hostname}, but it uses ${protocolLabel(info.protocol)} and this instance uses ${protocolLabel(store.get()?.identity.protocol)}. Both must use the same protocol.`);
          return;
        }
        if (!info.hosting) {
          showManual('error', `Found Reptile on ${info.hostname}, but it is not hosting a directory.`);
          return;
        }
        if (info.hosting.connected) {
          showManual('error', `${info.hostname} is hosting “${info.hosting.name}”, but another instance is already connected to it.`);
          return;
        }
        showManual('ok', `${info.hostname} is hosting “${info.hosting.name}”.`);
        instances.select(null);
        choose({ ...info, compatible: true });
      } catch (error) {
        showManual('error', error.message);
      }
    });
  };
  manualCheck.addEventListener('click', verifyManual);
  for (const input of [manualAddress, manualPort]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        verifyManual();
      }
    });
  }

  // --- Local path and PIN -------------------------------------------------------
  const pathField = createPathField({
    purpose: 'sync',
    id: 'sync-path',
    placeholder: '/home/you/Synced',
    onResult: () => updateSubmit(),
  });
  pathField.input.addEventListener('input', () => {
    pathWasSuggested = false;
  });

  const pinError = h('p', { class: 'check error', hidden: true });
  const pinInput = createPinInput({ label: 'PIN', onInput: () => (pinError.hidden = true) });

  async function choose(instance) {
    target = instance;
    formError.hidden = true;
    replace(selected, icon('folder'), h('span', { text: `“${instance.hosting?.name}” hosted by ${instance.hostname} · ${instance.address}:${instance.port} · ${protocolLabel(instance.protocol)}` }));
    selected.hidden = false;
    // Suggest a local path from the share's name, unless the user typed one.
    if (!pathField.value || pathWasSuggested) {
      try {
        const { path } = await api.get(`/api/paths/suggest?name=${encodeURIComponent(instance.hosting?.name || '')}`);
        if (!pathField.value || pathWasSuggested) {
          pathField.set(path);
          pathWasSuggested = true;
        }
      } catch {
        /* the user can type a path */
      }
    }
    updateSubmit();
    pinInput.focus();
  }

  function updateSubmit() {
    submit.disabled = !(target && pathField.result?.ok && store.get()?.mode !== 'syncing');
  }

  const form = h(
    'form',
    { class: 'setup', novalidate: true },
    modeNote,
    h(
      'section',
      { class: 'panel step' },
      h('div', { class: 'step-title' }, h('span', { class: 'step-number', text: '1' }), h('h2', { text: 'Instance' })),
      h('p', { class: 'hint', text: 'Pick an instance that is hosting a directory. Instances using the other protocol are listed as incompatible.' }),
      instances.el,
      manual,
      selected,
    ),
    h(
      'section',
      { class: 'panel step' },
      h('div', { class: 'step-title' }, h('span', { class: 'step-number', text: '2' }), h('label', { for: 'sync-path' }, h('h2', { text: 'Local directory' }))),
      h('p', { class: 'hint', text: 'Where the synced directory is stored on this computer. Its content is merged with the host’s.' }),
      pathField.input,
      pathField.status,
    ),
    h(
      'section',
      { class: 'panel step' },
      h('div', { class: 'step-title' }, h('span', { class: 'step-number', text: '3' }), h('h2', { text: 'PIN' })),
      h('p', { class: 'hint', text: 'The 4-digit PIN shown on the hosting instance.' }),
      h('div', { class: 'input-row' }, pinInput.el),
      pinError,
    ),
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
        await api.post('/api/sync', { address: target.address, port: target.port, localPath: pathField.result?.path || pathField.value, pin: pinInput.value });
        toast(`Connected to ${target.hostname}.`);
        navigate('#/');
      } catch (error) {
        if (error.code === 'pin_invalid') {
          pinError.textContent = 'Wrong PIN. Try again.';
          pinError.hidden = false;
          pinInput.markInvalid();
        } else {
          formError.textContent = error.message;
          formError.hidden = false;
        }
      }
    });
    updateSubmit();
  });

  const el = h(
    'div',
    { class: 'page' },
    h('header', { class: 'page-head' }, h('a', { class: 'back', href: '#/' }, icon('back'), 'Start'), h('h1', { text: 'Sync a directory' }), h('p', { text: 'Receive a directory hosted by another Reptile instance and keep both copies identical, in both directions.' })),
    form,
  );

  let preselected = query.get('uuid');
  const unsubscribe = store.subscribe((state) => {
    instances.update(state.discovery);
    if (preselected) {
      const match = state.discovery.instances.find((instance) => instance.uuid === preselected);
      if (match && !unavailableReason(match)) {
        instances.select(match.uuid);
        instances.update(state.discovery);
        choose(match);
      }
      preselected = null;
    }
    if (state.mode === 'hosting') {
      replace(modeNote, h('div', { class: 'notice warning' }, icon('alert'), h('span', null, `Connecting will stop hosting “${state.hosting?.name}”: an instance either hosts or syncs. If the PIN is wrong, hosting continues.`)));
    } else if (state.mode === 'syncing') {
      replace(modeNote, h('div', { class: 'notice warning' }, icon('alert'), h('span', null, 'This instance is already syncing a directory. Stop syncing on the start screen first.')));
    } else {
      replace(modeNote);
    }
    updateSubmit();
  });

  return {
    el,
    destroy() {
      unsubscribe();
      pathField.destroy();
    },
  };
}
