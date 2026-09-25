/**
 * Network helpers: local addresses, subnets and address parsing.
 *
 * Everything here is pure or reads `os.networkInterfaces()`; nothing opens a
 * socket. Discovery (`src/domain/discovery.js`) builds its scan targets from
 * these functions, and the status bar shows `primaryAddress()`.
 */
import { createHash } from 'node:crypto';
import { hostname as osHostname, networkInterfaces } from 'node:os';

/**
 * Interface names that belong to containers, VMs and VPN tunnels rather than
 * to the physical local network.
 *
 * Why skip them: Docker alone creates several /16 bridges on a typical
 * development machine. Scanning those is slow (every address has to time out)
 * and can never find another computer on the LAN, which is what discovery is
 * for. An instance on the same machine is still found through the LAN address
 * and through loopback.
 */
export const VIRTUAL_INTERFACE =
  /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxd|cni|flannel|cali|weave|tun|tap|utun|zt|tailscale|wg|kube|podman|dummy|ham|nordlynx)/i;

/**
 * IPv4 dotted quad to an unsigned 32-bit integer.
 * @param {string} ip
 * @returns {number|null} null when the input is not a valid IPv4 address.
 */
export function ipv4ToInt(ip) {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/**
 * Unsigned 32-bit integer to an IPv4 dotted quad.
 * @param {number} value
 */
export function intToIpv4(value) {
  const n = value >>> 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** True for a syntactically valid IPv4 address. */
export function isIpv4(value) {
  return ipv4ToInt(value) !== null;
}

/**
 * Prefix length of a dotted netmask, e.g. "255.255.255.0" -> 24.
 * @param {string} netmask
 */
export function prefixFromNetmask(netmask) {
  const value = ipv4ToInt(netmask);
  if (value === null) return 32;
  let bits = 0;
  for (let bit = 31; bit >= 0; bit -= 1) {
    if (value & (1 << bit)) bits += 1;
    else break;
  }
  return bits;
}

/** Network mask for a prefix length, as an unsigned integer. */
function maskFor(prefix) {
  if (prefix <= 0) return 0;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

/**
 * Every usable host address of the subnet an address belongs to.
 *
 * Subnets wider than /24 are narrowed to the /24 around the address: scanning a
 * whole /16 means 65 534 hosts times every port, which would take many minutes
 * for a sweep that is supposed to repeat every few seconds. Home and office
 * LANs are almost always a /24.
 *
 * @param {string} address An IPv4 address inside the subnet.
 * @param {number} prefix Prefix length of the subnet.
 * @param {{ minPrefix?: number }} [options]
 * @returns {string[]}
 */
export function subnetHosts(address, prefix, options = {}) {
  const minPrefix = options.minPrefix ?? 24;
  const value = ipv4ToInt(address);
  if (value === null) return [];
  const effective = Math.max(Math.min(prefix, 32), minPrefix);
  if (effective >= 31) return [intToIpv4(value)];

  const mask = maskFor(effective);
  const network = (value & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const hosts = [];
  for (let host = network + 1; host < broadcast; host += 1) hosts.push(intToIpv4(host));
  return hosts;
}

/**
 * Private (RFC 1918) or link-local IPv4 address.
 * @param {string} ip
 */
export function isPrivateIpv4(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  const first = value >>> 24;
  const second = (value >>> 16) & 255;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

/**
 * Strip the IPv4-mapped IPv6 prefix Node reports for dual-stack sockets.
 * @param {string} address
 */
export function normalizeAddress(address) {
  const value = String(address || '');
  return value.startsWith('::ffff:') && isIpv4(value.slice(7)) ? value.slice(7) : value;
}

/** True for 127.0.0.0/8 and ::1, in any of Node's spellings. */
export function isLoopbackAddress(address) {
  const value = normalizeAddress(address);
  if (value === '::1') return true;
  const int = ipv4ToInt(value);
  return int !== null && int >>> 24 === 127;
}

/**
 * IPv4 interfaces of this machine.
 * @param {() => object} [source] Injectable for tests; defaults to `os.networkInterfaces`.
 * @returns {{ name: string, address: string, netmask: string, prefix: number, internal: boolean, virtual: boolean, mac: string }[]}
 */
export function listIpv4Interfaces(source = networkInterfaces) {
  const out = [];
  let table;
  try {
    table = source() || {};
  } catch {
    return out;
  }
  for (const [name, addresses] of Object.entries(table)) {
    for (const entry of addresses || []) {
      if (!entry) continue;
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      out.push({
        name,
        address: entry.address,
        netmask: entry.netmask,
        prefix: entry.cidr ? Number(entry.cidr.split('/')[1]) : prefixFromNetmask(entry.netmask),
        internal: Boolean(entry.internal),
        virtual: Boolean(entry.internal) || VIRTUAL_INTERFACE.test(name),
        mac: entry.mac || '',
      });
    }
  }
  return out;
}

/**
 * Interfaces that face the local network: not loopback, not virtual.
 * Private addresses come first, since they are what a LAN peer can reach.
 * @param {() => object} [source]
 */
export function lanInterfaces(source) {
  const all = listIpv4Interfaces(source).filter((entry) => !entry.virtual);
  return all.sort((a, b) => Number(isPrivateIpv4(b.address)) - Number(isPrivateIpv4(a.address)));
}

/** LAN IPv4 addresses of this machine, best first. */
export function lanAddresses(source) {
  return lanInterfaces(source).map((entry) => entry.address);
}

/** The address shown in the status bar: the best LAN address, or loopback. */
export function primaryAddress(source) {
  return lanAddresses(source)[0] || '127.0.0.1';
}

/**
 * Every address that belongs to this machine, IPv4 and IPv6, loopback
 * included. Used to recognise requests coming from the local user.
 * @param {() => object} [source]
 * @returns {Set<string>}
 */
export function localAddresses(source = networkInterfaces) {
  const out = new Set(['127.0.0.1', '::1']);
  try {
    for (const addresses of Object.values(source() || {})) {
      for (const entry of addresses || []) {
        if (entry?.address) out.add(normalizeAddress(entry.address));
      }
    }
  } catch {
    /* best effort */
  }
  return out;
}

/**
 * Hosts to scan for other instances.
 *
 * The /24 of every LAN interface, plus loopback. Loopback is cheap (one host)
 * and finds instances on this same machine even when it has no network at all.
 * @param {() => object} [source]
 * @returns {string[]}
 */
export function defaultScanHosts(source) {
  const hosts = new Set(['127.0.0.1']);
  for (const entry of lanInterfaces(source)) {
    for (const host of subnetHosts(entry.address, entry.prefix)) hosts.add(host);
  }
  return [...hosts];
}

/**
 * Expand a comma separated host specification.
 *
 * Accepts single addresses ("192.168.1.20") and CIDR blocks ("192.168.1.0/24").
 * Blocks wider than /24 are narrowed to their first /24 by `subnetHosts`.
 * @param {string} spec
 * @returns {string[]}
 */
export function parseHostSpec(spec) {
  const hosts = new Set();
  for (const raw of String(spec || '').split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const [address, bits] = item.split('/');
    if (!isIpv4(address)) continue;
    if (bits === undefined) {
      hosts.add(address);
      continue;
    }
    const prefix = Number.parseInt(bits, 10);
    if (!Number.isFinite(prefix)) continue;
    for (const host of subnetHosts(address, prefix)) hosts.add(host);
  }
  return [...hosts];
}

/**
 * Expand a comma separated port specification, e.g. "55667-55686,8080".
 * @param {string} spec
 * @returns {number[]}
 */
export function parsePortSpec(spec) {
  const ports = new Set();
  for (const raw of String(spec || '').split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const match = /^(\d+)(?:-(\d+))?$/.exec(item);
    if (!match) continue;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    for (let port = Math.min(start, end); port <= Math.max(start, end); port += 1) {
      if (port >= 1 && port <= 65535) ports.add(port);
    }
  }
  return [...ports];
}

/**
 * Describe a port list compactly: [1, 2, 3, 7] -> "1-3, 7".
 * @param {number[]} ports
 */
export function formatPortRanges(ports) {
  const sorted = [...new Set(ports)].sort((a, b) => a - b);
  const ranges = [];
  for (const port of sorted) {
    const last = ranges.at(-1);
    if (last && port === last[1] + 1) last[1] = port;
    else ranges.push([port, port]);
  }
  return ranges.map(([start, end]) => (start === end ? String(start) : `${start}-${end}`)).join(', ');
}

/**
 * A stable fingerprint of this machine: host name plus MAC addresses.
 *
 * Two instances on the same computer compute the same value, which is how the
 * host recognises (and refuses) an attempt to sync a directory into itself.
 * It is not a secret and not an identity for anything else.
 * @param {() => object} [source]
 */
export function machineFingerprint(source = networkInterfaces) {
  const macs = new Set();
  try {
    for (const addresses of Object.values(source() || {})) {
      for (const entry of addresses || []) {
        if (entry?.mac && entry.mac !== '00:00:00:00:00:00') macs.add(entry.mac);
      }
    }
  } catch {
    /* best effort */
  }
  return createHash('sha256')
    .update(`${osHostname()}|${[...macs].sort().join(',')}`)
    .digest('hex')
    .slice(0, 32);
}
