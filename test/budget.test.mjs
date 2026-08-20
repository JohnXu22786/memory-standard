// Deterministic budgets: over-budget is a structured failure with usage
// metrics, never a silent truncation, and no partial writes to disk.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Memory } from '../lib/core/index.js'
import { tempDir, cleanup, readFile, fileExists } from './helpers.mjs'

test('write over the per-call char budget fails with usage metrics and no file write', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir, defaultWriteBudget: 4000 })
    const outcome = memory.write({ topic: 'alpha', content: 'x'.repeat(4001) })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'E_WRITE_BUDGET_EXCEEDED')
    assert.equal(outcome.usage.overflow, 1)
    assert.equal(outcome.usage.bodyChars, 4001)
    assert.equal(outcome.usage.writeBudget, 4000)
    // deterministic: nothing written, no detail file, index untouched
    assert.equal(fileExists(dir, 'memories/alpha.md'), false)
    assert.equal(readFile(dir, 'MEMORY.md').includes('alpha'), false)
  } finally {
    cleanup(dir)
  }
})

test('an explicit per-call budget overrides the default', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir, defaultWriteBudget: 4000 })
    const outcome = memory.write({ topic: 'alpha', content: 'y'.repeat(100), budget: 50 })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.usage.writeBudget, 50)
    assert.equal(outcome.usage.overflow, 50)
  } finally {
    cleanup(dir)
  }
})

test('writing exactly at the budget boundary succeeds', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir, defaultWriteBudget: 4000 })
    const outcome = memory.write({ topic: 'alpha', content: 'z'.repeat(4000) })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.usage.overflow, 0)
  } finally {
    cleanup(dir)
  }
})

test('index line hard cap produces an error demanding a rewrite, never truncation', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir, indexLines: 12, indexBytes: 10 * 1024 })
    // header occupies several lines; keep writing short topics until the cap trips
    let last
    for (let i = 0; i < 10; i += 1) {
      last = memory.write({ topic: `t${i}`, content: `content ${i}` })
      if (last.ok === false) break
    }
    assert.equal(last.ok, false)
    assert.equal(last.code, 'E_INDEX_BUDGET_EXCEEDED')
    assert.match(last.message, /rewrite/i)
    assert.equal(typeof last.usage.index.lines, 'number')
    assert.equal(typeof last.usage.index.lineCap, 'number')
    assert.equal(last.usage.index.overBudget, true)
  } finally {
    cleanup(dir)
  }
})

test('index byte hard cap errors and leaves the on-disk index unchanged', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir, indexBytes: 220 })
    const before = readFile(dir, 'MEMORY.md')
    const outcome = memory.write({ topic: 'alpha', content: 'a'.repeat(400), summary: 's'.repeat(120) })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'E_INDEX_BUDGET_EXCEEDED')
    // no truncation: file bytes identical to before the attempt
    assert.equal(readFile(dir, 'MEMORY.md'), before)
    assert.equal(fileExists(dir, 'memories/alpha.md'), false)
  } finally {
    cleanup(dir)
  }
})

test('detail file byte cap errors without truncating an existing note', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir, detailMaxBytes: 120 })
    const first = memory.write({ topic: 'alpha', content: 'hello world' })
    assert.equal(first.ok, true)
    memory.reload() // commit the seeded write into the snapshot
    // a rewrite that would push the note over its byte cap must fail
    const big = memory.write({ topic: 'alpha', content: 'x'.repeat(500) })
    assert.equal(big.ok, false)
    assert.equal(big.code, 'E_FILE_BUDGET_EXCEEDED')
    // previous content preserved (never truncated away)
    assert.equal(memory.readTopic('alpha').body, 'hello world')
  } finally {
    cleanup(dir)
  }
})

test('a consolidation write is allowed once it fits the caps again', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir, indexLines: 20 })
    let last
    for (let i = 0; i < 10; i += 1) {
      last = memory.write({ topic: `t${i}`, content: `content ${i}` })
      if (last.ok === false) break
    }
    assert.equal(last.ok, false)
    assert.equal(last.code, 'E_INDEX_BUDGET_EXCEEDED')
    // deleting one entry shrinks the index; the next write must then fit
    const removed = memory.delete('t0')
    assert.equal(removed.ok, true)
    const again = memory.write({ topic: 'fresh', content: 'new' })
    assert.equal(again.ok, true)
  } finally {
    cleanup(dir)
  }
})

test('budget report exposes deterministic usage counters', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir, defaultWriteBudget: 500 })
    memory.write({ topic: 'alpha', content: 'x'.repeat(120), summary: 's' })
    const report = memory.budget()
    assert.equal(report.index.entries, 1)
    assert.equal(report.index.lineCap, 200)
    assert.equal(report.index.byteCap, 25600)
    assert.equal(report.detail.noteCount, 1)
    assert.equal(report.perTopic[0].bodyChars, 120)
    assert.equal(report.perTopic[0].writeBudget, 500)
    assert.equal(report.pendingWrites, 1) // staged by this session since the snapshot
  } finally {
    cleanup(dir)
  }
})

test('an over-budget index stays recoverable through deletes (no delete catch-22)', () => {
  const dir = tempDir()
  try {
    // grow a full index under generous caps
    const writer = Memory.ensure({ root: dir })
    for (let i = 0; i < 10; i += 1) writer.write({ topic: `t${i}`, content: `content ${i}` })
    // re-open with a tiny cap so the existing index is several entries over
    const memory = Memory.open({ root: dir, indexLines: 20 })
    assert.equal(memory.budget().index.overBudget, true)
    // deletes must be allowed even while still over budget (monotonic recovery)
    const d0 = memory.delete('t0')
    assert.equal(d0.ok, true)
    assert.equal(memory.budget().index.overBudget, true)
    for (let i = 1; i < 10; i += 1) {
      const d = memory.delete(`t${i}`)
      assert.equal(d.ok, true)
    }
    assert.equal(memory.budget().index.overBudget, false)
    // once the index fits, additions are accepted again
    const again = memory.write({ topic: 'fresh', content: 'new' })
    assert.equal(again.ok, true)
  } finally {
    cleanup(dir)
  }
})
