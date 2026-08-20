/**
 * `Memory` â€” the facade of the memory standard. It combines the layered
 * store, deterministic budgets, frozen snapshot semantics, search, and digest
 * into one cohesive API used by the dsh tools, the CLI, and library users.
 *
 * Snapshot semantics (the cache-protection contract):
 * - Reading is served from a snapshot loaded once at open/ensure/reload.
 * - Writes persist to disk immediately and are durable for the *next* session;
 *   they never mutate the in-session snapshot (`pendingWrites` tracks them).
 * - `reload()` re-snapshots from disk (picks up this session's writes and any
 *   external edits from other agents/processes).
 *
 * @module
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { MemoryError, ErrCode, BudgetCode } from './errors.js'
import { normalizeLine, parseTags, validateTopic } from './text.js'
import {
  parseIndex,
  serializeIndex,
  serializeNoteText,
  parseNoteText,
  uriFor,
  assertSafeRelPath,
  assertInsideRoot,
} from './format.js'
import { computeIndexUsage, budgetUsedPct } from './budget.js'
import { memoryLayout, detailRel, toPlatformPath, resolveRoot } from './paths.js'
import { chooseSearchEngine, requiresSqlite, Fts5Index, searchScan, searchFts5 } from './search.js'
import { digest as runDigest, type DigestInput } from './digest.js'
import {
  TOPIC_PATTERN,
  DEFAULT_INDEX_LINES,
  DEFAULT_INDEX_BYTES,
  DEFAULT_DETAIL_MAX_BYTES,
  DEFAULT_WRITE_BUDGET,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SNIPPET_CHARS,
} from '../types.js'
import type {
  BudgetReport,
  MemoryOptions,
  PerTopicBudget,
  Snapshot,
  Note,
  IndexEntry,
  IndexUsage,
  DeleteOutcome,
  DigestResult,
  NudgeReport,
  SearchMode,
  SearchResult,
  WriteOutcome,
  WriteUsage,
} from '../types.js'

function requirePositiveInt(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new MemoryError(ErrCode.E_INVALID, `${name} must be a positive integer`)
  }
  return resolved
}

/** Per-process counter so concurrent writers (e.g. worker threads) never share temp names. */
let atomicWriteSeq = 0

/**
 * Write a file atomically (unique temp + rename) and never destroy prior
 * content: if the swap rename fails because the destination exists, move the
 * old file aside first and only remove it after the new one is in place.
 */
function atomicWriteSync(path: string, content: string): void {
  const dir = dirname(path)
  const base = basename(path)
  atomicWriteSeq += 1
  const tmp = join(dir, `.${base}.${process.pid}.${atomicWriteSeq}.tmp`)
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, path)
    return
  } catch {
    // destination exists (typical on Windows): swap via a backup, restoring it
    // if the replacement still fails so the last good copy is never lost
    const backup = join(dir, `.${base}.${process.pid}.${atomicWriteSeq}.bak`)
    try {
      renameSync(path, backup)
    } catch {
      // destination absent — nothing to preserve; just place the new file
    }
    try {
      renameSync(tmp, path)
    } catch (error) {
      try {
        if (existsSync(backup)) renameSync(backup, path)
      } catch {
        /* best effort restore */
      }
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* best effort */
      }
      throw new MemoryError(ErrCode.E_IO, `failed to write ${path}`, { cause: error })
    }
    try {
      rmSync(backup, { force: true })
    } catch {
      /* best effort */
    }
  }
}

/**
 * Create, load, and serve a memory. Use {@link Memory.ensure} when writes
 * should be possible (initializes missing roots) and {@link Memory.open} for
 * read-only access to an existing root.
 */
export class Memory {
  readonly root: string
  readonly memoryId: string
  readonly indexLines: number
  readonly indexBytes: number
  readonly detailMaxBytes: number
  readonly defaultWriteBudget: number
  readonly searchMode: SearchMode
  readonly searchLimit: number
  readonly maxSnippetChars: number
  readonly nudgeEnabled: boolean
  readonly nudgeIntervalMs: number

  private readonly now: () => Date
  private loadedState = false
  private loadedAtValue: string | null = null
  private snapshotValue: Snapshot | null = null
  private pendingWritesValue = 0
  private engineValue: 'scan' | 'fts5' = 'scan'
  private fts: Fts5Index | null = null
  private initializedValue = false

  constructor(options: MemoryOptions = {}) {
    const memoryId = options.memoryId ?? 'local'
    if (!TOPIC_PATTERN.test(memoryId)) {
      throw new MemoryError(ErrCode.E_INVALID, `memoryId ${JSON.stringify(memoryId)} is not a valid slug`)
    }
    this.memoryId = memoryId
    this.root = resolveRoot(options.root)
    this.indexLines = requirePositiveInt('indexLines', options.indexLines, DEFAULT_INDEX_LINES)
    this.indexBytes = requirePositiveInt('indexBytes', options.indexBytes, DEFAULT_INDEX_BYTES)
    this.detailMaxBytes = requirePositiveInt('detailMaxBytes', options.detailMaxBytes, DEFAULT_DETAIL_MAX_BYTES)
    this.defaultWriteBudget = requirePositiveInt('defaultWriteBudget', options.defaultWriteBudget, DEFAULT_WRITE_BUDGET)
    this.searchMode = options.search?.mode ?? 'auto'
    this.searchLimit = requirePositiveInt('search.limit', options.search?.limit, DEFAULT_SEARCH_LIMIT)
    this.maxSnippetChars = requirePositiveInt('search.maxSnippetChars', options.search?.maxSnippetChars, DEFAULT_SNIPPET_CHARS)
    this.nudgeEnabled = options.nudge?.enabled ?? false
    this.nudgeIntervalMs = options.nudge?.intervalMs ?? 30 * 60 * 1000
    this.now = options.now ?? (() => new Date())
  }


  /** Create a memory, initializing the root and index if needed. */
  static ensure(options: MemoryOptions = {}): Memory {
    const memory = new Memory(options)
    return memory.ensureInitialized()
  }

  /**
   * Open an existing memory root without initializing it (fails with
   * E_NOT_INITIALIZED when the root is absent). Reads serve the frozen
   * snapshot; writes still persist to disk for the next session. Use
   * {@link Memory.ensure} when the root should be created on demand.
   */
  static open(options: MemoryOptions = {}): Memory {
    const memory = new Memory(options)
    return memory.load()
  }

  get loaded(): boolean {
    return this.loadedState
  }

  get initialized(): boolean {
    return this.initializedValue
  }

  get loadedAt(): string | null {
    return this.loadedAtValue
  }

  get pendingWrites(): number {
    return this.pendingWritesValue
  }

  /** Effective search engine (resolved at load time). */
  get engine(): 'scan' | 'fts5' {
    return this.engineValue
  }

  get snapshot(): Snapshot | null {
    return this.snapshotValue
  }

  /** Ensure root + index exist, then load. */
  ensureInitialized(): this {
    const { indexFile, detailDir } = memoryLayout(this.root)
    mkdirSync(detailDir, { recursive: true })
    if (!existsSync(indexFile)) {
      writeFileSync(indexFile, serializeIndex({ memoryId: this.memoryId, indexLines: this.indexLines, indexBytes: this.indexBytes, entries: [] }), 'utf8')
    }
    // an existing index is never overwritten with a template; load() parses it
    // (and fails loudly with E_PARSE if it is not mm v1 conformant)
    this.initializedValue = true
    return this.load()
  }

  /** Load (or reload) the snapshot from disk. */
  load(): this {
    if (!existsSync(this.root)) {
      throw new MemoryError(ErrCode.E_NOT_INITIALIZED, `memory root does not exist: ${this.root}`)
    }
    this.closeFts()
    const { indexFile, detailDir } = memoryLayout(this.root)
    let indexText = ''
    if (existsSync(indexFile)) {
      try {
        indexText = readFileSync(indexFile, 'utf8')
      } catch (error) {
        throw this.ioError(`read ${indexFile}`, error)
      }
    }
    const parsed = indexText.trim().length === 0
      ? { entries: [] as IndexEntry[], lineCount: 0, byteCount: 0, header: { memoryId: this.memoryId } }
      : safeParse(() => parseIndex(indexText, { memoryId: this.memoryId }), indexFile)

    const entries = parsed.entries
    const notes: Note[] = []
    let dangling = 0
    const indexedFiles = new Set(entries.map((e) => e.file))
    for (const entry of entries) {
      const rel = toPlatformPath(assertSafeRelPath(entry.file))
      const full = join(this.root, rel)
      assertInsideRoot(this.root, full)
      let body = ''
      let missingFile = false
      if (existsSync(full) && statSync(full).isFile()) {
        const noteText = safeParse(() => readFileSync(full, 'utf8'), full)
        body = noteText.trim() ? safeParse(() => parseNoteText(noteText).body, full) : ''
      } else {
        missingFile = true
        dangling += 1
      }
      notes.push({ ...entry, uri: uriFor(this.memoryId, entry.topic), body, missingFile })
    }
    // detect orphan detail files (present but unindexed)
    const orphans: string[] = []
    if (existsSync(detailDir)) {
      for (const name of readdirSync(detailDir).sort()) {
        if (name.endsWith('.md')) {
          const relFile = `memories/${name}`
          if (!indexedFiles.has(relFile)) orphans.push(name)
        }
      }
    }

    const indexUsage = computeIndexUsage(indexText, this.indexLines, this.indexBytes)
    const engine = chooseSearchEngine(this.searchMode, requiresSqlite())
    this.snapshotValue = {
      loadedAt: this.now().toISOString(),
      memoryId: this.memoryId,
      root: this.root,
      indexLineCount: indexUsage.lines,
      indexByteCount: indexUsage.bytes,
      indexOverBudget: indexUsage.overBudget,
      entries,
      notes,
      anomalies: { danglingEntries: dangling, orphanFiles: orphans },
      corpus: notes,
      engine,
    }
    this.engineValue = engine
    this.fts = engine === 'fts5' ? buildFts(this.snapshotValue) : null
    this.loadedAtValue = this.now().toISOString()
    this.pendingWritesValue = 0
    this.loadedState = true
    return this
  }

  /** Reload the snapshot from disk (picks up writes and external edits). */
  reload(): this {
    return this.load()
  }

  /** Canonical URI for a topic. */
  uriFor(topic: string): string {
    return uriFor(this.memoryId, topic)
  }

  private ioError(action: string, error: unknown): MemoryError {
    return new MemoryError(ErrCode.E_IO, `${action} failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }

  private requireLoaded(): Snapshot {
    if (!this.loadedState || this.snapshotValue === null) {
      throw new MemoryError(ErrCode.E_SNAPSHOT, 'memory is not loaded; call ensure()/open()/reload() first')
    }
    return this.snapshotValue
  }

  /** Read the index view (from the frozen snapshot). */
  readIndex(): {
    memoryId: string
    root: string
    loadedAt: string
    lineCount: number
    byteCount: number
    overBudget: boolean
    lineCap: number
    byteCap: number
    entries: IndexEntry[]
  } {
    const snap = this.requireLoaded()
    return {
      memoryId: snap.memoryId,
      root: snap.root,
      loadedAt: snap.loadedAt,
      lineCount: snap.indexLineCount,
      byteCount: snap.indexByteCount,
      overBudget: snap.indexOverBudget,
      lineCap: this.indexLines,
      byteCap: this.indexBytes,
      entries: snap.entries.map((e) => ({ ...e, tags: [...e.tags] })),
    }
  }

  /** Read one note from the frozen snapshot (undefined when absent). */
  readTopic(topic: string): Note | undefined {
    validateTopic(topic)
    const snap = this.requireLoaded()
    const note = snap.notes.find((n) => n.topic === topic)
    return note === undefined ? undefined : { ...note, tags: [...note.tags] }
  }

  /** All notes, sorted by topic (frozen snapshot). */
  listNotes(): Note[] {
    const snap = this.requireLoaded()
    return [...snap.notes].sort((a, b) => (a.topic < b.topic ? -1 : 1)).map((n) => ({ ...n, tags: [...n.tags] }))
  }

  /** Compute the live (on-disk) index context needed for budget checks. */
  private liveIndexState(): { entries: IndexEntry[]; text: string; usage: IndexUsage } {
    const { indexFile } = memoryLayout(this.root)
    let text = ''
    if (existsSync(indexFile)) {
      try {
        text = readFileSync(indexFile, 'utf8')
      } catch (error) {
        throw this.ioError(`read ${indexFile}`, error)
      }
    }
    const parsed = text.trim().length === 0
      ? { entries: [] as IndexEntry[] }
      : safeParse(() => parseIndex(text, { memoryId: this.memoryId }), indexFile)
    return { entries: parsed.entries, text, usage: computeIndexUsage(text, this.indexLines, this.indexBytes) }
  }

  /**
   * Write (create or update) a topic. Budget violations are structured
   * failures (`ok: false`) carrying usage metrics â€” never a truncation.
   */
  write(input: {
    topic: string
    content: string
    budget?: number
    summary?: string
    tags?: string
    updated?: string
  }): WriteOutcome {
    const topic = validateTopic(input.topic)
    if (typeof input.content !== 'string' || input.content.trim().length === 0) {
      return this.budgetFailure(topic, ErrCode.E_INVALID, 'content must be a non-empty string', 'E_INVALID')
    }
    const body = input.content
    const bodyChars = Array.from(body).length
    const writeBudget = Number.isInteger(input.budget) && (input.budget as number) > 0
      ? (input.budget as number)
      : this.defaultWriteBudget
    const overflow = Math.max(0, bodyChars - writeBudget)

    const live = this.liveIndexState()
    const usageBase = {
      bodyChars,
      writeBudget,
      overflow,
      noteBytes: 0,
      noteMaxBytes: this.detailMaxBytes,
      index: live.usage,
    }

    if (bodyChars > writeBudget) {
      return this.budgetFailure(topic, BudgetCode.E_WRITE_BUDGET_EXCEEDED, 'content exceeds its write budget; compress it to fit (see usage)', 'E_WRITE_BUDGET_EXCEEDED', usageBase)
    }

    const file = detailRel(topic)
    const noteText = serializeNoteText({ topic, memoryId: this.memoryId, file, body })
    const noteBytes = Buffer.byteLength(noteText, 'utf8')
    if (noteBytes > this.detailMaxBytes) {
      const usage = { ...usageBase, noteBytes }
      return this.budgetFailure(topic, BudgetCode.E_FILE_BUDGET_EXCEEDED, 'detail memory exceeds its byte cap; split or condense it (see usage)', 'E_FILE_BUDGET_EXCEEDED', usage)
    }

    const existing = live.entries.find((e) => e.topic === topic)
    const nextEntries = live.entries.filter((e) => e.topic !== topic)
    const entry: IndexEntry = {
      topic,
      memoryId: this.memoryId,
      summary: normalizeLine(input.summary ?? existing?.summary ?? ''),
      tags: input.tags !== undefined ? parseTags(input.tags) : (existing?.tags ?? []),
      file,
      updated: input.updated ?? this.now().toISOString(),
      bodyChars,
      writeBudget,
      entryBody: existing?.entryBody ?? '',
    }
    nextEntries.push(entry)
    const nextIndexText = serializeIndex({ memoryId: this.memoryId, indexLines: this.indexLines, indexBytes: this.indexBytes, entries: nextEntries })
    const nextUsage = computeIndexUsage(nextIndexText, this.indexLines, this.indexBytes)
    const usage = { ...usageBase, noteBytes, index: nextUsage }

    if (nextUsage.overBudget) {
      return this.budgetFailure(
        topic,
        BudgetCode.E_INDEX_BUDGET_EXCEEDED,
        'the MEMORY.md index exceeds its hard limit; consolidate/rewrite the index (never truncate) (see usage.index)',
        'E_INDEX_BUDGET_EXCEEDED',
        usage,
      )
    }

    const { detailDir, indexFile } = memoryLayout(this.root)
    const detailPath = join(detailDir, `${topic}.md`)
    try {
      mkdirSync(dirname(detailPath), { recursive: true })
      atomicWriteSync(detailPath, noteText)
      atomicWriteSync(indexFile, nextIndexText)
    } catch (error) {
      if (error instanceof MemoryError) throw error
      throw this.ioError(`write memory ${topic}`, error)
    }
    this.pendingWritesValue += 1
    return { ok: true, topic, uri: this.uriFor(topic), action: existing === undefined ? 'created' : 'updated', usage, pendingWrites: this.pendingWritesValue }
  }

  private budgetFailure(
    topic: string,
    code: string,
    message: string,
    reason: string,
    usage?: WriteUsage,
  ): WriteOutcome {
    const ready = usage ?? (() => {
      const live = this.liveIndexState()
      return { bodyChars: 0, writeBudget: this.defaultWriteBudget, overflow: 0, noteBytes: 0, noteMaxBytes: this.detailMaxBytes, index: live.usage }
    })()
    return { ok: false, code, message, reason, usage: ready, topic } as WriteOutcome
  }

  /** Delete a topic (detail file + index entry). */
  delete(topic: string): DeleteOutcome {
    validateTopic(topic)
    this.requireLoaded()
    const live = this.liveIndexState()
    const existed = live.entries.some((e) => e.topic === topic)
    const nextEntries = live.entries.filter((e) => e.topic !== topic)
    const nextIndexText = serializeIndex({ memoryId: this.memoryId, indexLines: this.indexLines, indexBytes: this.indexBytes, entries: nextEntries })
    const nextUsage = computeIndexUsage(nextIndexText, this.indexLines, this.indexBytes)
    // Deletion is always a monotonic improvement: it must never be blocked for
    // being "still over budget" or an over-budget index (e.g. one built by an
    // external edit) could not be recovered through the documented
    // delete/consolidate path. Blocking only happens for writes (additions).
    const { indexFile } = memoryLayout(this.root)
    // Resolve the detail file via the entry's own (already validated) `file:`
    // field when the topic is indexed, so a custom interop path is removed too;
    // fall back to the default `memories/<topic>.md` placement otherwise.
    const entry = live.entries.find((e) => e.topic === topic)
    let rel: string
    if (entry !== undefined) {
      rel = toPlatformPath(assertSafeRelPath(entry.file))
    } else {
      rel = toPlatformPath(detailRel(topic))
    }
    const detailPath = join(this.root, rel)
    assertInsideRoot(this.root, detailPath)
    const removed = existsSync(detailPath)
    try {
      if (removed) rmSync(detailPath, { force: true })
      atomicWriteSync(indexFile, nextIndexText)
    } catch (error) {
      throw this.ioError(`delete memory ${topic}`, error)
    }
    if (existed || removed) this.pendingWritesValue += 1
    return { ok: true, removed, topic, pendingWrites: this.pendingWritesValue, usage: nextUsage }
  }

  /** Search the frozen snapshot. */
  search(query: string, options: { mode?: SearchMode; limit?: number } = {}): SearchResult {
    const snap = this.requireLoaded()
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new MemoryError(ErrCode.E_INVALID, 'search query must be a non-empty string')
    }
    const limit = options.limit ?? this.searchLimit
    const requested = options.mode ?? this.searchMode
    const engine = chooseSearchEngine(requested, requiresSqlite())
    if (engine === 'scan') {
      const note = requested === 'fts5' ? 'fts5 requested but node:sqlite/FTS5 unavailable; used scan' : undefined
      return { ...searchScan(snap.corpus, query, limit, this.maxSnippetChars), ...(note !== undefined ? { note } : {}) }
    }
    if (this.fts === null) this.fts = buildFts(snap)
    return searchFts5(this.fts, snap.corpus, query, limit, this.maxSnippetChars)
  }

  /**
   * Full deterministic budget report. Reads the LIVE on-disk state (a fresh
   * index parse + per-note stats) so the report is actionable for compression
   * decisions immediately after writes — `pendingWrites` separately tracks the
   * in-session staging vs the frozen snapshot.
   */
  budget(): BudgetReport {
    this.requireLoaded()
    const live = this.liveIndexState()
    const index = computeIndexUsage(live.text, this.indexLines, this.indexBytes)
    const perTopic: PerTopicBudget[] = []
    let noteCount = 0
    let totalBodyChars = 0
    let totalBytes = 0
    const indexedFiles = new Set(live.entries.map((e) => e.file))
    let danglingEntries = 0
    for (const entry of [...live.entries].sort((a, b) => (a.topic < b.topic ? -1 : 1))) {
      const noteFile = join(this.root, toPlatformPath(entry.file))
      assertInsideRoot(this.root, noteFile)
      let fileBytes = 0
      if (existsSync(noteFile) && statSync(noteFile).isFile()) {
        try {
          fileBytes = statSync(noteFile).size
        } catch {
          fileBytes = 0
        }
      } else {
        danglingEntries += 1
      }
      const writeBudget = entry.writeBudget > 0 ? entry.writeBudget : this.defaultWriteBudget
      noteCount += 1
      totalBodyChars += entry.bodyChars
      totalBytes += fileBytes
      perTopic.push({
        topic: entry.topic,
        uri: this.uriFor(entry.topic),
        bodyChars: entry.bodyChars,
        noteBytes: fileBytes,
        writeBudget,
        budgetUsedPct: budgetUsedPct(entry.bodyChars, writeBudget),
      })
    }
    // anomalies come from the same live view as the rest of the report
    const orphans: string[] = []
    const { detailDir } = memoryLayout(this.root)
    if (existsSync(detailDir)) {
      for (const name of readdirSync(detailDir).sort()) {
        if (name.endsWith('.md')) {
          const relFile = `memories/${name}`
          if (!indexedFiles.has(relFile)) orphans.push(name)
        }
      }
    }
    const loadedAt = this.loadedAtValue ?? this.snapshotValue?.loadedAt ?? this.now().toISOString()
    return {
      root: this.root,
      memoryId: this.memoryId,
      loadedAt,
      snapshotAgeMs: Date.now() - Date.parse(loadedAt),
      pendingWrites: this.pendingWritesValue,
      index,
      detail: { noteCount, totalBodyChars, totalBytes, maxBytes: this.detailMaxBytes },
      perTopic,
      anomalies: { danglingEntries, orphanFiles: orphans },
      search: { configuredMode: this.searchMode, engine: this.engineValue },
    }
  }

  /** Distill candidate memories from a session log or text (never writes). */
  digest(input: DigestInput = {}): DigestResult {
    this.requireLoaded()
    return runDigest({ source: input.source, file: input.file, maxItems: input.maxItems, topicHint: input.topicHint, defaultWriteBudget: this.defaultWriteBudget })
  }

  /** Session-end / periodic nudge report (deterministic). */
  nudge(): NudgeReport {
    const snap = this.requireLoaded()
    const actions: string[] = []
    if (this.pendingWritesValue > 0) {
      actions.push(`commit ${this.pendingWritesValue} staged memory write(s): they persist to disk and will load next session`)
    }
    if (snap.notes.length === 0) {
      actions.push('no memories yet: use mem_write to record durable context')
    }
    if (snap.indexOverBudget) {
      actions.push('index over budget: consolidate MEMORY.md (mem_budget shows exact usage)')
    }
    actions.push('mem_digest can distill the latest session log into candidate memories')
    return {
      at: this.now().toISOString(),
      pendingWrites: this.pendingWritesValue,
      noteCount: snap.notes.length,
      indexOverBudget: snap.indexOverBudget,
      needsCommit: this.pendingWritesValue > 0 || snap.indexOverBudget,
      suggestedActions: actions,
    }
  }

  /** Release held resources (FTS index). */
  dispose(): void {
    this.closeFts()
  }

  private closeFts(): void {
    if (this.fts !== null) {
      this.fts.close()
      this.fts = null
    }
  }
}

function buildFts(snapshot: Snapshot): Fts5Index {
  return new Fts5Index(snapshot.corpus)
}

function safeParse<T>(fn: () => T, path: string): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof MemoryError) throw error
    throw new MemoryError(ErrCode.E_PARSE, `failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
      details: path,
    })
  }
}


