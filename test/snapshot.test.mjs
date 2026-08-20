// Snapshot semantics: reads freeze the session-start snapshot (protecting the
// prompt cache); writes persist to disk and become visible only after reload /
// a fresh process. Cross-process durability: a fresh reader sees disk truth.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Memory, MemoryError } from '../lib/core/index.js'
import { tempDir, cleanup } from './helpers.mjs'

test('reads are frozen: writes do not mutate the served snapshot', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    memory.write({ topic: 'alpha', content: 'seeded' })
    // ...seeded by an earlier session portrayed by reload():
    memory.reload()

    const beforeWrite = memory.readTopic('alpha').body
    const out = memory.write({ topic: 'beta', content: 'brand new' })
    assert.equal(out.ok, true)

    // the frozen snapshot still reports only alpha
    assert.deepEqual(memory.listNotes().map((n) => n.topic), ['alpha'])
    assert.equal(memory.readTopic('beta'), undefined)
    assert.equal(memory.readTopic('alpha').body, beforeWrite)
    assert.equal(memory.pendingWrites, 1)
  } finally {
    cleanup(dir)
  }
})

test('search is also served from the frozen snapshot', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    memory.reload()
    memory.write({ topic: 'alpha', content: 'needle in the haystack' })
    // not visible to the session snapshot yet
    assert.equal(memory.search('needle').total, 0)
    memory.reload()
    assert.equal(memory.search('needle').total, 1)
  } finally {
    cleanup(dir)
  }
})

test('reload picks up disk state and resets pending writes', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    memory.write({ topic: 'alpha', content: 'v1' })
    assert.equal(memory.pendingWrites, 1)
    memory.reload()
    assert.equal(memory.pendingWrites, 0)
    assert.equal(memory.readTopic('alpha').body, 'v1')
  } finally {
    cleanup(dir)
  }
})

test('writes persist across processes: a fresh reader sees new memory', () => {
  const dir = tempDir()
  try {
    const writer = Memory.ensure({ root: dir })
    writer.write({ topic: 'alpha', content: 'persisted truth' })
    writer.delete('alpha')
    writer.write({ topic: 'alpha', content: 'persisted truth v2' })

    const reader = Memory.open({ root: dir, memoryId: 'local' })
    assert.equal(reader.readTopic('alpha').body, 'persisted truth v2')
    assert.equal(reader.loaded, true)
    assert.equal(typeof reader.loadedAt, 'string')
  } finally {
    cleanup(dir)
  }
})

test('opening a missing root errors deterministically', () => {
  const dir = tempDir()
  try {
    assert.throws(() => Memory.open({ root: `${dir}/nope` }), MemoryError)
  } finally {
    cleanup(dir)
  }
})

test('reload after external edit (another agent) surfaces it', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    memory.write({ topic: 'alpha', content: 'before' })
    memory.reload()
    // external writer appends a new topic directly to disk
    const ext = Memory.open({ root: dir })
    ext.write({ topic: 'beta', content: 'from another agent' })
    assert.equal(memory.readTopic('beta'), undefined) // frozen
    memory.reload()
    assert.equal(memory.readTopic('beta').body, 'from another agent') // synced
  } finally {
    cleanup(dir)
  }
})

test('nudge report reflects session staging deterministically', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    const idle = memory.nudge()
    assert.equal(idle.pendingWrites, 0)
    assert.equal(idle.needsCommit, false)
    memory.write({ topic: 'alpha', content: 'something to remember' })
    const busy = memory.nudge()
    assert.equal(busy.pendingWrites, 1)
    assert.equal(busy.needsCommit, true)
    assert.ok(Array.isArray(busy.suggestedActions))
  } finally {
    cleanup(dir)
  }
})
