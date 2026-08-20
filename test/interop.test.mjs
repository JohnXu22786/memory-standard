// Cross-agent mutual recognition: the shipped identifiers (URIs), the exportable
// JSON schema, and the example memory root must all remain conformant and
// machine-readable by any compliant external tool.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Memory } from '../lib/core/index.js'
import { parseMemoryUri } from '../lib/core/format.js'
import { REPO_ROOT } from './helpers.mjs'

const EXAMPLES = join(REPO_ROOT, 'examples', 'root')

test('URI round-trips through uriFor and parseMemoryUri', () => {
  const memory = Memory.ensure({ root: join(REPO_ROOT, 'examples', 'root'), memoryId: 'local' })
  const uri = memory.uriFor('project-intro')
  assert.equal(uri, 'mm://local/project-intro')
  const parsed = parseMemoryUri(uri)
  assert.deepEqual(parsed, { memoryId: 'local', topic: 'project-intro' })
})

test('shipped JSON schema is valid JSON and declares the interop surface', () => {
  const schemaPath = join(REPO_ROOT, 'schema', 'memory.schema.json')
  assert.ok(existsSync(schemaPath))
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(schema.type, 'object')
  assert.ok(schema.required.includes('topic'))
  assert.equal(schema.properties.topic.type, 'string')
  assert.equal(schema.properties.body.type, 'string')
  assert.equal(schema.properties.file.type, 'string')
  // a conformant external writer's payload validates against the declared required fields
  const required = new Set(schema.required)
  for (const key of ['topic', 'summary', 'tags', 'file', 'updated', 'body']) {
    assert.ok(required.has(key), `schema must require ${key}`)
  }
})

test('a real produced Note validates against the shipped schema (keys + required)', () => {
  const memory = Memory.ensure({ root: join(REPO_ROOT, 'examples', 'root'), memoryId: 'local' })
  const note = memory.readTopic('project-intro')
  assert.ok(note)
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, 'schema', 'memory.schema.json'), 'utf8'))
  // every required field is actually produced
  for (const key of schema.required) {
    assert.ok(Object.hasOwn(note, key), `produced note must carry schema-required key ${key}`)
  }
  // every produced key is declared by the schema (additionalProperties: false)
  for (const key of Object.keys(note)) {
    assert.ok(key in schema.properties, `schema must declare produced key ${key}`)
  }
})

test('the shipped example memory root is a loadable, conformant memory', () => {
  assert.ok(existsSync(join(EXAMPLES, 'MEMORY.md')))
  const memory = Memory.open({ root: EXAMPLES, memoryId: 'local' })
  const notes = memory.listNotes()
  assert.ok(notes.length >= 1)
  const intro = notes.find((n) => n.topic === 'project-intro')
  assert.ok(intro, 'example index must list project-intro')
  assert.ok(intro.body.length > 0)
  // every detail file named in the index actually exists on disk
  for (const entry of memory.readIndex().entries) {
    const rel = entry.file
    assert.ok(existsSync(join(EXAMPLES, rel)), `detail file ${rel} must exist`)
  }
})

test('a detail body is plain raw markdown: a generic reader gets exact bytes', () => {
  const memory = Memory.ensure({ root: join(REPO_ROOT, 'examples', 'root'), memoryId: 'local' })
  const note = memory.readTopic('project-intro')
  const raw = readFileSync(join(EXAMPLES, 'memories', 'project-intro.md'), 'utf8')
  // a generic reader (fs/readme tool) sees the exact raw markdown body, untampered
  assert.ok(raw.includes(note.body), 'the detail file must contain the verbatim body')
  assert.ok(note.body.startsWith('本项目致力于为 dsh 生态提供统一的分层记忆标准'), 'example body must load intact')
})

test('every example directory entry is accounted for by the index', () => {
  const memory = Memory.open({ root: EXAMPLES, memoryId: 'local' })
  const indexed = new Set(memory.readIndex().entries.map((e) => e.topic))
  const detailDir = join(EXAMPLES, 'memories')
  if (existsSync(detailDir)) {
    for (const file of readdirSync(detailDir)) {
      if (!file.endsWith('.md')) continue
      const topic = file.replace(/\.md$/, '')
      assert.ok(indexed.has(topic), `detail file ${file} should be indexed`)
    }
  }
})

test('schema file path matches the package exports map', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const exported = pkg.exports['./schema/memory.schema.json']
  assert.equal(exported, './schema/memory.schema.json')
  assert.ok(existsSync(join(REPO_ROOT, exported.replace(/^\.\//, ''))))
})
