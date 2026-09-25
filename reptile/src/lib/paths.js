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

/** The `reptile/` directory. */
export const ROOT = join(here, '..', '..');

/** The browser client, served as-is. */
export const PUBLIC_DIR = join(ROOT, 'public');

/** Where `--https` writes the certificate it generates on every start. */
export const CERT_DIR = join(ROOT, 'cert');

/** Application version, read once from `version.txt`. */
export const VERSION = (() => {
  try {
    return readFileSync(join(ROOT, 'version.txt'), 'utf8').trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
