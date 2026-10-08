/**
 * Content hashing.
 *
 * Hashes are only computed when size and mtime cannot decide: two files of the
 * same size whose mtimes differ, typically because one side received its copy
 * by some other means (a USB stick, a zip archive) before the first sync.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * SHA-256 of a file, hex encoded.
 * @param {string} absolute
 * @returns {Promise<string>}
 */
export function hashFile(absolute) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolute);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', () => resolve(hash.digest('hex')));
    stream.once('error', reject);
  });
}
