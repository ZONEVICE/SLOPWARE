/**
 * Domain errors.
 *
 * A domain service never knows whether it was called from an HTTP route or a
 * WebSocket handler, so it throws `AppError` and lets each transport translate:
 * the HTTP layer maps `status`, the realtime layer sends `code` in an
 * `error` frame. Both use the same human-readable `message`.
 */
export class AppError extends Error {
  /**
   * @param {string} code Stable machine-readable code, e.g. "room_not_found".
   * @param {string} message Human-readable text, safe to show in the UI.
   * @param {number} [status] Matching HTTP status.
   * @param {object} [details] Extra structured context.
   */
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }

  /** JSON body / WebSocket payload representation. */
  toJSON() {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

/** Factory shortcuts for the codes used across the application. */
export const errors = {
  badRequest: (message, details) => new AppError('bad_request', message, 400, details),
  identityRequired: () =>
    new AppError('identity_required', 'Choose a username before using the chat.', 401),
  forbidden: (message) => new AppError('forbidden', message, 403),
  notFound: (message) => new AppError('not_found', message, 404),
  roomNotFound: () => new AppError('room_not_found', 'This chat room no longer exists.', 404),
  uploadNotFound: () => new AppError('upload_not_found', 'That attachment is not available.', 404),
  payloadTooLarge: (message) => new AppError('payload_too_large', message, 413),
  unsupportedMedia: (message) => new AppError('unsupported_media_type', message, 415),
  internal: (message = 'Unexpected server error.') => new AppError('internal_error', message, 500),
};

/** Narrow an unknown thrown value into an AppError. */
export function toAppError(error) {
  if (error instanceof AppError) return error;
  const wrapped = errors.internal(error?.message || 'Unexpected server error.');
  wrapped.cause = error;
  return wrapped;
}
