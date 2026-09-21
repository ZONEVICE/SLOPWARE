/**
 * Streaming `multipart/form-data` parser.
 *
 * WHY THIS EXISTS: `ws` is the only npm dependency allowed, so there is no
 * busboy/formidable available. Uploads must still stream straight to disk
 * rather than being buffered in memory, because a video attachment can be
 * hundreds of megabytes.
 *
 * Design: a boundary-scanning state machine fed by `write(chunk)`. File parts
 * are surfaced as readable streams; small non-file fields are buffered and
 * surfaced as strings.
 *
 * Backpressure: `write()` returns false when the consumer of the current part
 * is saturated. The caller pauses its source and resumes on the `drain` event.
 *
 * Usage:
 *   const parser = new MultipartParser(boundary);
 *   parser.on('part', ({ filename, mime, stream }) => stream.pipe(file));
 *   parser.on('field', ({ name, value }) => { ... });
 *   parser.on('finish', () => ...);
 *   parser.on('error', (err) => ...);
 *   req.on('data', (c) => { if (!parser.write(c)) req.pause(); });
 *   parser.on('drain', () => req.resume());
 *   req.on('end', () => parser.end());
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const CRLF_CRLF = Buffer.from('\r\n\r\n');
const STATE = { PREAMBLE: 0, AFTER_BOUNDARY: 1, HEADERS: 2, BODY: 3, EPILOGUE: 4 };

/**
 * Split a `Content-Type` header into its type and parameters.
 * @param {string} header
 * @returns {{ type: string, parameters: Record<string,string> }}
 */
export function parseContentType(header) {
  const raw = String(header || '');
  const [typePart, ...paramParts] = raw.split(';');
  /** @type {Record<string,string>} */
  const parameters = {};
  for (const part of paramParts) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    parameters[key] = value;
  }
  return { type: typePart.trim().toLowerCase(), parameters };
}

/**
 * Extract the boundary from a multipart Content-Type header.
 * @param {string} header
 * @returns {string|null}
 */
export function getBoundary(header) {
  const { type, parameters } = parseContentType(header);
  if (!type.startsWith('multipart/')) return null;
  return parameters.boundary || null;
}

/**
 * Parse a `Content-Disposition` header value.
 * Understands both `filename="x"` and RFC 5987 `filename*=UTF-8''x`.
 * @param {string} header
 * @returns {{ name: string|null, filename: string|null }}
 */
export function parseContentDisposition(header) {
  const raw = String(header || '');
  // The `(?:^|;)\s*` prefix is essential: without it, a lookup for `name`
  // would happily match the tail of `filename="..."`.
  const read = (key) => {
    const extended = new RegExp(`(?:^|;)\\s*${key}\\*\\s*=\\s*([^;]+)`, 'i').exec(raw);
    if (extended) {
      const value = extended[1].trim();
      const match = /^[^']*'[^']*'(.*)$/.exec(value);
      if (match) {
        try {
          return decodeURIComponent(match[1]);
        } catch {
          return match[1];
        }
      }
    }
    const quoted = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*"([^"]*)"`, 'i').exec(raw);
    if (quoted) return quoted[1];
    const bare = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*([^;]+)`, 'i').exec(raw);
    return bare ? bare[1].trim() : null;
  };
  return { name: read('name'), filename: read('filename') };
}

export class MultipartParser extends EventEmitter {
  /**
   * @param {string} boundary The boundary token, without leading dashes.
   * @param {{ maxHeaderBytes?: number, maxFieldBytes?: number, maxParts?: number }} [options]
   */
  constructor(boundary, options = {}) {
    super();
    if (!boundary) throw new TypeError('MultipartParser requires a boundary');

    // A leading CRLF is prepended to the stream so the first boundary looks
    // exactly like every later one and a single scan pattern covers both.
    this.marker = Buffer.from(`\r\n--${boundary}`, 'binary');
    this.buffer = Buffer.from('\r\n', 'binary');

    this.state = STATE.PREAMBLE;
    this.paused = false;
    this.finished = false;
    this.errored = false;
    /** @type {{ name: string|null, filename: string|null, mime: string, stream: PassThrough|null, chunks: Buffer[], size: number }|null} */
    this.current = null;
    this.partCount = 0;

    this.maxHeaderBytes = options.maxHeaderBytes ?? 16 * 1024;
    this.maxFieldBytes = options.maxFieldBytes ?? 1024 * 1024;
    this.maxParts = options.maxParts ?? 64;
  }

  /**
   * Feed bytes into the parser.
   * @param {Buffer} chunk
   * @returns {boolean} false when the caller should pause its source.
   */
  write(chunk) {
    if (this.errored || this.finished) return true;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    this.#process();
    return !this.paused;
  }

  /** Signal end of input. */
  end() {
    if (this.errored) return;
    this.#process();
    if (this.state !== STATE.EPILOGUE) {
      // A truncated body: close any open part so its consumer sees an error.
      if (this.current?.stream) this.current.stream.destroy(new Error('Truncated multipart body'));
      this.#fail(new Error('Unexpected end of multipart body'));
      return;
    }
    this.#finish();
  }

  /** Main state machine. Runs until it needs more data or is paused. */
  #process() {
    while (!this.paused && !this.errored && !this.finished) {
      if (this.state === STATE.PREAMBLE) {
        const index = this.buffer.indexOf(this.marker);
        if (index === -1) {
          this.#keepTail();
          return;
        }
        this.buffer = this.buffer.subarray(index + this.marker.length);
        this.state = STATE.AFTER_BOUNDARY;
        continue;
      }

      if (this.state === STATE.AFTER_BOUNDARY) {
        if (this.buffer.length < 2) return;
        // "--" right after the boundary marks the end of the whole body.
        if (this.buffer[0] === 0x2d && this.buffer[1] === 0x2d) {
          this.state = STATE.EPILOGUE;
          this.buffer = Buffer.alloc(0);
          return;
        }
        // Otherwise: optional linear whitespace, then CRLF, then part headers.
        let cursor = 0;
        while (cursor < this.buffer.length && (this.buffer[cursor] === 0x20 || this.buffer[cursor] === 0x09)) {
          cursor += 1;
        }
        if (this.buffer.length < cursor + 2) return;
        if (this.buffer[cursor] === 0x0d && this.buffer[cursor + 1] === 0x0a) {
          this.buffer = this.buffer.subarray(cursor + 2);
          this.state = STATE.HEADERS;
          continue;
        }
        this.#fail(new Error('Malformed multipart boundary'));
        return;
      }

      if (this.state === STATE.HEADERS) {
        const index = this.buffer.indexOf(CRLF_CRLF);
        if (index === -1) {
          if (this.buffer.length > this.maxHeaderBytes) this.#fail(new Error('Multipart part headers too large'));
          return;
        }
        const rawHeaders = this.buffer.subarray(0, index).toString('utf8');
        this.buffer = this.buffer.subarray(index + CRLF_CRLF.length);
        if (!this.#startPart(rawHeaders)) return;
        this.state = STATE.BODY;
        continue;
      }

      if (this.state === STATE.BODY) {
        const index = this.buffer.indexOf(this.marker);
        if (index === -1) {
          // Emit everything except a tail that could still be a partial
          // boundary; otherwise a boundary split across two chunks is missed.
          const keep = this.marker.length;
          if (this.buffer.length > keep) {
            const chunk = this.buffer.subarray(0, this.buffer.length - keep);
            this.buffer = this.buffer.subarray(this.buffer.length - keep);
            this.#writeToPart(chunk);
          }
          return;
        }
        const chunk = this.buffer.subarray(0, index);
        this.buffer = this.buffer.subarray(index + this.marker.length);
        this.#writeToPart(chunk);
        this.#endPart();
        this.state = STATE.AFTER_BOUNDARY;
        continue;
      }

      if (this.state === STATE.EPILOGUE) {
        this.buffer = Buffer.alloc(0);
        return;
      }
    }
  }

  /** Discard preamble bytes that can no longer contain a boundary start. */
  #keepTail() {
    const keep = this.marker.length;
    if (this.buffer.length > keep) this.buffer = this.buffer.subarray(this.buffer.length - keep);
  }

  /**
   * Begin a new part from its raw header block.
   * @returns {boolean} false when the parser errored out.
   */
  #startPart(rawHeaders) {
    this.partCount += 1;
    if (this.partCount > this.maxParts) {
      this.#fail(new Error('Too many multipart parts'));
      return false;
    }

    /** @type {Record<string,string>} */
    const headers = {};
    for (const line of rawHeaders.split('\r\n')) {
      const index = line.indexOf(':');
      if (index === -1) continue;
      headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }

    const disposition = parseContentDisposition(headers['content-disposition']);
    const mime = headers['content-type'] || '';

    if (disposition.filename !== null && disposition.filename !== undefined) {
      const stream = new PassThrough();
      this.current = { name: disposition.name, filename: disposition.filename, mime, stream, chunks: [], size: 0 };
      // Emitted synchronously so the consumer can attach before any data flows.
      this.emit('part', { name: disposition.name, filename: disposition.filename, mime, headers, stream });
    } else {
      this.current = { name: disposition.name, filename: null, mime, stream: null, chunks: [], size: 0 };
    }
    return true;
  }

  /** Write part data, honouring backpressure for file parts. */
  #writeToPart(chunk) {
    const part = this.current;
    if (!part || chunk.length === 0) return;
    part.size += chunk.length;

    if (part.stream) {
      if (!part.stream.write(chunk)) this.#pauseUntilDrained(part.stream);
      return;
    }

    if (part.size > this.maxFieldBytes) {
      this.#fail(new Error('Multipart field too large'));
      return;
    }
    part.chunks.push(Buffer.from(chunk));
  }

  /** Close the current part and publish it. */
  #endPart() {
    const part = this.current;
    this.current = null;
    if (!part) return;
    if (part.stream) {
      part.stream.end();
    } else {
      this.emit('field', { name: part.name, value: Buffer.concat(part.chunks).toString('utf8') });
    }
  }

  /**
   * Pause until the destination drains. Idempotent per pause episode, and it
   * also resumes on `finish` because a stream ended while full may emit that
   * instead of a final `drain`.
   */
  #pauseUntilDrained(stream) {
    if (this.paused) return;
    this.paused = true;
    let resumed = false;
    const resume = () => {
      if (resumed) return;
      resumed = true;
      stream.off('drain', resume);
      stream.off('finish', resume);
      stream.off('close', resume);
      this.paused = false;
      this.emit('drain');
      this.#process();
    };
    stream.once('drain', resume);
    stream.once('finish', resume);
    stream.once('close', resume);
  }

  #finish() {
    if (this.finished || this.errored) return;
    this.finished = true;
    this.emit('finish');
  }

  #fail(error) {
    if (this.errored) return;
    this.errored = true;
    if (this.current?.stream) this.current.stream.destroy(error);
    this.current = null;
    this.emit('error', error);
  }
}
