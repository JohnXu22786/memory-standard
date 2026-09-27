// Search: deterministic ranking (scan) and optional SQLite FTS5, with a
// guaranteed fallback when FTS5 is unavailable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Memory } from '../lib/core/index.js'
import { chooseSearchEngine, requiresSqlite } from '../lib/core/search.js'
import { tempDir, cleanup } from './helpers.mjs'

function seeded(dir, search = { mode: 'scan' }) {
  const m = Memory.ensure({ root: dir, search })
  m.write({ topic: 'deploy', content: 'we deploy to us-east-1 using github actions', summary: 'Deployment notes' })
  m.write({ topic: 'auth', content: 'the auth system uses OAuth 2.0 and JWT', summary: 'Auth design' })
  m.write({ topic: 'ui', content: 'the UI is a react app', summary: 'Frontend' })
  m.reload() // commit the seeded writes into the snapshot
  return m
}

test('scan search ranks a topic/summary hit above a body-only hit', () => {
  const dir = tempDir()
  try {
    const m = seeded(dir)
    const res = m.search('deploy', { mode: 'scan' })
    assert.equal(res.engine, 'scan')
    assert.equal(res.matches[0].topic, 'deploy')
    assert.ok(res.matches[0].score > 0)
  } finally {
    cleanup(dir)
  }
})

test('multi-term scan search finds documents containing any term', () => {
  const dir = tempDir()
  try {
    const m = seeded(dir)
    const res = m.search('oauth jwt', { mode: 'scan', limit: 10 })
    assert.ok(res.matches.some((x) => x.topic === 'auth'))
    assert.ok(res.total >= 1)
  } finally {
    cleanup(dir)
  }
})

test('no-match returns total 0 and empty matches', () => {
  const dir = tempDir()
  try {
    const m = seeded(dir)
    const res = m.search('zzzznothing', { mode: 'scan' })
    assert.equal(res.total, 0)
    assert.deepEqual(res.matches, [])
  } finally {
    cleanup(dir)
  }
})

test('limit and truncation flag are respected', () => {
  const dir = tempDir()
  try {
    const m = seeded(dir)
    const res = m.search('the', { mode: 'scan', limit: 1 })
    assert.equal(res.matches.length, 1)
    assert.equal(res.truncated, true)
  } finally {
    cleanup(dir)
  }
})

test('fts5 search path works when node:sqlite is available', { skip: !requiresSqlite() }, () => {
  const dir = tempDir()
  try {
    const m = seeded(dir)
    const res = m.search('us-east-1', { mode: 'fts5' })
    assert.equal(res.engine, 'fts5')
    assert.ok(res.matches.some((x) => x.topic === 'deploy'))
  } finally {
    cleanup(dir)
  }
})

test('auto mode selects fts5 when available, scan otherwise', () => {
  const available = requiresSqlite()
  const dir = tempDir()
  try {
    const m = seeded(dir, { mode: 'auto' })
    assert.equal(m.engine, available ? 'fts5' : 'scan')
    const res = m.search('react', { mode: 'auto' })
    assert.equal(res.engine, available ? 'fts5' : 'scan')
    assert.ok(res.matches.some((x) => x.topic === 'ui'))
  } finally {
    cleanup(dir)
  }
})

test('requested scan mode is never upgraded to fts5', () => {
  const dir = tempDir()
  try {
    const m = seeded(dir)
    const res = m.search('deploy', { mode: 'scan' })
    assert.equal(res.engine, 'scan')
  } finally {
    cleanup(dir)
  }
})

test('search engine selection is deterministic regardless of availability', () => {
  assert.equal(chooseSearchEngine('scan', false), 'scan')
  assert.equal(chooseSearchEngine('scan', true), 'scan')
  assert.equal(chooseSearchEngine('fts5', true), 'fts5')
  assert.equal(chooseSearchEngine('fts5', false), 'scan')
  assert.equal(chooseSearchEngine('auto', true), 'fts5')
  assert.equal(chooseSearchEngine('auto', false), 'scan')
})

test('snippets are bounded to maxSnippetChars', () => {
  const dir = tempDir()
  try {
    const m = Memory.ensure({ root: dir, search: { mode: 'scan', maxSnippetChars: 12 } })
    m.write({ topic: 'alpha', content: 'another very long body that should be truncated safely, containing term' })
    m.reload()
    const res = m.search('term', { mode: 'scan' })
    assert.ok(res.matches.length === 1)
    assert.ok(res.matches[0].snippet.length <= 12)
  } finally {
    cleanup(dir)
  }
})

test('fts5 search with a multi-word query does not throw', { skip: !requiresSqlite() }, () => {
  const dir = tempDir()
  try {
    const m = seeded(dir)
    const res = m.search('deploy actions', { mode: 'fts5' })
    assert.equal(res.engine, 'fts5')
    assert.ok(Array.isArray(res.matches))
  } finally {
    cleanup(dir)
  }
})

test('fts5 reports the uncapped total and truncation flag', { skip: !requiresSqlite() }, () => {
  const dir = tempDir()
  try {
    const m = Memory.ensure({ root: dir })
    for (let i = 0; i < 20; i += 1) {
      m.write({ topic: `doc-${i}`, content: `commonterm unique-${i}` })
    }
    m.reload()
    const res = m.search('commonterm', { mode: 'fts5', limit: 5 })
    assert.equal(res.total, 20)
    assert.equal(res.truncated, true)
    assert.equal(res.matches.length, 5)
  } finally {
    cleanup(dir)
  }
})

test('fts5 total agrees with matches even when prose contains the word "or"', { skip: !requiresSqlite() }, () => {
  const dir = tempDir()
  try {
    const m = Memory.ensure({ root: dir })
    m.write({ topic: 'deploy', content: 'we deploy via actions' })
    m.write({ topic: 'notes', content: 'a container holding the word or inside' })
    m.write({ topic: 'other', content: 'a second deploy note' })
    m.reload()
    const res = m.search('deploy actions', { mode: 'fts5' })
    assert.equal(res.total, res.matches.length, 'count must match the same match expression as search')
    assert.ok(res.matches.some((x) => x.topic === 'deploy'))
  } finally {
    cleanup(dir)
  }
})
