/**
 * Newline-delimited JSON, the framing of the host-to-peer event stream.
 *
 * One JSON document per line. It is trivially streamable over a plain chunked
 * HTTP response, needs no library, and a line can never be confused with the
 * next one because JSON.stringify never emits a raw newline.
 */

/** Serialise one message as a line. */
export function encodeLine(message) {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Build an incremental parser. Feed it chunks in any sizes; it calls
 * `onMessage` once per complete line.
 *
 * @param {(message: any) => void} onMessage
 * @param {{ maxLineBytes?: number, onError?: (error: Error) => void }} [options]
 * @returns {(chunk: Buffer|string) => void}
 */
export function createLineParser(onMessage, options = {}) {
  const maxLineBytes = options.maxLineBytes ?? 64 * 1024 * 1024;
  let buffer = '';

  return (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          options.onError?.(error);
          message = undefined;
        }
        if (message !== undefined) onMessage(message);
      }
      newline = buffer.indexOf('\n');
    }
    if (buffer.length > maxLineBytes) {
      buffer = '';
      options.onError?.(new Error('stream line exceeds the maximum size'));
    }
  };
}
