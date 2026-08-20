/**
 * Ingestion collaboration: distill candidate memories from official dsh
 * session logs or raw text. This is an *entry point* — it never writes; the
 * caller (agent/tool) reviews the candidates and calls `mem_write` for the
 * ones worth keeping. The extraction is dependency-free and deterministic; it
 * recognizes the de facto session-log shape instead of depending on the full
 * session subsystem.
 *
 * @module
 */

import { accessSync, constants, openSync, readdirSync, readSync, statSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryError, ErrCode } from './errors.js'
import { countChars, firstLine, slugForTopic } from './text.js'
import { dshHome } from './paths.js'
import { parseMemoryUri } from './format.js'
import { DEFAULT_WRITE_BUDGET } from '../types.js'
import type { DigestCandidate, DigestResult, DigestSourceKind } from '../types.js'

/** Upper bound on a single digest source read (keeps big logs tractable). */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024

const EXPLICIT_RE = /(?:^|[^\p{L}\p{N}])(?:MEMO|记忆|记住|REMEMBER)[：:]\s*(.*)$/iu
const SUMMARY_RE = /(?:^|[^\p{L}\p{N}])(?:Summary|Conclusion|总结|结论)[：:]\s*(.*)$/iu
const HEADING_RE = /^(#{2,3})\s+(.+)$/
// matches both canonical `mm://<memoryId>/<topic>` and shorthand `mm:<topic>`
const URI_RE = /\bmm:(?:\/\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*)/g

export interface DigestInput {
  /** Raw text to distill (e.g. a compaction transcript or pasted log). */
  source?: string
  /** Path to a session log / transcript file. */
  file?: string
  /** Maximum candidate count. */
  maxItems?: number
  /** Topic slug to prefer for marker-derived candidates. */
  topicHint?: string
  /** Write budget applied to proposal trimming. */
  defaultWriteBudget?: number
}

/** Locate the most recent session log under `$DSH_HOME/sessions`. */
export function resolveSessionLog(): string | null {
  const sessionsDir = join(dshHome(), 'sessions')
  let names: string[]
  try {
    names = readdirSync(sessionsDir)
  } catch {
    return null
  }
  let best: { name: string; mtime: number } | null = null
  for (const name of names) {
    if (!/\.(jsonl|json|md)$/.test(name)) continue
    const full = join(sessionsDir, name)
    let mtime: number
    try {
      mtime = statSync(full).mtimeMs
    } catch {
      continue
    }
    // deterministic: newest mtime wins, ties broken by lexical name
    if (best === null || mtime > best.mtime || (mtime === best.mtime && name < best.name)) {
      best = { name, mtime }
    }
  }
  return best === null ? null : join(sessionsDir, best.name)
}

/** Read at most `cap` bytes of a file as UTF-8. */
function readCapped(path: string, cap = MAX_SOURCE_BYTES): string {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const len = Math.min(size, cap)
    const buffer = Buffer.alloc(len)
    let offset = 0
    while (offset < len) {
      const read = readSync(fd, buffer, offset, len - offset, offset)
      if (read <= 0) break
      offset += read
    }
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function fileExists(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** Classify a source as a JSONL session log, plain text, or nothing. */
function classifySource(input: DigestInput): { kind: DigestSourceKind; content: string; label: string } {
  if (input.file !== undefined && input.file.length > 0) {
    const path = input.file
    if (!fileExists(path)) {
      throw new MemoryError(ErrCode.E_DIGEST_SOURCE, `digest source file not found: ${path}`)
    }
    const content = readCapped(path)
    return { kind: sniff(content), content, label: path }
  }
  if (input.source !== undefined && input.source.trim().length > 0) {
    const content = input.source
    return { kind: sniff(content), content, label: '<text>' }
  }
  const candidate = resolveSessionLog()
  if (candidate === null) {
    return { kind: 'none', content: '', label: '<none>' }
  }
  const content = readCapped(candidate)
  return { kind: sniff(content), content, label: candidate }
}

function sniff(content: string): DigestSourceKind {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed)
      // a session log is lines of JSON objects with a `type` discriminator;
      // scalars/arrays (e.g. `42`, `"text"`) are ordinary text
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'type' in parsed) {
        return 'session-log'
      }
    } catch {
      return 'text'
    }
    return 'text'
  }
  return 'text'
}

/** Flatten one JSONL record into a readable line (type + text-bearing fields). */
function flattenRecord(line: string): string {
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return line.trim()
  }
  if (record === null || typeof record !== 'object') return line.trim()
  const rec = record as Record<string, unknown>
  const parts: string[] = []
  const seen = new WeakSet<object>()
  collectStrings(rec, parts, seen)
  const type = typeof rec.type === 'string' && rec.type.length > 0 ? rec.type : ''
  const joined = parts.join(' | ').trim()
  return joined.length === 0 ? (type ?? '') : type.length > 0 ? `${type} ${joined}` : joined
}

const TEXT_KEYS = new Set(['content', 'text', 'value', 'input', 'message', 'transcript'])
const SKIP_KEYS = new Set(['type', 'id', 'time', 'timestamp', 'callId', 'traceId'])

function collectStrings(node: unknown, out: string[], seen: WeakSet<object>, depth = 0): void {
  if (depth > 8 || (typeof node === 'object' && node !== null && seen.has(node))) return
  if (typeof node === 'string') {
    const trimmed = node.trim()
    if (trimmed.length > 0) out.push(trimmed)
    return
  }
  if (typeof node !== 'object' || node === null) return
  seen.add(node)
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out, seen, depth + 1)
    return
  }
  const rec = node as Record<string, unknown>
  for (const key of TEXT_KEYS) {
    const value = rec[key]
    if (value !== undefined) collectStrings(value, out, seen, depth + 1)
  }
  for (const [key, value] of Object.entries(rec)) {
    if (TEXT_KEYS.has(key) || SKIP_KEYS.has(key)) continue
    collectStrings(value, out, seen, depth + 1)
  }
}

interface Extracted {
  candidates: DigestCandidate[]
}

/** Extract commit-worthy candidates from distilled text line by line. */
function extractCandidates(lines: string[], input: Required<Pick<DigestInput, 'topicHint'>>, budget: number): Extracted {
  const candidates: DigestCandidate[] = []
  const seen = new Set<string>()
  let memoN = 0
  let summaryN = 0
  let activeHeading: { topic: string; body: string[] } | null = null

  const add = (candidate: DigestCandidate): void => {
    if (seen.has(candidate.topic)) return
    // proposal trimming to the write budget is fine: digest never writes
    const chars = countChars(candidate.body)
    const over = chars > budget
    const body = over ? Array.from(candidate.body).slice(0, budget).join('') : candidate.body
    seen.add(candidate.topic)
    candidates.push({ ...candidate, body, chars: countChars(body), overBudget: over })
  }

  const flushHeading = (): void => {
    if (activeHeading === null) return
    const body = activeHeading.body.join('\n').trim()
    if (body.length > 0) {
      add({ topic: activeHeading.topic, kind: 'heading', summary: firstLine(body), body, chars: 0, budget, overBudget: false })
    }
    activeHeading = null
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    // explicit mm: URI in the line wins, carrying the rest of the line as body
    URI_RE.lastIndex = 0
    const uriMatches = [...line.matchAll(URI_RE)]
    if (uriMatches.length > 0) {
      const m0 = uriMatches[0] as RegExpMatchArray
      const parsed = parseMemoryUri(m0[0])
      if (parsed !== null && parsed.topic.length > 0) {
        const after = (m0.index ?? 0) + m0[0].length
        const body = line.slice(after).replace(/^[\s,:：-]+/, '').trim() || firstLine(trimmed) || m0[0]
        add({ topic: parsed.topic, kind: 'uri', summary: firstLine(body), body, chars: 0, budget, overBudget: false })
      }
      continue
    }

    // heading lines (only in markdown-ish sources)
    const heading = HEADING_RE.exec(trimmed)
    if (heading !== null && (heading[1] ?? '').length >= 2 && heading[2] !== undefined) {
      flushHeading()
      const slug = slugForTopic(heading[2])
      if (slug !== null) activeHeading = { topic: slug, body: [] }
      continue
    }
    if (activeHeading !== null) {
      activeHeading.body.push(trimmed)
      continue
    }

    const explicit = EXPLICIT_RE.exec(trimmed)
    if (explicit !== null) {
      const body = (explicit[1] ?? '').trim()
      if (body.length > 0) {
        memoN += 1
        add({
          topic: input.topicHint && input.topicHint.length > 0 ? input.topicHint : `memo-${memoN}`,
          kind: 'explicit',
          summary: firstLine(body),
          body,
          chars: 0,
          budget,
          overBudget: false,
        })
      }
      continue
    }

    const summary = SUMMARY_RE.exec(trimmed)
    if (summary !== null) {
      const body = (summary[1] ?? '').trim()
      if (body.length > 0) {
        summaryN += 1
        add({
          topic: `summary-${summaryN}`,
          kind: 'summary',
          summary: firstLine(body),
          body,
          chars: 0,
          budget,
          overBudget: false,
        })
      }
      continue
    }
  }
  flushHeading()

  // canonical order: uri, explicit, summary, heading — then encounter order
  const priority: Record<DigestCandidate['kind'], number> = { uri: 0, explicit: 1, summary: 2, heading: 3 }
  candidates.sort((a, b) => (priority[a.kind] - priority[b.kind]) || 0)
  return { candidates }
}

/** Distill a text/transcript into candidate memory items. */
export function distill(content: string, input: DigestInput): DigestResult {
  const budget = Number.isInteger(input.defaultWriteBudget) && (input.defaultWriteBudget ?? 0) > 0
    ? (input.defaultWriteBudget as number)
    : DEFAULT_WRITE_BUDGET
  const maxItems = Number.isInteger(input.maxItems) && (input.maxItems ?? 0) > 0 ? (input.maxItems as number) : 50

  const lines = content.split('\n').map((l) => l.trimEnd())
  const { candidates } = extractCandidates(lines, { topicHint: input.topicHint ?? '' }, budget)
  const limited = candidates.slice(0, maxItems)

  return {
    source: '',
    sourceKind: 'text',
    candidates: limited,
    usage: {
      chars: limited.reduce((sum, c) => sum + c.chars, 0),
      budget,
      overflow: Math.max(0, limited.reduce((sum, c) => sum + c.chars, 0) - budget),
    },
    note: 'digest never writes; review candidates and call mem_write for the ones worth keeping.',
  }
}

/** Public entry: classify a source, distill it, return structured candidates. */
export function digest(input: DigestInput = {}): DigestResult {
  const { kind, content, label } = classifySource(input)
  if (kind === 'none') {
    return {
      source: '<none>',
      sourceKind: 'none',
      candidates: [],
      usage: { chars: 0, budget: DEFAULT_WRITE_BUDGET, overflow: 0 },
      note: 'no session log located under $DSH_HOME/sessions and no explicit source given; pass `source` or `file`.',
    }
  }
  const lines = kind === 'session-log' ? content.split('\n').map(flattenRecord) : content.split('\n')
  const text = lines.join('\n')
  const result = distill(text, input)
  return { ...result, source: label, sourceKind: kind }
}
