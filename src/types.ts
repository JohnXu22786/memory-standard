/**
 * Shared domain types for the Memory Standard Protocol (mm).
 *
 * These are the stable, documented surface that cross-agent consumers rely on:
 * a memory is a folder with an index (`MEMORY.md`) plus topic detail files in
 * markdown, addressed by `mm://<memoryId>/<topic>` URIs. Keeping the types in
 * one module makes the format contract auditable and re-exportable as the
 * package's `.d.ts` interop surface.
 *
 * @module
 */

/** Canonical format version this implementation reads and writes. */
export const FORMAT_VERSION = 1

/** The URI scheme used to address memory topics across tools and agents. */
export const URI_SCHEME = 'mm'

/** Default hard cap on MEMORY.md line count (the "hard top"). */
export const DEFAULT_INDEX_LINES = 200
/** Default hard cap on MEMORY.md size in UTF-8 bytes. */
export const DEFAULT_INDEX_BYTES = 25 * 1024
/** Default hard cap on a single detail memory file, in UTF-8 bytes. */
export const DEFAULT_DETAIL_MAX_BYTES = 64 * 1024
/** Default per-write character budget (Unicode code points) when none is given. */
export const DEFAULT_WRITE_BUDGET = 4000
/** Default maximum results returned by one search. */
export const DEFAULT_SEARCH_LIMIT = 10
/** Default character cap for a search snippet. */
export const DEFAULT_SNIPPET_CHARS = 160
/** Maximum length of a topic slug. */
export const TOPIC_MAX_LENGTH = 64
/** Topic slugs are portable ASCII: they become filenames and URI segments. */
export const TOPIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export type SearchEngine = 'scan' | 'fts5'
export type SearchMode = 'auto' | SearchEngine

/** One row of the MEMORY.md index. */
export interface IndexEntry {
  topic: string
  /** The memory id used in `mm://<memoryId>/<topic>` URIs. */
  memoryId: string
  /** One-line human summary (may be empty). */
  summary: string
  /** Normalized tag list (may be empty). */
  tags: string[]
  /** Relative path of the detail file, POSIX separators, e.g. `memories/alpha.md`. */
  file: string
  /** ISO-8601 UTC timestamp of the last write. */
  updated: string
  /** Body character count (Unicode code points) recorded at write time. */
  bodyChars: number
  /** The write budget the body was admitted under. */
  writeBudget: number
  /** Free-form body lines that may live inside an index entry (preserved verbatim). */
  entryBody: string
}

/** A loaded detail memory note. */
export interface Note extends IndexEntry {
  /** Canonical URI `mm://<memoryId>/<topic>`. */
  uri: string
  /** The note body as stored in the detail file. Empty when the file is missing. */
  body: string
  /** True when the index references a detail file that does not exist. */
  missingFile: boolean
}

/** The in-memory (frozen) snapshot served to readers within a session. */
export interface Snapshot {
  loadedAt: string
  memoryId: string
  root: string
  indexLineCount: number
  indexByteCount: number
  indexOverBudget: boolean
  entries: IndexEntry[]
  notes: Note[]
  anomalies: {
    /** Index entries whose detail file is missing. */
    danglingEntries: number
    /** Detail files present on disk but not referenced by the index. */
    orphanFiles: string[]
  }
  /** Row-oriented corpus the search engines index. */
  corpus: Note[]
  /** Effective search engine resolved at load time. */
  engine: SearchEngine
}

export interface SearchOptions {
  mode?: SearchMode
  limit?: number
}

export interface MemoryOptions {
  /** Explicit memory root. Empty/undefined resolves via DSH_MEMORY_ROOT or the dsh home. */
  root?: string
  /** Identifier embedded in URIs (default `local`). */
  memoryId?: string
  /** Hard cap: index line count (default 200). */
  indexLines?: number
  /** Hard cap: index UTF-8 bytes (default 25 * 1024). */
  indexBytes?: number
  /** Hard cap: single detail file UTF-8 bytes (default 64 * 1024). */
  detailMaxBytes?: number
  /** Default per-write character budget (default 4000). */
  defaultWriteBudget?: number
  /** Search engine configuration. */
  search?: { mode?: SearchMode; limit?: number; maxSnippetChars?: number }
  /** Nudge (session-end / periodic) configuration. */
  nudge?: { enabled?: boolean; intervalMs?: number }
  /** Clock injection for deterministic timestamps in tests. */
  now?: () => Date
}

export interface IndexUsage {
  entries: number
  lines: number
  bytes: number
  lineCap: number
  byteCap: number
  overBudget: boolean
  overflowLines: number
  overflowBytes: number
}

/** Budget accounting returned by every write attempt. */
export interface WriteUsage {
  bodyChars: number
  writeBudget: number
  overflow: number
  noteBytes: number
  noteMaxBytes: number
  index: IndexUsage
}

export type WriteAction = 'created' | 'updated'

export type WriteOutcome =
  | {
      ok: true
      topic: string
      uri: string
      action: WriteAction
      usage: WriteUsage
      pendingWrites: number
    }
  | {
      ok: false
      code: string
      message: string
      reason: string
      usage: WriteUsage
      topic: string
    }

export interface DeleteOutcome {
  ok: boolean
  removed: boolean
  topic: string
  pendingWrites: number
  usage: IndexUsage
}

export interface PerTopicBudget {
  topic: string
  uri: string
  bodyChars: number
  noteBytes: number
  writeBudget: number
  budgetUsedPct: number
}

export interface BudgetReport {
  root: string
  memoryId: string
  loadedAt: string
  snapshotAgeMs: number
  pendingWrites: number
  index: IndexUsage
  detail: {
    noteCount: number
    totalBodyChars: number
    totalBytes: number
    maxBytes: number
  }
  perTopic: PerTopicBudget[]
  anomalies: {
    danglingEntries: number
    orphanFiles: string[]
  }
  search: {
    configuredMode: SearchMode
    engine: SearchEngine
  }
}

export interface SearchMatch {
  topic: string
  uri: string
  updated: string
  score: number
  snippet: string
}

export interface SearchResult {
  query: string
  engine: SearchEngine
  total: number
  truncated: boolean
  matches: SearchMatch[]
  /** Non-empty when fallback behavior was applied (e.g. fts5 unavailable). */
  note?: string
}

export type DigestSourceKind = 'session-log' | 'text' | 'none'

export interface DigestCandidate {
  topic: string
  /** Where the candidate came from: uri / explicit / summary / heading. */
  kind: 'uri' | 'explicit' | 'summary' | 'heading'
  summary: string
  /** Proposed body, trimmed to the write budget (proposal only). */
  body: string
  chars: number
  budget: number
  overBudget: boolean
}

export interface DigestResult {
  source: string
  sourceKind: DigestSourceKind
  candidates: DigestCandidate[]
  usage: { chars: number; budget: number; overflow: number }
  note: string
}

export interface NudgeReport {
  at: string
  pendingWrites: number
  noteCount: number
  indexOverBudget: boolean
  needsCommit: boolean
  suggestedActions: string[]
}
