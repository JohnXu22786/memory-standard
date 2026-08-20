/**
 * Search: a deterministic token-scoring scan, and an optional SQLite FTS5
 * index (when `node:sqlite` with FTS5 is available â€” no npm dependency).
 *
 * Engine selection is a pure function of the requested mode and FTS5
 * availability: `scan` is never upgraded; `fts5`/`auto` fall back to `scan`
 * when SQLite is unavailable. Scan uses code-point tokenization that also
 * works for CJK (unigrams + bigrams), while FTS5 uses SQLite's `unicode61`
 * tokenizer (best for whitespace/latin text â€” see SPEC.md).
 *
 * @module
 */

import type { Note, SearchMatch, SearchResult, SearchEngine, SearchMode } from '../types.js'
import { uriFor } from './format.js'
import { countChars } from './text.js'

interface Availability {
  sqlite: boolean
  fts5: boolean
}

let cachedAvailability: Availability | null = null

/** Detect whether `node:sqlite` + FTS5 are usable (probed once per process). */
function probeAvailability(): Availability {
  if (cachedAvailability !== null) return cachedAvailability
  const loader = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
  try {
    if (typeof loader !== 'function') {
      cachedAvailability = { sqlite: false, fts5: false }
      return cachedAvailability
    }
    const mod = loader('node:sqlite') as { DatabaseSync?: new (path: string) => unknown } | null
    if (mod?.DatabaseSync === undefined) {
      cachedAvailability = { sqlite: false, fts5: false }
      return cachedAvailability
    }
    const db = new mod.DatabaseSync(':memory:') as { exec: (sql: string) => void; close: () => void }
    try {
      db.exec('CREATE VIRTUAL TABLE _mm_probe USING fts5(x)')
      cachedAvailability = { sqlite: true, fts5: true }
    } catch {
      cachedAvailability = { sqlite: true, fts5: false }
    } finally {
      db.close()
    }
  } catch {
    cachedAvailability = { sqlite: false, fts5: false }
  }
  return cachedAvailability
}

/** Whether the optional FTS5 engine is available at runtime. */
export function requiresSqlite(): boolean {
  return probeAvailability().fts5
}

/**
 * Deterministic engine selection: requested `scan` always returns `scan`;
 * `fts5`/`auto` return `fts5` only when FTS5 is available.
 */
export function chooseSearchEngine(requested: SearchMode, fts5Available: boolean): SearchEngine {
  if (requested === 'scan') return 'scan'
  return fts5Available ? 'fts5' : 'scan'
}

/** Tokenization for the scan engine (handles Latin words and CJK bigrams). */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    tokens.push(match[0])
  }
  for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    const chars = Array.from(run)
    for (let i = 0; i < chars.length; i += 1) {
      tokens.push(chars[i] ?? '')
      const next = chars[i + 1]
      if (next !== undefined) tokens.push(`${chars[i] ?? ''}${next}`)
    }
  }
  return tokens
}

/** Build a weighted haystack: topic is doubled, summary/tags weighted above body. */
function weightedHaystack(note: Note): string {
  return [note.topic, note.topic, note.summary, note.tags.join(' '), note.body].join(' ').toLowerCase()
}

/** A char-bounded snippet around the first occurrence of `needle`. */
export function makeSnippet(haystack: string, needle: string, maxChars: number): string {
  const limit = Math.max(8, maxChars)
  const low = haystack.toLowerCase()
  const index = needle.length > 0 ? low.indexOf(needle.toLowerCase()) : -1
  if (index === -1 || haystack.length <= limit) {
    return countChars(haystack) > limit ? `${Array.from(haystack).slice(0, limit - 1).join('')}â€¦` : haystack
  }
  const lead = Math.max(0, Math.floor(limit / 3))
  const start = Math.max(0, index - lead)
  const chars = Array.from(haystack)
  const slice = chars.slice(start, start + limit).join('')
  const prefix = start > 0 ? 'â€¦' : ''
  const suffixLen = start + limit
  const suffix = suffixLen < chars.length ? 'â€¦' : ''
  const total = countChars(`${prefix}${slice}${suffix}`)
  if (total <= limit) return `${prefix}${slice}${suffix}`
  // trim the middle slice to fit the ellipses
  const budget = limit - (prefix ? 1 : 0) - (suffix ? 1 : 0)
  return `${prefix}${chars.slice(start, start + budget).join('')}${suffix}`
}

/** Deterministic scan search across the snapshot corpus. */
export function searchScan(notes: Note[], query: string, limit: number, maxSnippetChars: number): SearchResult {
  const qTokens = tokenize(query)
  const dedup = new Set<string>()
  for (const token of qTokens) if (token.length > 0) dedup.add(token)
  const queryTokens = [...dedup]

  const table: Array<{ note: Note; score: number; count: number }> = []
  for (const note of notes) {
    const hay = weightedHaystack(note)
    const counts = new Map<string, number>()
    for (const t of tokenize(hay)) counts.set(t, (counts.get(t) ?? 0) + 1)
    let score = 0
    for (const t of queryTokens) score += counts.get(t) ?? 0
    if (score > 0) table.push({ note, score, count: queryTokens.length })
  }
  table.sort((a, b) => (b.score - a.score) || (a.note.topic < b.note.topic ? -1 : 1))
  const total = table.length
  const truncated = total > limit
  const rows = truncated ? table.slice(0, limit) : table
  const matches: SearchMatch[] = rows.map((row) => ({
    topic: row.note.topic,
    uri: uriFor(row.note.memoryId, row.note.topic),
    updated: row.note.updated,
    score: row.score,
    snippet: makeSnippet(row.note.body.length > 0 ? row.note.body : row.note.summary, queryTokens[0] ?? '', maxSnippetChars),
  }))
  return { query, engine: 'scan', total, truncated, matches }
}

type SqliteDatabase = {
  exec: (sql: string) => void
  close: () => void
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] }
}

/** Optional full-text index backed by SQLite FTS5 (no npm dependency). */
export class Fts5Index {
  private db: SqliteDatabase

  constructor(notes: Note[]) {
    const loader = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
    if (typeof loader !== 'function') {
      throw new Error('node:sqlite unavailable')
    }
    const mod = loader('node:sqlite') as { DatabaseSync?: new (path: string) => SqliteDatabase }
    if (mod.DatabaseSync === undefined) throw new Error('node:sqlite unavailable')
    const db = new mod.DatabaseSync(':memory:')
    db.exec('CREATE VIRTUAL TABLE memfts USING fts5(topic UNINDEXED, body)')
    const insert = db.prepare('INSERT INTO memfts(topic, body) VALUES (?, ?)')
    for (const note of notes) {
      insert.run(note.topic, [note.topic, note.summary, note.tags.join(' '), note.body].join(' '))
    }
    this.db = db
  }

  /** Ranked topics for a query (best first). Returns at most `limit`. */
  search(query: string, limit: number): Array<{ topic: string; rank: number }> {
    const terms = query.trim().split(/\s+/).map((t) => `"${t.replace(/"/g, '""')}"`)
    if (terms.length === 0) return []
    const matchExpr = terms.join(' OR ')
    const rows = this.db
      .prepare('SELECT topic, rank FROM memfts WHERE memfts MATCH ? ORDER BY rank LIMIT ?')
      .all(matchExpr, Math.max(1, limit)) as Array<{ topic: string; rank: number }>
    return rows
  }

  /** Total matching rows for the same match expression (no LIMIT). */
  count(query: string): number {
    const terms = query.trim().split(/\s+/).map((t) => `"${t.replace(/"/g, '""')}"`)
    if (terms.length === 0) return 0
    const matchExpr = terms.join(' OR ')
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM memfts WHERE memfts MATCH ?').all(matchExpr)[0] as { n?: number } | undefined
    return typeof row?.n === 'number' ? row.n : 0
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}

/** FTS5 search mapped onto the shared result shape. */
export function searchFts5(
  fts: Fts5Index,
  notes: Note[],
  query: string,
  limit: number,
  maxSnippetChars: number,
  note?: string,
): SearchResult {
  const byTopic = new Map(notes.map((n) => [n.topic, n]))
  // `count` and `search` derive the SAME match expression from the raw query,
  // so total always reflects the same corpus the returned rows come from.
  const total = fts.count(query)
  const rows = fts.search(query, limit)
  const truncated = total > rows.length
  const matches: SearchMatch[] = []
  for (const row of rows) {
    const noteEntry = byTopic.get(row.topic)
    if (noteEntry === undefined) continue
    const term = query.trim().split(/\s+/)[0] ?? ''
    matches.push({
      topic: noteEntry.topic,
      uri: uriFor(noteEntry.memoryId, noteEntry.topic),
      updated: noteEntry.updated,
      score: Math.max(0, -row.rank),
      snippet: makeSnippet(noteEntry.body.length > 0 ? noteEntry.body : noteEntry.summary, term, maxSnippetChars),
    })
  }
  return { query, engine: 'fts5', total, truncated, matches, ...(note !== undefined ? { note } : {}) }
}

