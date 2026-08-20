/**
 * Core entry: the dependency-free library surface of the memory standard.
 * Importing anything from this module never loads a dsh/cordis package.
 *
 * @module
 */

export { Memory } from './memory.js'
export { MemoryError, ErrCode, isMemoryError } from './errors.js'
export type { MemoryErrorCode, MemoryErrorOptions } from './errors.js'

export {
  parseIndex,
  serializeIndex,
  parseNoteText,
  serializeNoteText,
  parseMemoryUri,
  uriFor,
  assertSafeRelPath,
  countLines,
} from './format.js'
export type { ParsedIndex, ParsedIndexHeader, ParsedNote, SerializeIndexInput } from './format.js'

export { countChars, byteLength, slugForTopic, validateTopic, firstLine, normalizeLine, parseTags } from './text.js'

export { resolveRoot, dshHome, memoryLayout, detailRel, toPlatformPath, expandHome, expandEnv } from './paths.js'

export { chooseSearchEngine, requiresSqlite, makeSnippet, tokenize, searchScan, searchFts5, Fts5Index } from './search.js'

export { computeIndexUsage, budgetUsedPct } from './budget.js'

export { digest, distill, resolveSessionLog } from './digest.js'
export type { DigestInput } from './digest.js'

export {
  FORMAT_VERSION,
  URI_SCHEME,
  DEFAULT_INDEX_LINES,
  DEFAULT_INDEX_BYTES,
  DEFAULT_DETAIL_MAX_BYTES,
  DEFAULT_WRITE_BUDGET,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SNIPPET_CHARS,
  TOPIC_MAX_LENGTH,
  TOPIC_PATTERN,
} from '../types.js'

export type {
  BudgetReport,
  DeleteOutcome,
  DigestCandidate,
  DigestResult,
  DigestSourceKind,
  IndexEntry,
  IndexUsage,
  MemoryOptions,
  Note,
  NudgeReport,
  PerTopicBudget,
  SearchEngine,
  SearchMatch,
  SearchMode,
  SearchOptions,
  SearchResult,
  Snapshot,
  WriteAction,
  WriteOutcome,
  WriteUsage,
} from '../types.js'
