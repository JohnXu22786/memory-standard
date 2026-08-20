/**
 * The Memory Standard on-disk format: parse/serialize for MEMORY.md (index)
 * and topic detail files, plus the `mm://` URI scheme.
 *
 * This module is the normative reference implementation of the format
 * documented in SPEC.md. Any tool or agent that writes files matching this
 * grammar interoperates with the memory standard — no proprietary protocol.
 *
 * Grammar summary (v1):
 * - Index file `MEMORY.md`: `# MEMORY.md` title, `> mm-*:` header meta, then a
 *   sequence of `## <topic>` sections. Inside a section, `- **key:** value`
 *   lines are metadata (summary, tags, file, updated, budget); any other line
 *   is preserved as the entry body.
 * - Detail file `memories/<topic>.md`: `# <topic>` title, `> mm-*:` header
 *   meta, then the free-form markdown body.
 * - A "character" is a Unicode code point; a "line" counts editor-displayed
 *   lines (a trailing newline does not open a new line).
 *
 * @module
 */

import { MemoryError, ErrCode } from './errors.js'
import { parseTags, countChars, byteLength, validateTopic } from './text.js'
import { FORMAT_VERSION, URI_SCHEME, TOPIC_PATTERN } from '../types.js'
import type { IndexEntry } from '../types.js'

/** Meta key set recognized inside index entries. */
const ENTRY_META_KEYS = new Set(['summary', 'tags', 'file', 'updated', 'budget'])

export interface ParsedIndexHeader {
  memoryId: string
  version: number
  kind?: string
  caps?: string
}

export interface ParsedIndex {
  header: ParsedIndexHeader
  entries: IndexEntry[]
  lineCount: number
  byteCount: number
}

export interface SerializeIndexInput {
  memoryId: string
  indexLines: number
  indexBytes: number
  entries: IndexEntry[]
}

export interface ParsedNote {
  topic: string
  body: string
  header: { memoryId?: string; version?: number }
}

/** Count editor-displayed lines: a trailing newline does not open a new line. */
export function countLines(text: string): number {
  if (text.length === 0) return 0
  let newlines = 0
  for (const ch of text) if (ch === '\n') newlines += 1
  return text.endsWith('\n') ? newlines : newlines + 1
}

/**
 * Ensure a `file:` value is a safe relative path (POSIX separators). Rejects
 * any backslash and any parent traversal so index data can never address
 * files outside the memory root. The spec mandates POSIX separators; a
 * backslash would be re-interpreted as a separator on Windows, so it is
 * rejected outright rather than normalized.
 */
export function assertSafeRelPath(rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new MemoryError(ErrCode.E_PARSE, 'file path must be a non-empty relative path')
  }
  if (rel.includes('\\')) {
    throw new MemoryError(ErrCode.E_PARSE, `file path must use POSIX separators (no backslash): ${JSON.stringify(rel)}`)
  }
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel)) {
    throw new MemoryError(ErrCode.E_PARSE, `file path must be relative, got ${JSON.stringify(rel)}`)
  }
  const segments = rel.split('/')
  if (segments.some((seg) => seg === '..')) {
    throw new MemoryError(ErrCode.E_PARSE, `file path must not traverse directories: ${JSON.stringify(rel)}`)
  }
  return rel
}

/**
 * Belt-and-braces containment guard: verify a resolved absolute path stays
 * under the memory root (tolerates both `/` and `\` separators and case, so it
 * works identically on POSIX and Windows). Call on every path derived from
 * index `file:` data.
 */
export function assertInsideRoot(root: string, full: string): void {
  const rootNorm = root.replace(/[\\/]+$/, '').toLowerCase()
  const fullNorm = full.toLowerCase()
  const under =
    fullNorm === rootNorm ||
    fullNorm.startsWith(`${rootNorm}/`) ||
    fullNorm.startsWith(`${rootNorm}\\`)
  if (!under) {
    throw new MemoryError(ErrCode.E_PARSE, `file path escapes the memory root: ${JSON.stringify(full)}`)
  }
}

function parseKeyValuePair(line: string): { key: string; value: string } | null {
  const match = /^>\s*(\S+?):\s*(.*)$/.exec(line)
  if (match === null) return null
  return { key: match[1] ?? '', value: (match[2] ?? '').trim() }
}

/** Parse the string `file` line (`memories/alpha.md`) and validate it. */
export function parseIndex(text: string, options: { memoryId?: string }): ParsedIndex {
  const lines = text.split('\n')
  let header: ParsedIndexHeader = {
    memoryId: options.memoryId ?? 'local',
    version: FORMAT_VERSION,
  }
  const entries: IndexEntry[] = []
  let i = 0

  // --- header region: everything before the first `## ` entry heading ---
  let headerText: string[] = []
  for (; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (/^##\s+\S/.test(line)) break
    headerText.push(line)
  }
  for (const line of headerText) {
    const pair = parseKeyValuePair(line)
    if (pair === null) continue
    if (pair.key === 'mm-id') header = { ...header, memoryId: pair.value }
    else if (pair.key === 'mm-version') {
      const n = Number.parseInt(pair.value, 10)
      if (!Number.isNaN(n)) header = { ...header, version: n }
    } else if (pair.key === 'mm-kind') header = { ...header, kind: pair.value }
    else if (pair.key === 'mm-caps') header = { ...header, caps: pair.value }
  }

  // --- entry sections ---
  while (i < lines.length) {
    const headingLine = lines[i] ?? ''
    const heading = /^##\s+(\S.*)$/.exec(headingLine)
    if (heading === null) {
      i += 1
      continue
    }
    const rawTopic = (heading[1] ?? '').trim()
    let topic: string
    try {
      topic = validateTopic(rawTopic)
    } catch {
      throw new MemoryError(
        ErrCode.E_PARSE,
        `index line ${i + 1}: heading ${JSON.stringify(rawTopic)} is not a valid topic slug`,
      )
    }
    i += 1
    const meta = new Map<string, string>()
    const entryBody: string[] = []
    for (; i < lines.length; i += 1) {
      const line = lines[i] ?? ''
      if (/^##\s+\S/.test(line)) break
      const metaMatch = /^-\s*\*\*(\w+):\*\*\s*(.*)$/.exec(line)
      if (metaMatch !== null && ENTRY_META_KEYS.has(metaMatch[1] ?? '')) {
        meta.set(metaMatch[1] ?? '', (metaMatch[2] ?? '').trim())
        continue
      }
      // any other line (including blank lines and unknown `- **key:**` lines)
      // is preserved verbatim as the entry body, so interop data is never lost
      entryBody.push(line)
    }
    const file = assertSafeRelPath(meta.get('file') ?? `memories/${topic}.md`)
    const budgetRaw = meta.get('budget') ?? '0/0'
    const budgetParts = /^(\d+)\/(\d+)/.exec(budgetRaw)
    entries.push({
      topic,
      memoryId: header.memoryId,
      summary: meta.get('summary') ?? '',
      tags: parseTags(meta.get('tags') ?? ''),
      file,
      updated: meta.get('updated') ?? '',
      bodyChars: budgetParts === null ? 0 : Number.parseInt(budgetParts[1] ?? '0', 10),
      writeBudget: budgetParts === null ? 0 : Number.parseInt(budgetParts[2] ?? '0', 10),
      entryBody: entryBody.join('\n').trim(),
    })
  }

  return { header, entries, lineCount: countLines(text), byteCount: byteLength(text) }
}

/** Serialize the index deterministically (entries sorted by topic). */
export function serializeIndex(input: SerializeIndexInput): string {
  const sorted = [...input.entries].sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0))
  const header = [
    '# MEMORY.md',
    '',
    'Memory Standard Index — hand-load priority; managed by dsh-memory-standard.',
    'Hard caps: ' + `${input.indexLines} lines / ${input.indexBytes} bytes. Over budget => rewrite (never truncate).`,
    '',
    `> mm-id: ${input.memoryId}`,
    `> mm-version: ${FORMAT_VERSION}`,
    '> mm-kind: index',
    `> mm-caps: ${input.indexLines} lines / ${input.indexBytes} bytes`,
    '',
  ]
  const body: string[] = []
  for (const entry of sorted) {
    body.push(`## ${entry.topic}`)
    body.push(`- **summary:** ${entry.summary}`)
    body.push(`- **tags:** ${entry.tags.join(', ')}`)
    body.push(`- **file:** ${entry.file}`)
    body.push(`- **updated:** ${entry.updated}`)
    body.push(`- **budget:** ${entry.bodyChars}/${entry.writeBudget}`)
    if ((entry.entryBody ?? '').length > 0) body.push('', ...entry.entryBody.split('\n'))
    body.push('')
  }
  const out = header.join('\n') + body.join('\n')
  return out.endsWith('\n') ? out : `${out}\n`
}

/** Serialize a detail note file. */
export function serializeNoteText(input: {
  topic: string
  memoryId: string
  file: string
  body: string
}): string {
  const body = input.body.replace(/\n+$/, '')
  const out = [
    `# ${input.topic}`,
    '',
    `> mm-id: ${input.memoryId}`,
    `> mm-version: ${FORMAT_VERSION}`,
    '> mm-kind: note',
    `> mm-topic: ${input.topic}`,
    `> mm-file: ${input.file}`,
    '',
    ...(body.length > 0 ? [body] : []),
  ].join('\n')
  return out.endsWith('\n') ? out : `${out}\n`
}

/**
 * Parse a detail note file. The header block is the leading `# ` title (when
 * present) plus the contiguous `> mm-*:` meta lines that follow; it closes at
 * the first blank line after at least one meta line, or at the first content
 * line. Everything after that boundary — including blockquotes and `#`
 * headings — is body and round-trips verbatim; only `> mm-*:` lines inside the
 * header block are meta.
 */
export function parseNoteText(text: string): ParsedNote {
  const lines = text.split('\n')
  let topic = ''
  const header: ParsedNote['header'] = {}
  // phases: pre (before any title/meta), head (title + contiguous meta lines,
  // until the closing blank), body (verbatim from the first content line)
  let phase: 'pre' | 'head' | 'body' = 'pre'
  let sawMetaInHead = false
  let bodyStart = -1
  const meta = /^>\s*(mm-[\w-]+):\s*(.*)$/
  const applyMeta = (key: string, value: string): void => {
    if (key === 'mm-topic') topic = validateTopic(value)
    else if (key === 'mm-id') header.memoryId = value
    else if (key === 'mm-version') header.version = Number.parseInt(value, 10)
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const heading = /^#\s+(.+)$/.exec(line)
    const metaMatch = meta.exec(line)
    if (phase === 'pre') {
      if (heading !== null) {
        topic = validateTopic((heading[1] ?? '').trim())
        phase = 'head'
        continue
      }
      if (metaMatch !== null) {
        applyMeta(metaMatch[1] ?? '', (metaMatch[2] ?? '').trim())
        sawMetaInHead = true
        phase = 'head'
        continue
      }
      if (line.trim().length === 0) continue
      // headerless content: the whole file is treated as body
      phase = 'body'
      bodyStart = i
      continue
    }
    if (phase === 'head') {
      if (metaMatch !== null) {
        applyMeta(metaMatch[1] ?? '', (metaMatch[2] ?? '').trim())
        sawMetaInHead = true
        continue
      }
      if (line.trim().length === 0) {
        // a blank right after the title is padding; a blank following meta
        // closes the header so body blockquotes (`> anything`) are never absorbed
        if (sawMetaInHead) {
          phase = 'body'
          bodyStart = i + 1
          continue
        }
        continue
      }
      // first content line closes the header (may itself be a `#` heading)
      phase = 'body'
      bodyStart = i
      continue
    }
    // body: everything from bodyStart onward is preserved verbatim
  }
  const body = bodyStart < 0 ? '' : lines.slice(bodyStart).join('\n').replace(/^\n+|\n+$/g, '')
  return { topic, body, header }
}

/** Canonical URI for a topic: `mm://<memoryId>/<topic>`. */
export function uriFor(memoryId: string, topic: string): string {
  validateTopic(topic)
  return `${URI_SCHEME}://${memoryId}/${topic}`
}

/**
 * Parse a memory URI. Accepts the canonical `mm://<memoryId>/<topic>` and the
 * shorthand `mm:<topic>`, enforcing the slug grammar on both components.
 * Returns null for anything else.
 */
export function parseMemoryUri(uri: string): { memoryId: string | null; topic: string } | null {
  if (typeof uri !== 'string') return null
  const slug = '[A-Za-z0-9][A-Za-z0-9._-]*'
  const canonical = new RegExp(`^mm://(${slug})/(${slug})$`).exec(uri)
  if (canonical !== null) return { memoryId: canonical[1] ?? null, topic: canonical[2] ?? '' }
  const shorthand = new RegExp(`^mm:(${slug})$`).exec(uri)
  if (shorthand !== null) return { memoryId: null, topic: shorthand[1] ?? '' }
  return null
}
