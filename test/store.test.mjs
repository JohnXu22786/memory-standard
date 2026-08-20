// Layered store: MEMORY.md index + per-topic detail files; write/read/update/
// delete lifecycle and anomaly tolerance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Memory, MemoryError } from '../lib/core/index.js'
import { tempDir, cleanup, readFile, fileExists } from './helpers.mjs'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

test('write creates a detail file and an index entry; read returns the exact body', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir, memoryId: 'local', now: () => new Date('2026-01-01T00:00:00Z') })
    const outcome = memory.write({ topic: 'project-intro', content: '第一行\n\n第二行 with 中文', summary: '项目介绍', tags: 'project, goals' })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.action, 'created')
    assert.equal(outcome.uri, 'mm://local/project-intro')
    assert.equal(fileExists(dir, 'memories/project-intro.md'), true)
    assert.equal(readFile(dir, 'MEMORY.md').includes('## project-intro'), true)

    // frozen snapshot sees the write? No — snapshot is loaded at construction.
    // A freshly-opened memory (as a fresh process/session would) sees it.
    const fresh = Memory.open({ root: dir, memoryId: 'local' })
    const note = fresh.readTopic('project-intro')
    assert.equal(note.body, '第一行\n\n第二行 with 中文')
    assert.equal(note.summary, '项目介绍')
    assert.deepEqual(note.tags, ['project', 'goals'])
    assert.equal(note.updated, '2026-01-01T00:00:00.000Z')
    assert.equal(note.uri, 'mm://local/project-intro')
  } finally {
    cleanup(dir)
  }
})

test('listNotes returns all topics sorted by name', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    for (const t of ['zeta', 'alpha', 'mid']) memory.write({ topic: t, content: `body ${t}` })
    const fresh = Memory.open({ root: dir })
    const topics = fresh.listNotes().map((n) => n.topic)
    assert.deepEqual(topics, ['alpha', 'mid', 'zeta'])
  } finally {
    cleanup(dir)
  }
})

test('updating a topic replaces the body and bumps updated, keeping one entry', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir, now: () => new Date('2026-01-01T00:00:00Z') })
    memory.write({ topic: 'alpha', content: 'v1', summary: 'old' })
    memory.write({ topic: 'alpha', content: 'v2', summary: 'new' })
    const fresh = Memory.open({ root: dir })
    assert.equal(fresh.readTopic('alpha').body, 'v2')
    assert.equal(fresh.readTopic('alpha').summary, 'new')
    assert.equal(fresh.listNotes().length, 1)
    assert.equal(fresh.readTopic('alpha').updated, '2026-01-01T00:00:00.000Z')
  } finally {
    cleanup(dir)
  }
})

test('delete removes the detail file and the index entry', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    memory.write({ topic: 'alpha', content: 'body' })
    memory.write({ topic: 'beta', content: 'body' })
    const out = memory.delete('alpha')
    assert.equal(out.ok, true)
    assert.equal(out.removed, true)
    assert.equal(fileExists(dir, 'memories/alpha.md'), false)
    const fresh = Memory.open({ root: dir })
    assert.equal(fresh.listNotes().length, 1)
    assert.equal(fresh.readTopic('beta').topic, 'beta')
  } finally {
    cleanup(dir)
  }
})

test('deleting a missing topic reports ok=true, removed=false', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    const out = memory.delete('nope')
    assert.equal(out.ok, true)
    assert.equal(out.removed, false)
  } finally {
    cleanup(dir)
  }
})

test('a dangling index entry (missing detail file) is reported, not fatal', () => {
  const dir = tempDir()
  try {
    // simulate an index entry whose detail file was deleted out of band
    const memory = Memory.ensure({ root: dir })
    memory.write({ topic: 'alpha', content: 'body' })
    rmSync(`${dir}/memories/alpha.md`, { force: true }) // remove the detail file out-of-band
    const fresh = Memory.open({ root: dir })
    const note = fresh.readTopic('alpha')
    assert.equal(note.body, '') // no content available; entry still listed
    assert.equal(note.missingFile, true)
    assert.equal(fresh.budget().anomalies.danglingEntries, 1)
  } finally {
    cleanup(dir)
  }
})

test('reading an unknown topic returns undefined', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    assert.equal(memory.readTopic('ghost'), undefined)
  } finally {
    cleanup(dir)
  }
})

test('writing to an uninitialized root auto-initializes it', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    assert.equal(fileExists(dir, 'MEMORY.md'), true)
    assert.equal(memory.initialized, true)
  } finally {
    cleanup(dir)
  }
})

test('a note whose body opens with a "> mm-" blockquote round-trips', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    const body = '> mm-not-really-meta: this is body text\n\nand more body'
    const out = memory.write({ topic: 'alpha', content: body })
    assert.equal(out.ok, true)
    memory.reload()
    assert.equal(memory.readTopic('alpha').body, body)
  } finally {
    cleanup(dir)
  }
})

test('delete removes a detail file placed at a custom file: path', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    memory.write({ topic: 'alpha', content: 'body' })
    // simulate an external writer that moved/renamed the detail file and
    // updated the index entry's file: field to a custom safe sub-path
    const moved = `${dir}/memories/custom-alpha.md`
    mkdirSync(dirname(moved), { recursive: true })
    writeFileSync(moved, '# alpha\n\nbody', 'utf8')
    rmSync(`${dir}/memories/alpha.md`, { force: true })
    const externalIndex = readFile(dir, 'MEMORY.md').replace('memories/alpha.md', 'memories/custom-alpha.md')
    writeFileSync(`${dir}/MEMORY.md`, externalIndex, 'utf8')

    const fresh = Memory.open({ root: dir })
    assert.equal(fresh.readTopic('alpha').body, 'body')
    const d = fresh.delete('alpha')
    assert.equal(d.ok, true)
    assert.equal(fileExists(dir, 'memories/custom-alpha.md'), false)
  } finally {
    cleanup(dir)
  }
})
