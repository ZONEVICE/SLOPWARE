/**
 * Filesystem locations.
 *
 * `ROOT` is the package directory (the folder holding package.json), resolved
 * from this module's own URL so that the server behaves identically no matter
 * which working directory it was started from.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // <root>/src/lib

/** Package root: the directory that contains package.json. */
export const ROOT = resolve(here, '..', '..');

/** Static client assets served to the browser. */
export const PUBLIC_DIR = resolve(ROOT, 'public');

/** Uploaded attachments. Survives restarts on purpose. */
export const UPLOADS_DIR = resolve(ROOT, 'uploads');

/** Self-signed TLS material, regenerated on every `--https` start. */
export const CERT_DIR = resolve(ROOT, 'cert');
