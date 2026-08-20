/**
 * Deterministic budget accounting.
 *
 * The standard never truncates: exceeding a budget is a structured failure,
 * and the returned usage metrics let the caller compress immediately. These
 * helpers measure the (already consistent) index text and note text so write
 * and report paths share one arithmetic.
 *
 * @module
 */

import { countLines } from './format.js'
import { byteLength } from './text.js'
import type { IndexUsage } from '../types.js'

/** Line/byte usage of a serialized index against its hard caps. */
export function computeIndexUsage(text: string, indexLines: number, indexBytes: number): IndexUsage {
  const entryCount = (text.match(/^##\s+\S/gm) ?? []).length
  const lines = countLines(text)
  const bytes = byteLength(text)
  const overBudget = lines > indexLines || bytes > indexBytes
  return {
    entries: entryCount,
    lines,
    bytes,
    lineCap: indexLines,
    byteCap: indexBytes,
    overBudget,
    overflowLines: Math.max(0, lines - indexLines),
    overflowBytes: Math.max(0, bytes - indexBytes),
  }
}

/** Percentage of per-write budget consumed (clamped to 0..100, rounded). */
export function budgetUsedPct(chars: number, budget: number): number {
  if (budget <= 0) return 0
  const pct = Math.round((chars / budget) * 100)
  return Math.min(100, Math.max(0, pct))
}
