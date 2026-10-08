/**
 * The start screen.
 *
 * What it shows depends on the instance's single mode:
 *   idle     -> the two actions, "Host a directory" and "Sync a directory";
 *   hosting  -> the hosted directory, its PIN (changeable at any time), the
 *               connection state and activity, and the ways out: stop hosting
 *               or switch to syncing;
 *   syncing  -> the synced directory, the connection state (including the
 *               "the host changed the PIN" prompt) and activity.
 * The instances found on the network are listed alongside in every mode.
 */
import { api } from '../core/api.js';
import { h, icon, replace, withBusy } from '../core/dom.js';
import { formatBytes, plural, protocolLabel, timeAgo } from '../core/format.js';
import { createActivityList } from '../components/activityList.js';
import { confirmDialog } from '../components/confirm.js';
import { createInstanceList } from '../components/instanceList.js';
import { createPinInput } from '../components/pinInput.js';
import { toast } from '../components/toast.js';

function noticeBox(notice) {
  if (!notice?.message) return null;
  const kind = notice.kind === 'error' ? 'error' : notice.kind === 'warning' ? 'warning' : '';
  return h('div', { class: `notice ${kind}`, role: kind ? 'alert' : 'status' }, icon(kind ? 'alert' : 'info'), h('span', { text: notice.message }));
}

// --- Idle --------------------------------------------------------------------

function idlePanel() {
  const notices = h('div', { class: 'stack' });
  const el = h(
    'section',
    { class: 'stack' },
    h('div', { class: 'intro' }, h('h1', { text: 'What do you want to do?' }), h('p', { text: 'Reptile keeps one directory identical on two computers of this network, in real time and in both directions. One instance hosts it, the other one syncs it.' })),
    notices,
    h(
      'div',
      { class: 'choices' },
      h(
        'a',
        { class: 'choice', href: '#/host' },
        h('span', { class: 'choice-icon' }, icon('host')),
        h('h2', { text: 'Host a directory' }),
        h('p', { text: 'Share a directory from this computer. One other instance can connect to it with a PIN and keep a synchronised copy.' }),
        h('span', { class: 'go', text: 'Choose a directory →' }),
      ),
      h(
        'a',
        { class: 'choice', href: '#/sync' },
        h('span', { class: 'choice-icon' }, icon('sync')),
        h('h2', { text: 'Sync a directory' }),
        h('p', { text: 'Receive a directory hosted by another instance on this network and keep both copies identical.' }),
        h('span', { class: 'go', text: 'Choose an instance →' }),
      ),
    ),
  );
  return {
    el,
    update(state) {
      const notice = state.hosting && !state.hosting.active ? noticeBox(state.hosting.notice) : null;
      replace(notices, notice);
      notices.hidden = !notice;
    },
  };
}

// --- Hosting -----------------------------------------------------------------

function hostingPanel({ navigate }) {
  const title = h('h1');
  const path = h('code');
  const pinValue = h('span', { class: 'pin-display', 'aria-label': 'Current PIN' });
  const connectionDot = h('span', { class: 'dot' });
  const connectionText = h('span');
  const connectionDetail = h('p', { class: 'connection-detail' });
  const progress = h('div', { class: 'progress', hidden: true }, h('span'));
  const stats = h('div', { class: 'stats' });
  const warning = h('div');
  const activity = createActivityList();

  // PIN editor: hidden until "Change PIN" is clicked. It is never rebuilt by
  // updates, so typing is not interrupted by live refreshes.
  const pinError = h('p', { class: 'check error', hidden: true });
  const pinInput = createPinInput({ label: 'New PIN', onEnter: () => savePin(false) });
  const editor = h(
    'div',
    { class: 'stack', hidden: true },
    h('div', { class: 'input-row' }, pinInput.el),
    h(
      'div',
      { class: 'actions-row' },
      h('button', { type: 'button', class: 'btn primary small', text: 'Save PIN', onclick: (event) => savePin(false, event.currentTarget) }),
      h('button', { type: 'button', class: 'btn small', onclick: (event) => savePin(true, event.currentTarget) }, icon('dice'), 'Random'),
      h('button', { type: 'button', class: 'btn ghost small', text: 'Cancel', onclick: () => toggleEditor(false) }),
    ),
    pinError,
  );
  const changeButton = h('button', { type: 'button', class: 'btn small', onclick: () => toggleEditor(true) }, icon('lock'), 'Change PIN');

  function toggleEditor(open) {
    editor.hidden = !open;
    changeButton.hidden = open;
    pinError.hidden = true;
    if (open) {
      pinInput.value = '';
      pinInput.focus();
    }
  }

  async function savePin(random, button) {
    if (!random && !pinInput.valid) {
      pinError.textContent = 'The PIN must be exactly 4 digits.';
      pinError.hidden = false;
      pinInput.markInvalid();
      return;
    }
    const run = async () => {
      try {
        const result = await api.post('/api/host/pin', random ? {} : { pin: pinInput.value });
        toggleEditor(false);
        if (!result.changed) toast('That is already the PIN.');
        else toast(result.disconnected ? `PIN changed to ${result.pin}. The connected instance was disconnected until it enters it.` : `PIN changed to ${result.pin}.`);
      } catch (error) {
        pinError.textContent = error.message;
        pinError.hidden = false;
      }
    };
    if (button) await withBusy(button, run);
    else await run();
  }

  const stopButton = h('button', {
    type: 'button',
    class: 'btn danger',
    text: 'Stop hosting',
    onclick: async (event) => {
      const button = event.currentTarget;
      const ok = await confirmDialog({
        title: 'Stop hosting?',
        message: 'The connected instance, if any, will be disconnected and told that hosting stopped. No files are deleted.',
        confirmLabel: 'Stop hosting',
        danger: true,
      });
      if (!ok) return;
      await withBusy(button, async () => {
        try {
          await api.del('/api/host');
          toast('Hosting stopped.');
        } catch (error) {
          toast(error.message, { kind: 'error' });
        }
      });
    },
  });

  const el = h(
    'section',
    { class: 'panel' },
    h('div', { class: 'session-head' }, h('span', { class: 'eyebrow' }, icon('host'), 'Hosting'), title, path),
    warning,
    h(
      'div',
      { class: 'session-grid' },
      h('div', { class: 'tile' }, h('span', { class: 'tile-label', text: 'PIN' }), pinValue, changeButton, editor),
      h('div', { class: 'tile' }, h('span', { class: 'tile-label', text: 'Connection' }), h('div', { class: 'connection-line' }, connectionDot, connectionText), connectionDetail, progress),
    ),
    stats,
    h('h2', { class: 'section-label', text: 'Activity' }),
    activity.el,
    h(
      'footer',
      { class: 'actions-row' },
      stopButton,
      h('button', { type: 'button', class: 'btn', text: 'Sync a directory instead', onclick: () => navigate('#/sync') }),
    ),
  );

  return {
    el,
    update(state) {
      const hosting = state.hosting;
      if (!hosting?.active) return;
      title.textContent = hosting.name;
      path.textContent = hosting.path;
      pinValue.textContent = hosting.pin;

      const session = hosting.session;
      progress.hidden = true;
      if (!session) {
        connectionDot.className = 'dot busy';
        connectionText.textContent = 'Waiting for an instance to connect';
        connectionDetail.textContent = `Other instances see this directory as “${hosting.name}”. They need the PIN to connect.`;
      } else {
        const who = `${session.peer.hostname} (${session.peer.address})`;
        if (!session.streaming) {
          connectionDot.className = 'dot warn';
          connectionText.textContent = `Connection with ${who} interrupted`;
          connectionDetail.textContent = 'Waiting for it to come back…';
        } else if (session.phase === 'live') {
          connectionDot.className = 'dot ok';
          connectionText.textContent = `Connected: ${who}`;
          connectionDetail.textContent = `In sync, changes flow both ways as they happen. Connected ${timeAgo(session.since)}.`;
        } else {
          connectionDot.className = 'dot busy';
          connectionText.textContent = `Connected: ${who}`;
          const done = session.progress?.done ?? 0;
          const total = session.progress?.total ?? 0;
          connectionDetail.textContent = total > 0 ? `Initial synchronisation: ${done} of ${total} steps.` : 'Comparing both copies…';
          progress.hidden = false;
          progress.classList.toggle('indeterminate', total === 0);
          progress.firstChild.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '';
        }
      }

      const s = hosting.stats;
      replace(
        stats,
        h('span', null, h('strong', { text: plural(s.files, 'file') }), ' shared'),
        h('span', null, h('strong', { text: plural(s.dirs, 'folder') })),
        h('span', null, h('strong', { text: formatBytes(s.bytes) })),
        s.excluded > 0 ? h('span', null, h('strong', { text: plural(s.excluded, 'unchecked item') }), ' never leave this computer') : null,
      );
      replace(warning, hosting.error ? noticeBox({ kind: 'warning', message: hosting.error }) : null);
      warning.hidden = !hosting.error;
      activity.update(hosting.activity);
    },
  };
}

// --- Syncing -----------------------------------------------------------------

const SYNC_STATES = {
  connecting: { dot: 'busy', label: 'Connecting…' },
  syncing: { dot: 'busy', label: 'Synchronising both copies…' },
  live: { dot: 'ok', label: 'Live: both copies are identical' },
  reconnecting: { dot: 'warn', label: 'Reconnecting…' },
  pin_required: { dot: 'warn', label: 'Paused: waiting for the new PIN' },
  stopped: { dot: 'bad', label: 'Disconnected' },
  error: { dot: 'bad', label: 'Stopped because of an error' },
};

function syncingPanel({ navigate }) {
  const title = h('h1');
  const source = h('p', { class: 'muted' });
  const path = h('code');
  const connectionDot = h('span', { class: 'dot' });
  const connectionText = h('span');
  const connectionDetail = h('p', { class: 'connection-detail' });
  const progress = h('div', { class: 'progress', hidden: true }, h('span'));
  const notice = h('div');
  const warnings = h('div', { class: 'stack' });
  const activity = createActivityList();

  // The PIN prompt appears when the host changes its PIN.
  const pinError = h('p', { class: 'check error', hidden: true });
  const pinInput = createPinInput({ label: 'New PIN', onEnter: () => resume() });
  const resumeButton = h('button', { type: 'button', class: 'btn primary', text: 'Resume', onclick: () => resume() });
  const pinPrompt = h(
    'div',
    { class: 'tile', hidden: true },
    h('span', { class: 'tile-label', text: 'New PIN' }),
    h('p', { class: 'hint', text: 'Ask the host for the new PIN. Syncing resumes as soon as it is accepted.' }),
    h('div', { class: 'input-row' }, pinInput.el, resumeButton),
    pinError,
  );

  async function resume() {
    if (!pinInput.valid) {
      pinError.textContent = 'The PIN must be exactly 4 digits.';
      pinError.hidden = false;
      pinInput.markInvalid();
      return;
    }
    await withBusy(resumeButton, async () => {
      try {
        await api.post('/api/sync/pin', { pin: pinInput.value });
        pinError.hidden = true;
        pinInput.value = '';
        toast('PIN accepted. Syncing resumes.');
      } catch (error) {
        pinError.textContent = error.code === 'pin_invalid' ? 'Wrong PIN. Try again.' : error.message;
        pinError.hidden = false;
        pinInput.markInvalid();
      }
    });
  }

  const stopButton = h('button', { type: 'button', class: 'btn danger' });
  stopButton.addEventListener('click', async () => {
    const ended = stopButton.dataset.ended === 'true';
    if (!ended) {
      const ok = await confirmDialog({
        title: 'Stop syncing?',
        message: 'Changes will no longer be exchanged with the host. The files already here stay where they are.',
        confirmLabel: 'Stop syncing',
        danger: true,
      });
      if (!ok) return;
    }
    await withBusy(stopButton, async () => {
      try {
        await api.del('/api/sync');
      } catch (error) {
        toast(error.message, { kind: 'error' });
      }
    });
  });

  const el = h(
    'section',
    { class: 'panel' },
    h('div', { class: 'session-head' }, h('span', { class: 'eyebrow' }, icon('sync'), 'Syncing'), title, source, path),
    h('div', { class: 'stack' }, h('div', { class: 'tile' }, h('span', { class: 'tile-label', text: 'Connection' }), h('div', { class: 'connection-line' }, connectionDot, connectionText), connectionDetail, progress), notice, pinPrompt, warnings),
    h('h2', { class: 'section-label', text: 'Activity' }),
    activity.el,
    h('footer', { class: 'actions-row' }, stopButton, h('button', { type: 'button', class: 'btn', text: 'Host a directory instead', onclick: () => navigate('#/host') })),
  );

  let lastState = null;

  return {
    el,
    update(state) {
      const syncing = state.syncing;
      if (!syncing) return;
      title.textContent = syncing.share?.name || 'Synced directory';
      source.textContent = `From ${syncing.host?.hostname || 'the host'} · ${syncing.address}:${syncing.port} · ${protocolLabel(syncing.protocol)}`;
      path.textContent = syncing.localPath;

      const look = SYNC_STATES[syncing.state] || SYNC_STATES.connecting;
      connectionDot.className = `dot ${look.dot}`;
      connectionText.textContent = look.label;

      let detail = '';
      progress.hidden = true;
      if (syncing.state === 'syncing') {
        const p = syncing.progress;
        if (p && p.total > 0) {
          detail = `${p.done} of ${p.total} steps · ${formatBytes(p.bytesDone)} of ${formatBytes(p.bytesTotal)}${p.current ? ` · ${p.current}` : ''}`;
          progress.hidden = false;
          progress.classList.remove('indeterminate');
          progress.firstChild.style.width = `${Math.round((p.done / p.total) * 100)}%`;
        } else {
          detail = 'Comparing the local directory with the host’s…';
          progress.hidden = false;
          progress.classList.add('indeterminate');
          progress.firstChild.style.width = '';
        }
      } else if (syncing.state === 'live') {
        detail = syncing.lastSyncedAt ? `Last change exchanged ${timeAgo(syncing.lastSyncedAt)}.` : 'Watching both directories for changes.';
      } else if (syncing.state === 'reconnecting' && syncing.reconnect?.at) {
        const seconds = Math.max(0, Math.round((syncing.reconnect.at - Date.now()) / 1000));
        detail = `Attempt ${syncing.reconnect.attempt}${seconds > 0 ? `, next in ${seconds} s` : ''}.`;
      }
      connectionDetail.textContent = detail;
      const noticeEl = syncing.state === 'live' || syncing.state === 'syncing' ? null : noticeBox(syncing.notice);
      replace(notice, noticeEl);
      notice.hidden = !noticeEl;

      if (syncing.state === 'pin_required' && lastState !== 'pin_required') {
        pinPrompt.hidden = false;
        pinError.hidden = true;
        pinInput.value = '';
        setTimeout(() => pinInput.focus(), 0);
      } else if (syncing.state !== 'pin_required') {
        pinPrompt.hidden = true;
      }

      const ended = syncing.state === 'stopped' || syncing.state === 'error';
      stopButton.dataset.ended = String(ended);
      stopButton.textContent = ended ? 'Back to start' : 'Stop syncing';
      stopButton.className = ended ? 'btn primary' : 'btn danger';

      const blocks = [];
      if (syncing.rejected?.length) {
        blocks.push(
          h(
            'div',
            { class: 'notice warning' },
            icon('alert'),
            h('div', null, h('strong', { text: `${plural(syncing.rejected.length, 'item')} not synced` }), h('p', { class: 'hint', text: 'The host does not share these paths, so they stay only on this computer:' }), h('ul', { class: 'warning-list' }, syncing.rejected.slice(0, 20).map((item) => h('li', { text: item })))),
          ),
        );
      }
      if (syncing.conflicts?.length) {
        blocks.push(
          h(
            'div',
            { class: 'notice warning' },
            icon('alert'),
            h('div', null, h('strong', { text: `${plural(syncing.conflicts.length, 'conflict')} left alone` }), h('p', { class: 'hint', text: 'A file on one side and a directory on the other have the same name. Rename one of them to sync it:' }), h('ul', { class: 'warning-list' }, syncing.conflicts.slice(0, 20).map((item) => h('li', { text: item })))),
          ),
        );
      }
      replace(warnings, blocks);
      warnings.hidden = blocks.length === 0;
      activity.update(syncing.activity);
      lastState = syncing.state;
    },
  };
}

// --- View --------------------------------------------------------------------

export function homeView({ store, navigate }) {
  const main = h('div', { class: 'stack' });
  // One click on an instance that hosts something opens the sync screen with it selected.
  const instances = createInstanceList({
    selectable: true,
    showReasons: false,
    onSelect: (instance) => navigate(`#/sync?uuid=${encodeURIComponent(instance.uuid)}`),
  });
  const scanNow = h('button', {
    type: 'button',
    class: 'btn ghost small',
    title: 'Scan the network now',
    onclick: async () => {
      try {
        await api.post('/api/discovery/scan', {});
      } catch (error) {
        toast(error.message, { kind: 'error' });
      }
    },
  }, icon('refresh'), 'Scan now');
  const aside = h('aside', { class: 'panel' }, h('div', { class: 'panel-title' }, h('h2', { text: 'On this network' }), scanNow), instances.el);
  const el = h('div', { class: 'page home' }, main, aside);

  let mode = null;
  let panel = null;
  const unsubscribe = store.subscribe((state) => {
    if (state.mode !== mode) {
      mode = state.mode;
      panel = mode === 'hosting' ? hostingPanel({ navigate }) : mode === 'syncing' ? syncingPanel({ navigate }) : idlePanel();
      replace(main, panel.el);
    }
    panel.update(state);
    const peers = [state.syncing?.host?.uuid, state.hosting?.session?.peer?.uuid].filter(Boolean);
    instances.update(state.discovery, peers);
    scanNow.hidden = !state.discovery.enabled;
  });
  // Relative times ("12 s ago") age even when nothing else changes.
  const ticker = setInterval(() => {
    const state = store.get();
    if (state && panel) panel.update(state);
  }, 5000);

  return {
    el,
    destroy() {
      unsubscribe();
      clearInterval(ticker);
    },
  };
}
