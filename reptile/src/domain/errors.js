/**
 * Domain errors.
 *
 * Every rule violation is an `AppError` with a machine `code` and an HTTP
 * `status`. The HTTP layer translates it into `{ error: { code, message } }`,
 * and the peer client turns that back into an error with the same code, so a
 * rule written once here reads the same on both machines.
 */
export class AppError extends Error {
  /**
   * @param {string} code
   * @param {string} message Human-readable, shown in the interface as is.
   * @param {{ status?: number, details?: any, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? 400;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause) this.cause = options.cause;
  }

  toJSON() {
    const body = { code: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

/** Shorthand constructors, one per status class the application uses. */
export const errors = {
  badRequest: (message, code = 'bad_request', details) => new AppError(code, message, { status: 400, details }),
  unauthorized: (message = 'This session is not valid any more. Connect again with the PIN.') =>
    new AppError('unauthorized', message, { status: 401 }),
  forbidden: (message, code = 'forbidden') => new AppError(code, message, { status: 403 }),
  notFound: (message = 'Not found.', code = 'not_found') => new AppError(code, message, { status: 404 }),
  conflict: (message, code = 'conflict', details) => new AppError(code, message, { status: 409, details }),
  payloadTooLarge: (message) => new AppError('payload_too_large', message, { status: 413 }),
  unsupportedMedia: (message) => new AppError('unsupported_media_type', message, { status: 415 }),
  unavailable: (message, code = 'unavailable') => new AppError(code, message, { status: 503 }),
  internal: (message = 'Something went wrong.', cause) => new AppError('internal', message, { status: 500, cause }),
};

/**
 * Normalise anything thrown into an AppError. Unknown errors become a 500
 * whose message does not leak internals.
 * @param {unknown} error
 * @returns {AppError}
 */
export function toAppError(error) {
  if (error instanceof AppError) return error;
  return errors.internal('Something went wrong.', error);
}
