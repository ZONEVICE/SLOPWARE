/**
 * The always-visible status bar: host name, session UUID, LAN address, port,
 * protocol, and the switch for the background network scan.
 */
import { api } from '../core/api.js';
import { h, icon, replace } from '../core/dom.js';
import { protocolLabel } from '../core/format.js';
import { toast } from './toast.js';

/**
 * @param {HTMLElement} root The <header> to render into.
 * @param {ReturnType<import('../core/store.js').createStore>} store
 */
export function mountStatusBar(root, store) {
  const value = (text, extra = '') => h('dd', { class: extra, text });
  const hostname = value('…');
  const uuid = value('…', 'mono');
  const address = value('…', 'mono');
  const port = value('…', 'mono');
  const protocol = h('span', { class: 'protocol-badge', text: '…' });

  const scanLabel = h('span', { text: 'Scanning' });
  const scanDot = h('span', { class: 'dot' });
  const scanButton = h(
    'button',
    {
      type: 'button',
      class: 'scan-toggle',
      'aria-pressed': 'false',
      title: 'Automatic search for other Reptile instances on the local network',
      onclick: async () => {
        const enabled = scanButton.getAttribute('aria-pressed') !== 'true';
        scanButton.disabled = true;
        try {
          await api.post('/api/discovery', { enabled });
        } catch (error) {
          toast(error.message, { kind: 'error' });
        } finally {
          scanButton.disabled = false;
        }
      },
    },
    icon('radar'),
    scanLabel,
    scanDot,
  );

  // Mode and connection, visible from every screen. Clicking it goes home,
  // where the full hosting or syncing panel lives.
  const connectionDot = h('span', { class: 'dot' });
  const connectionText = h('span');
  const connection = h('a', { class: 'connection-chip', href: '#/', hidden: true, 'aria-live': 'polite' }, connectionDot, connectionText);

  const item = (label, dd, title) => h('div', { class: 'status-item', title }, h('dt', { text: label }), dd);

  replace(
    root,
    h('a', { class: 'brand', href: '#/' }, h('img', { src: '/icons/favicon.svg', alt: '' }), 'Reptile'),
    h(
      'dl',
      { class: 'status-items' },
      item('Host', hostname, 'Host name of this computer'),
      item('IP', address, 'Address of this computer on the local network'),
      item('Port', port, 'Port this instance listens on'),
      h('div', { class: 'status-item', title: 'Protocol used by this instance' }, h('dt', { class: 'visually-hidden', text: 'Protocol' }), h('dd', null, protocol)),
      item('Session', uuid, 'Unique ID of this Reptile session (a new one on every start)'),
    ),
    h('div', { class: 'status-actions' }, connection, scanButton),
  );

  const offline = document.getElementById('offline');
  store.onLink((online) => {
    if (offline) offline.hidden = online || store.get() === null;
  });

  const SYNC_LOOK = {
    connecting: ['busy', 'connecting…'],
    syncing: ['busy', 'synchronising…'],
    live: ['ok', 'live'],
    reconnecting: ['warn', 'reconnecting…'],
    pin_required: ['warn', 'new PIN needed'],
    stopped: ['bad', 'disconnected'],
    error: ['bad', 'stopped (error)'],
  };

  /** [dot class, text] for the connection chip, or null when idle. */
  const describeConnection = (state) => {
    if (state.mode === 'hosting' && state.hosting?.active) {
      const session = state.hosting.session;
      if (!session) return ['busy', `Hosting “${state.hosting.name}” · waiting for a connection`];
      if (!session.streaming) return ['warn', `Hosting “${state.hosting.name}” · ${session.peer.hostname} interrupted`];
      return [session.phase === 'live' ? 'ok' : 'busy', `Hosting “${state.hosting.name}” · ${session.peer.hostname} connected`];
    }
    if (state.mode === 'syncing' && state.syncing) {
      const [dot, text] = SYNC_LOOK[state.syncing.state] || SYNC_LOOK.connecting;
      return [dot, `Syncing “${state.syncing.share?.name || ''}” · ${text}`];
    }
    return null;
  };

  store.subscribe((state) => {
    const { identity, discovery } = state;
    const look = describeConnection(state);
    connection.hidden = !look;
    if (look) {
      connectionDot.className = `dot ${look[0]}`;
      connectionText.textContent = look[1];
    }
    hostname.textContent = identity.hostname;
    uuid.textContent = identity.uuid;
    address.textContent = identity.address;
    address.parentElement.title = identity.addresses.length > 1 ? `All LAN addresses: ${identity.addresses.join(', ')}` : 'Address of this computer on the local network';
    port.textContent = String(identity.port);
    protocol.textContent = protocolLabel(identity.protocol);
    protocol.classList.toggle('https', identity.protocol === 'https');

    scanButton.setAttribute('aria-pressed', String(discovery.enabled));
    scanLabel.textContent = discovery.enabled ? 'Scanning' : 'Scan off';
    scanDot.className = `dot ${discovery.enabled ? (discovery.scanning ? 'busy' : 'ok') : ''}`;
    scanButton.title = discovery.enabled
      ? 'Automatic search is on. Click to stop scanning the network.'
      : 'Automatic search is off. Click to scan the network for other instances.';
  });
}
