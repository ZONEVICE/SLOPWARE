/**
 * Discovery: a continuous background scan of the local network for other
 * Reptile instances.
 *
 * Two independent loops run while scanning is enabled:
 *
 *  - the SWEEP walks every scan target. It works in two phases so that a /24
 *    with a single computer on it does not cost 254 x 20 connection attempts:
 *    first the default port on every host, then the remaining ports only on
 *    hosts that answered at all (a closed port answers too), on this machine's
 *    own addresses, and on hosts seen recently.
 *  - the REFRESH re-pings every known instance every few seconds, so that a
 *    peer starting or stopping hosting shows up quickly, and forgets instances
 *    that stopped answering.
 *
 * The probe itself (TCP check, then GET /api/ping over both protocols) is
 * injected by the composition root, keeping this service free of transport
 * code and easy to test.
 */
import { EVENTS } from '../lib/events.js';
import { defaultScanHosts, formatPortRanges, isLoopbackAddress, localAddresses } from '../lib/net.js';
import { runPool, sleep } from '../lib/queue.js';

/**
 * @param {object} deps
 * @param {object} deps.config Full configuration; uses `config.discovery`.
 * @param {object} deps.identity
 * @param {import('../lib/events.js').EventBus} deps.bus
 * @param {(options: object) => Promise<{ status: string, info?: object, reachable: boolean }>} deps.probe
 * @param {object} [deps.logger]
 */
export function createDiscovery({ config, identity, bus, probe, logger }) {
  const settings = config.discovery;
  /** @type {Map<string, object>} uuid -> instance record */
  const instances = new Map();
  /** @type {Map<string, number>} host -> last time anything answered there */
  const aliveHosts = new Map();

  let enabled = false;
  let scanning = false;
  let controller = null;
  let wake = null;
  let loops = [];
  let lastSweepAt = null;
  let lastSweepMs = null;
  let sweeps = 0;
  let lastHostCount = 0;

  const announce = () => {
    bus.emit(EVENTS.DISCOVERY_UPDATED, { instances: list() });
    bus.emit(EVENTS.STATE_CHANGED, { section: 'discovery' });
  };

  function targets() {
    const hosts = settings.hosts && settings.hosts.length ? settings.hosts : defaultScanHosts(settings.interfaces);
    return { hosts, ports: settings.ports };
  }

  /** Public record for the interface and the ping comparison. */
  function toRecord(info, existing) {
    const now = Date.now();
    // An instance on this machine answers on loopback and on the LAN address;
    // keep the LAN address, which is the one the user recognises.
    let address = info.address;
    if (existing && existing.address !== address && isLoopbackAddress(address) && !isLoopbackAddress(existing.address)) {
      address = existing.address;
    }
    return {
      uuid: info.uuid,
      hostname: String(info.hostname || 'unknown'),
      address,
      port: Number(info.port) || 0,
      protocol: info.protocol,
      version: info.version || null,
      mode: info.mode || (info.hosting ? 'hosting' : 'idle'),
      hosting: info.hosting
        ? { id: info.hosting.id || null, name: String(info.hosting.name || ''), connected: Boolean(info.hosting.connected) }
        : null,
      compatible: info.protocol === identity.protocol,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
    };
  }

  /** Everything the interface shows, minus timestamps. */
  function signature(record) {
    return JSON.stringify([record.hostname, record.address, record.port, record.protocol, record.mode, record.hosting]);
  }

  function upsert(info) {
    if (!info || info.uuid === identity.uuid) return; // never list ourselves
    const existing = instances.get(info.uuid);
    const record = toRecord(info, existing);
    instances.set(record.uuid, record);
    if (!existing || signature(existing) !== signature(record)) announce();
  }

  function prune() {
    const now = Date.now();
    let changed = false;
    for (const [uuid, record] of instances) {
      if (now - record.lastSeen > settings.staleMs) {
        instances.delete(uuid);
        changed = true;
      }
    }
    if (changed) announce();
  }

  const probeOptions = (host, port, signal, extra = {}) => ({
    host,
    port,
    preferProtocol: identity.protocol,
    connectTimeoutMs: settings.connectTimeoutMs,
    requestTimeoutMs: settings.requestTimeoutMs,
    signal,
    ...extra,
  });

  async function probeOne(host, port, signal) {
    if (signal.aborted) return;
    try {
      const result = await probe(probeOptions(host, port, signal));
      if (result.reachable) aliveHosts.set(host, Date.now());
      if (result.status === 'found') upsert(result.info);
    } catch (error) {
      logger?.debug?.(`probe ${host}:${port} failed:`, error.message);
    }
  }

  async function sweep(signal) {
    const started = Date.now();
    const { hosts, ports } = targets();
    lastHostCount = hosts.length;
    if (ports.length === 0 || hosts.length === 0) return;
    scanning = true;
    announce();

    const own = localAddresses(settings.interfaces);
    const answered = new Set();
    const [first, ...rest] = ports;

    await runPool(
      hosts,
      settings.concurrency,
      async (host) => {
        const before = aliveHosts.get(host) || 0;
        await probeOne(host, first, signal);
        if ((aliveHosts.get(host) || 0) > before) answered.add(host);
      },
      { signal },
    );

    const recent = Date.now() - settings.aliveMemoryMs;
    const secondPhase = hosts.filter(
      (host) => answered.has(host) || own.has(host) || isLoopbackAddress(host) || (aliveHosts.get(host) || 0) > recent,
    );
    const pairs = secondPhase.flatMap((host) => rest.map((port) => ({ host, port })));
    await runPool(pairs, settings.concurrency, ({ host, port }) => probeOne(host, port, signal), { signal });

    if (!signal.aborted) {
      sweeps += 1;
      lastSweepAt = Date.now();
      lastSweepMs = lastSweepAt - started;
    }
    scanning = false;
    announce();
  }

  async function refresh(signal) {
    const known = [...instances.values()];
    await runPool(
      known,
      8,
      async (record) => {
        if (signal.aborted) return;
        try {
          const result = await probe(
            probeOptions(record.address, record.port, signal, { skipTcpCheck: true, preferProtocol: record.protocol }),
          );
          if (result.status === 'found') upsert(result.info);
        } catch {
          /* it will go stale and be pruned */
        }
      },
      { signal },
    );
    if (!signal.aborted) prune();
  }

  async function sweepLoop(signal) {
    while (!signal.aborted) {
      await sweep(signal);
      if (signal.aborted) break;
      wake = new AbortController();
      const both = AbortSignal.any([signal, wake.signal]);
      await sleep(settings.sweepIntervalMs, both);
      wake = null;
    }
  }

  async function refreshLoop(signal) {
    while (!signal.aborted) {
      await sleep(settings.refreshIntervalMs, signal);
      if (signal.aborted) break;
      await refresh(signal);
    }
  }

  function begin() {
    controller = new AbortController();
    const { signal } = controller;
    loops = [
      sweepLoop(signal).catch((error) => logger?.error?.('discovery sweep loop failed:', error)),
      refreshLoop(signal).catch((error) => logger?.error?.('discovery refresh loop failed:', error)),
    ];
  }

  async function halt() {
    controller?.abort();
    controller = null;
    await Promise.all(loops);
    loops = [];
    scanning = false;
  }

  /** Discovered instances, never including this one. */
  function list() {
    return [...instances.values()].sort(
      (a, b) => a.hostname.localeCompare(b.hostname) || a.address.localeCompare(b.address) || a.port - b.port,
    );
  }

  return {
    /** Start scanning if the configuration enables it at startup. */
    start() {
      if (settings.enabled) this.setEnabled(true);
    },

    /** Turn the background scan on or off (the status bar button). */
    setEnabled(value) {
      const next = Boolean(value);
      if (next === enabled) return this.status();
      enabled = next;
      if (enabled) begin();
      else halt();
      announce();
      return this.status();
    },

    /** Start the next sweep now instead of waiting for the interval. */
    scanNow() {
      if (enabled) wake?.abort();
      return this.status();
    },

    list,

    /** Look up a discovered instance by UUID. */
    get(uuid) {
      return instances.get(uuid) || null;
    },

    /**
     * Probe one address on request (manual connection). Does not add the
     * result to the discovered list.
     * @param {string} host
     * @param {number} port
     */
    async check(host, port) {
      const result = await probe({
        host,
        port,
        preferProtocol: identity.protocol,
        connectTimeoutMs: Math.max(settings.connectTimeoutMs, 1500),
        requestTimeoutMs: Math.max(settings.requestTimeoutMs, 3000),
      });
      return result;
    },

    status() {
      const { ports } = settings;
      return {
        enabled,
        scanning,
        sweeps,
        lastSweepAt,
        lastSweepMs,
        hosts: lastHostCount,
        ports: ports.length ? { ranges: formatPortRanges(ports), count: ports.length } : null,
        instances: list(),
      };
    },

    /** Stop every loop; used at shutdown. */
    async stop() {
      enabled = false;
      await halt();
    },
  };
}
