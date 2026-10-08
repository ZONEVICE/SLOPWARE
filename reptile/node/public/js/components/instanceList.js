/**
 * The list of Reptile instances discovered on the network.
 *
 * Two uses:
 *  - on the start screen, as an overview ("what is out there");
 *  - on the sync screen, as a picker: an instance that hosts a directory, uses
 *    the same protocol and is not busy can be chosen with one click. The others
 *    are shown but disabled, with the reason.
 */
import { h, icon, replace } from '../core/dom.js';
import { protocolLabel, timeAgo } from '../core/format.js';

/** Why an instance cannot be picked, or null when it can. */
export function unavailableReason(instance) {
  if (!instance.compatible) return `Incompatible: it uses ${protocolLabel(instance.protocol)}`;
  if (!instance.hosting) return instance.mode === 'syncing' ? 'Syncing, not hosting' : 'Not hosting a directory';
  if (instance.hosting.connected) return 'Busy: another instance is connected';
  return null;
}

function badges(instance, connected) {
  const out = [h('span', { class: `badge ${instance.compatible ? '' : 'danger'}`, text: protocolLabel(instance.protocol) })];
  if (!instance.compatible) out.push(h('span', { class: 'badge danger', text: 'Incompatible' }));
  if (connected) out.push(h('span', { class: 'badge accent', text: 'Connected to this instance' }));
  if (instance.hosting) {
    out.push(h('span', { class: 'badge accent', text: 'Hosting' }));
    if (instance.hosting.connected && !connected) out.push(h('span', { class: 'badge warning', text: 'Busy' }));
  } else if (instance.mode === 'syncing') {
    out.push(h('span', { class: 'badge info', text: 'Syncing' }));
  } else {
    out.push(h('span', { class: 'badge', text: 'Idle' }));
  }
  return out;
}

/**
 * @param {{ selectable?: boolean, showReasons?: boolean, onSelect?: (instance: object) => void }} [options]
 */
export function createInstanceList({ selectable = false, showReasons = true, onSelect } = {}) {
  const list = h('ul', { class: 'instances', 'aria-label': 'Instances on this network' });
  let selected = null;
  let lastKey = '';
  /** UUIDs this instance currently has a session with (either direction). */
  let connected = new Set();

  const render = (instances, discovery) => {
    if (instances.length === 0) {
      const message = discovery?.enabled
        ? discovery.sweeps === 0
          ? 'Searching the network for other Reptile instances…'
          : 'No other Reptile instance found on the network yet. Scanning continues in the background.'
        : 'Automatic scanning is off. Turn it on in the status bar, or enter an address manually.';
      replace(list, h('li', { class: 'empty', text: message }));
      return;
    }
    replace(
      list,
      instances.map((instance) => {
        const reason = unavailableReason(instance);
        const isConnected = connected.has(instance.uuid);
        const hostingLine = instance.hosting ? `Hosting “${instance.hosting.name}”` : null;
        const meta = [`${instance.address}:${instance.port}`, hostingLine, reason && showReasons ? reason : null].filter(Boolean).join(' · ');
        const content = [
          h('span', { class: 'instance-icon' }, icon(instance.hosting ? 'folder' : 'computer')),
          h('span', { class: 'instance-name', text: instance.hostname }),
          h('span', { class: 'instance-meta', text: meta, title: `Session ${instance.uuid} · seen ${timeAgo(instance.lastSeen)}` }),
          h('span', { class: 'instance-badges' }, badges(instance, isConnected)),
        ];
        const classes = `instance${instance.hosting ? ' hosting' : ''}${selected === instance.uuid ? ' selected' : ''}`;
        if (!selectable) return h('li', null, h('div', { class: classes }, content));
        const button = h(
          'button',
          {
            type: 'button',
            class: classes,
            disabled: Boolean(reason),
            'aria-pressed': String(selected === instance.uuid),
            title: reason || `Sync “${instance.hosting?.name}” from ${instance.hostname}`,
            onclick: () => {
              selected = instance.uuid;
              onSelect?.(instance);
              lastKey = '';
              render(instances, discovery);
            },
          },
          content,
        );
        return h('li', null, button);
      }),
    );
  };

  return {
    el: list,
    /**
     * @param {object} discovery `state.discovery` from the snapshot.
     * @param {string[]} [connectedUuids] Instances this one has a session with.
     */
    update(discovery, connectedUuids = []) {
      connected = new Set(connectedUuids);
      const instances = discovery?.instances || [];
      const key = JSON.stringify([selected, [...connected], discovery?.enabled, discovery?.sweeps === 0, instances.map((i) => [i.uuid, i.address, i.port, i.mode, i.hosting, i.compatible])]);
      if (key === lastKey) return;
      lastKey = key;
      render(instances, discovery);
    },
    /** Mark an instance as selected (or none). */
    select(uuid) {
      selected = uuid;
      lastKey = '';
    },
  };
}
