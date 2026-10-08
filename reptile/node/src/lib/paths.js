/**
 * Well-known locations inside the application directory.
 *
 * Everything is resolved from this file's own location rather than from the
 * current working directory, so `npm start` behaves the same whether it is run
 * from the project directory or from anywhere else.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The `reptile/node/` directory: this implementation's own files. */
export const ROOT = join(here, '..', '..');

/**
 * The `reptile/` directory. `version.txt` lives there because the Node.js and
 * the Rust implementations are one product with one version.
 */
export const PRODUCT_ROOT = join(ROOT, '..');

/** The browser client, served as-is. */
export const PUBLIC_DIR = join(ROOT, 'public');

/** Where `--https` writes the certificate it generates on every start. */
export const CERT_DIR = join(ROOT, 'cert');

/** Application version, read once from `reptile/version.txt`. */
export const VERSION = (() => {
  try {
    return readFileSync(join(PRODUCT_ROOT, 'version.txt'), 'utf8').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
