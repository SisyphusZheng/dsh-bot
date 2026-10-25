/**
 * Product-level error surface for the Nisse MemoryAdapter.
 *
 * Contract: the adapter NEVER turns a backend failure into a fake success.
 *   - health() returns { ok: false, degraded } instead of throwing (probe semantics);
 *   - every mutating/reading operation throws one of the typed errors below;
 *   - callers can branch on `code` (stable) and `retryable`.
 */
import { HindsightError } from '../vendor/hindsight-client/runtime.mjs';

export class MemoryError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message human-readable, no memory content, no secrets
   * @param {{cause?: unknown, retryable?: boolean, statusCode?: number, details?: unknown}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'MemoryError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.statusCode = opts.statusCode;
    this.details = opts.details;
  }
}

/** Backend unreachable / not ready. Safe to retry after backoff; never fake success. */
export class MemoryUnavailableError extends MemoryError {
  constructor(message, opts = {}) {
    super('MEMORY_UNAVAILABLE', message, { retryable: true, ...opts });
    this.name = 'MemoryUnavailableError';
  }
}

/** Caller supplied invalid arguments (validated before any backend call). */
export class InvalidRequestError extends MemoryError {
  constructor(message, opts = {}) {
    super('INVALID_REQUEST', message, { retryable: false, ...opts });
    this.name = 'InvalidRequestError';
  }
}

/** Backend rejected the request (4xx). Not retryable as-is. */
export class BackendRejectedError extends MemoryError {
  constructor(message, opts = {}) {
    super('BACKEND_REJECTED', message, { retryable: false, ...opts });
    this.name = 'BackendRejectedError';
  }
}

/** Backend failed (5xx / 429 / transport-level failure after retries). */
export class BackendError extends MemoryError {
  constructor(message, opts = {}) {
    super('BACKEND_ERROR', message, { retryable: true, ...opts });
    this.name = 'BackendError';
  }
}

/** Write rejected by the adapter's sensitive-information screen (before egress). */
export class SensitiveContentError extends MemoryError {
  /** @param {string[]} patterns matched pattern labels only — never the matched text */
  constructor(patterns, opts = {}) {
    super(
      'SENSITIVE_CONTENT_REJECTED',
      `write rejected: content matches sensitive-information patterns (${patterns.join(', ')}); nothing was sent to the backend`,
      { retryable: false, details: { patterns }, ...opts }
    );
    this.name = 'SensitiveContentError';
    this.patterns = patterns;
  }
}

/** Writer policy: this caller role is not allowed to write (e.g. subagent = read-only). */
export class ReadonlyWriterError extends MemoryError {
  constructor(writer, allowed, opts = {}) {
    super(
      'READONLY_WRITER',
      `writer '${writer}' is not authorized to write memory (allowed: ${allowed.join(', ')})`,
      { retryable: false, details: { writer, allowed }, ...opts }
    );
    this.name = 'ReadonlyWriterError';
  }
}

/** Single-writer policy: another writer currently holds the bank write lease. */
export class WriterConflictError extends MemoryError {
  constructor(holder, opts = {}) {
    super(
      'WRITER_CONFLICT',
      `another writer holds the memory write lease (pid=${holder?.pid ?? '?'}, writer=${holder?.writer ?? '?'})`,
      { retryable: true, details: { holder }, ...opts }
    );
    this.name = 'WriterConflictError';
  }
}

/** Same idempotencyKey reused with different content. */
export class IdempotencyConflictError extends MemoryError {
  constructor(keyHash, opts = {}) {
    super('IDEMPOTENCY_KEY_REUSED', `idempotency key ${keyHash} was already used with different content`, {
      retryable: false,
      details: { keyHash },
      ...opts,
    });
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * Map an error thrown by the pinned Hindsight Node client (or by fetch) onto the
 * product error surface above. Never leaks response bodies that could contain
 * memory text: only status codes and a truncated, non-content reason are kept.
 * @param {unknown} err
 * @param {string} op
 */
export function mapBackendError(err, op) {
  if (err instanceof MemoryError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const safe = msg.replace(/\s+/g, ' ').slice(0, 300);

  if (err instanceof HindsightError) {
    const status = err.statusCode;
    if (status === undefined) return new MemoryUnavailableError(`${op} failed: backend unreachable (${safe})`, { cause: err });
    if (status === 429 || status >= 500) return new BackendError(`${op} failed: HTTP ${status} (${safe})`, { cause: err, statusCode: status });
    return new BackendRejectedError(`${op} failed: HTTP ${status} (${safe})`, { cause: err, statusCode: status, details: status === 404 ? { notFound: true } : undefined });
  }

  const code = /** @type {any} */ (err)?.code ?? /** @type {any} */ (err)?.cause?.code;
  const name = /** @type {any} */ (err)?.name;
  if (name === 'AbortError' || name === 'TimeoutError' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new MemoryUnavailableError(`${op} failed: backend unreachable (${name ?? code})`, { cause: err });
  }
  if (name === 'TypeError' && /fetch failed|network|connection/i.test(safe)) {
    return new MemoryUnavailableError(`${op} failed: backend unreachable (fetch failed)`, { cause: err });
  }
  return new BackendError(`${op} failed: ${safe}`, { cause: err });
}
