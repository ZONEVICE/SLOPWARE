/**
 * Who this instance is.
 *
 * The UUID is generated once per process and never stored: a restarted
 * Reptile is a new instance, exactly as the specification asks ("no
 * persistence of any kind"). Addresses are read live, because a laptop can
 * change networks while Reptile runs.
 */
import { hostname as osHostname } from 'node:os';
import { newUuid } from '../lib/ids.js';
import { lanAddresses, machineFingerprint, primaryAddress } from '../lib/net.js';
import { VERSION } from '../lib/paths.js';

/**
 * @param {{ protocol: 'http'|'https', interfaces?: () => object }} options
 */
export function createIdentity({ protocol, interfaces }) {
  const identity = {
    app: 'reptile',
    version: VERSION,
    uuid: newUuid(),
    hostname: osHostname(),
    protocol,
    /** Filled in once the server is listening; the port walk decides it. */
    port: 0,
    /** Same value for every instance on this computer; see `machineFingerprint`. */
    machine: machineFingerprint(interfaces),
    /** SHA-256 fingerprint of our own certificate, when serving HTTPS. */
    certificateFingerprint: null,

    get address() {
      return primaryAddress(interfaces);
    },
    get addresses() {
      return lanAddresses(interfaces);
    },

    /** What the status bar shows. */
    toJSON() {
      return {
        app: identity.app,
        version: identity.version,
        uuid: identity.uuid,
        hostname: identity.hostname,
        protocol: identity.protocol,
        port: identity.port,
        address: identity.address,
        addresses: identity.addresses,
      };
    },
  };
  return identity;
}
