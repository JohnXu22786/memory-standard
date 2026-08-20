/**
 * Text measurement and identifier utilities.
 *
 * A "character" in this standard is a Unicode code point (what humans read);
 * a "byte" is a UTF-8 byte. Distinguishing the two keeps the deterministic
 * budgets correct for CJK and astral-plane content (e.g. emoji).
 *
 * @module
 */

import { MemoryError, ErrCode } from './errors.js'
import { TOPIC_MAX_LENGTH, TOPIC_PATTERN } from '../types.js'

/** Count Unicode code points (characters), not UTF-16 code units. */
export function countChars(value: string): number {
  return Array.from(value).length
}

/** Count UTF-8 bytes. */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Build a valid topic slug from free text (used by digest for heading-derived
 * topics and by CLI convenience paths). Returns null when nothing usable
 * remains.
 */
export function slugForTopic(value: string): string | null {
  const cleaned = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  if (cleaned.length === 0 || !TOPIC_PATTERN.test(cleaned)) return null
  return cleaned.slice(0, TOPIC_MAX_LENGTH)
}

/**
 * Validate a topic slug. Throws {@link MemoryError} (E_INVALID) when invalid.
 * Returns the topic unchanged. Slugs are deliberately portable ASCII: a topic
 * becomes a filename and a URI segment, so it must not need escaping.
 */
export function validateTopic(topic: string): string {
  if (typeof topic !== 'string') {
    throw new MemoryError(ErrCode.E_INVALID, 'topic must be a string')
  }
  if (topic.length === 0) {
    throw new MemoryError(ErrCode.E_INVALID, 'topic must not be empty')
  }
  if (topic.length > TOPIC_MAX_LENGTH) {
    throw new MemoryError(ErrCode.E_INVALID, `topic must be at most ${TOPIC_MAX_LENGTH} characters`)
  }
  if (!TOPIC_PATTERN.test(topic)) {
    throw new MemoryError(
      ErrCode.E_INVALID,
      `topic ${JSON.stringify(topic)} is not a valid slug: use letters, digits, '.', '_' and '-' (no separators, no leading separators)`,
    )
  }
  return topic
}

/** First non-blank line of a value, truncated to `limit` characters. */
export function firstLine(value: string, limit = 200): string {
  const line = value.split('\n', 1)[0] ?? ''
  return countChars(line) > limit ? `${Array.from(line).slice(0, limit).join('')}…` : line
}

/** Normalize and trim a single-line field (summary). */
export function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Normalize a comma/space separated tag string into a clean list. */
export function parseTags(value: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value.split(/[,，;；]/)) {
    const tag = raw.trim().replace(/\s+/g, '-').toLowerCase()
    if (tag.length > 0 && !seen.has(tag)) {
      seen.add(tag)
      out.push(tag)
    }
  }
  return out
}
