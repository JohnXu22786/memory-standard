/**
 * Canonical error type for the memory standard.
 *
 * Budget violations are *results*, not exceptions (the caller must read the
 * usage metrics and compress). Exceptions are reserved for genuinely broken
 * states: unreadable/malformed data, missing roots, invalid identifiers, and
 * I/O failure. Every exception carries a stable machine-readable `code`.
 *
 * @module
 */

export const ErrCode = {
  /** A value or identifier failed validation. */
  E_INVALID: 'E_INVALID',
  /** The memory root does not exist (opened read-only). */
  E_NOT_INITIALIZED: 'E_NOT_INITIALIZED',
  /** An on-disk file could not be parsed as the standard format. */
  E_PARSE: 'E_PARSE',
  /** A read/write was attempted before the snapshot was loaded. */
  E_SNAPSHOT: 'E_SNAPSHOT',
  /** A filesystem operation failed. */
  E_IO: 'E_IO',
  /** No digest source could be located or read. */
  E_DIGEST_SOURCE: 'E_DIGEST_SOURCE',
} as const

export type MemoryErrorCode = (typeof ErrCode)[keyof typeof ErrCode]

/**
 * Result codes for budget violations. These are returned inside `ok:false`
 * outcomes (the caller reads the usage metrics and compresses) rather than
 * thrown; `ErrCode` is reserved for genuinely broken states.
 */
export const BudgetCode = {
  /** The body exceeds the per-call character budget. */
  E_WRITE_BUDGET_EXCEEDED: 'E_WRITE_BUDGET_EXCEEDED',
  /** The resulting detail file exceeds its byte cap. */
  E_FILE_BUDGET_EXCEEDED: 'E_FILE_BUDGET_EXCEEDED',
  /** The resulting MEMORY.md index exceeds its line/byte hard cap. */
  E_INDEX_BUDGET_EXCEEDED: 'E_INDEX_BUDGET_EXCEEDED',
} as const

export type BudgetErrorCode = (typeof BudgetCode)[keyof typeof BudgetCode]

export interface MemoryErrorOptions {
  /** Underlying cause (e.g. a Node fs error). */
  cause?: unknown
  /** Optional structured payload for diagnostics. */
  details?: unknown
}

export class MemoryError extends Error {
  readonly code: MemoryErrorCode
  readonly details?: unknown

  constructor(code: MemoryErrorCode, message: string, options: MemoryErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'MemoryError'
    this.code = code
    this.details = options.details
  }
}

export function isMemoryError(value: unknown): value is MemoryError {
  return value instanceof MemoryError
}
