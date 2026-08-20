// Ingestion collaboration: distilling candidate memories from official dsh
// session logs or raw text via a deterministic, dependency-free entry point.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Memory } from '../lib/core/index.js'
import { tempDir, cleanup, sessionLogFixture, sessionLogFixturePath } from './helpers.mjs'

test('digest finds explicit mm: URI markers in a session log', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    const result = memory.digest({ source: sessionLogFixture() })
    assert.equal(result.sourceKind, 'session-log')
    assert.ok(Array.isArray(result.candidates))
    const uri = result.candidates.find((c) => c.topic === 'deploy-region')
    assert.ok(uri, 'expected a candidate from the mm: marker')
    assert.match(uri.body, /us-east-1/)
    // it must never write by itself
    assert.equal(memory.listNotes().length, 0)
  } finally {
    cleanup(dir)
  }
})

test('digest extracts canonical mm://<memoryId>/<topic> URIs', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    const result = memory.digest({ source: 'remember mm://local/env pin node 20\nmm://shared/ci use actions' })
    const env = result.candidates.find((c) => c.topic === 'env')
    assert.ok(env, 'canonical URI must be extracted')
    assert.equal(env.kind, 'uri')
    assert.match(env.body, /pin node 20/)
    const ci = result.candidates.find((c) => c.topic === 'ci')
    assert.ok(ci, 'a second canonical URI on its own line must be extracted')
  } finally {
    cleanup(dir)
  }
})

test('a JSON scalar or quoted-string source is classified as text, not a session log', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    assert.equal(memory.digest({ source: '42' }).sourceKind, 'text')
    assert.equal(memory.digest({ source: '"just a line"' }).sourceKind, 'text')
    assert.equal(memory.digest({ source: '[1, 2, 3]' }).sourceKind, 'text')
  } finally {
    cleanup(dir)
  }
})

test('digest reads a session log from a file path', () => {
  const dir = tempDir()
  try {
    const file = sessionLogFixturePath(dir)
    const memory = Memory.ensure({ root: dir })
    const result = memory.digest({ file })
    assert.equal(result.sourceKind, 'session-log')
    assert.ok(result.candidates.some((c) => c.topic === 'deploy-region'))
  } finally {
    cleanup(dir)
  }
})

test('digest honors maxItems and reports deterministic usage', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir, defaultWriteBudget: 2000 })
    const result = memory.digest({ source: sessionLogFixture(), maxItems: 1 })
    assert.ok(result.candidates.length <= 1)
    assert.equal(typeof result.usage.budget, 'number')
    assert.equal(typeof result.usage.chars, 'number')
    assert.ok(result.candidates.every((c) => c.budget === 2000))
  } finally {
    cleanup(dir)
  }
})

test('digest on raw text extracts explicit markers and summaries', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    const text = 'user: setup\nassistant: MEMO: keep the dependency set minimal\nassistant: 总结：核心是分层记忆。'
    const result = memory.digest({ source: text })
    assert.equal(result.sourceKind, 'text')
    const memo = result.candidates.find((c) => c.kind === 'explicit')
    assert.ok(memo)
    assert.match(memo.body, /dependency/)
    const summary = result.candidates.find((c) => c.kind === 'summary')
    assert.ok(summary)
    assert.match(summary.body, /分层记忆/)
  } finally {
    cleanup(dir)
  }
})

test('digest with no source and no session logs returns sourceKind none, no throw', () => {
  const dir = tempDir()
  try {
    const home = tempDir() // empty dsh home
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const memory = Memory.ensure({ root: dir })
      const result = memory.digest({})
      assert.equal(result.sourceKind, 'none')
      assert.deepEqual(result.candidates, [])
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      cleanup(home)
    }
  } finally {
    cleanup(dir)
  }
})

test('digest with topicHint routes explicit markers to the hinted topic', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    const result = memory.digest({ source: 'MEMO: remember this constraint', topicHint: 'constraints' })
    const memo = result.candidates[0]
    assert.equal(memo.topic, 'constraints')
  } finally {
    cleanup(dir)
  }
})

test('candidate body never exceeds the write budget (proposal trimming)', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir, defaultWriteBudget: 60 })
    const long = 'MEMO: ' + 'word '.repeat(200)
    const result = memory.digest({ source: long })
    const memo = result.candidates[0]
    assert.ok(memo.chars <= 60)
    assert.equal(memo.overBudget, true)
  } finally {
    cleanup(dir)
  }
})
