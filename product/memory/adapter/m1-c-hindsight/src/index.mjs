/**
 * Public entry point for the Nisse M1-C Hindsight MemoryAdapter spike.
 * See README.md and REPORT.md; the adapter contract mirrors MEMORY-SERVICE-SPEC §3.
 */
export { MemoryAdapter, ADAPTER_VERSION, DEFAULT_BANK_ID, MEMORY_KINDS, NAMESPACE_RE } from './memory-adapter.mjs';
export {
  MemoryError,
  MemoryUnavailableError,
  InvalidRequestError,
  BackendRejectedError,
  BackendError,
  SensitiveContentError,
  ReadonlyWriterError,
  WriterConflictError,
  IdempotencyConflictError,
  mapBackendError,
} from './errors.mjs';
export { WriterLock } from './writer-lock.mjs';
export { SENSITIVE_PATTERNS, scanSensitive, assertSensitiveFree } from './sensitive.mjs';
