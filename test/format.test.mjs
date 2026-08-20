// Format contract: the public markdown grammar must round-trip and must accept
// hand-written (external-agent) compliant files through the public read path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Memory, MemoryError } from '../lib/core/index.js'
import { parseIndex, serializeIndex, parseNoteText, serializeNoteText, parseMemoryUri, assertSafeRelPath } from '../lib/core/format.js'
import { countChars, byteLength, slugForTopic, validateTopic } from '../lib/core/text.js'
import { tempDir, cleanup, writeFile } from './helpers.mjs'

test('serialize/parse round-trips index entries losslessly', () => {
  const entries = [
    {
      topic: 'alpha',
      memoryId: 'local',
      summary: 'First topic',
      tags: ['a', 'b'],
      file: 'memories/alpha.md',
      updated: '2026-01-02T03:04:05.000Z',
      bodyChars: 10,
      writeBudget: 4000,
    },
    {
      topic: 'zeta',
      memoryId: 'local',
      summary: 'Second topic',
      tags: ['c'],
      file: 'memories/zeta.md',
      updated: '2026-01-03T00:00:00.000Z',
      bodyChars: 0,
      writeBudget: 1000,
    },
  ]
  const text = serializeIndex({ memoryId: 'local', indexLines: 200, indexBytes: 25600, entries })
  const parsed = parseIndex(text, { memoryId: 'local' })
  assert.deepEqual(parsed.entries.map((e) => e.topic), ['alpha', 'zeta'])
  assert.equal(parsed.entries[0].summary, 'First topic')
  assert.deepEqual(parsed.entries[0].tags, ['a', 'b'])
  assert.equal(parsed.entries[0].file, 'memories/alpha.md')
  assert.equal(parsed.entries[0].updated, '2026-01-02T03:04:05.000Z')
  assert.equal(parsed.entries[0].bodyChars, 10)
  assert.equal(parsed.entries[0].writeBudget, 4000)
})

test('index parser accepts a hand-written external-agent MEMORY.md', () => {
  const index = [
    '# MEMORY.md',
    '',
    'Memory Standard Index.',
    '',
    '> mm-id: local',
    '> mm-version: 1',
    '> mm-kind: index',
    '',
    '## alpha',
    '- **summary:** First topic.',
    '- **tags:** a, b',
    '- **file:** memories/alpha.md',
    '- **updated:** 2026-01-02T03:04:05.000Z',
    '- **budget:** 10/4000',
    '',
    'A short body note.',
    '',
    '## beta',
    '- **summary:** Second topic.',
    '- **tags:** c',
    '- **file:** memories/beta.md',
    '- **updated:** 2026-01-03T00:00:00.000Z',
    '- **budget:** 0/4000',
    '',
  ].join('\n')
  const parsed = parseIndex(index, { memoryId: 'local' })
  assert.equal(parsed.header.memoryId, 'local')
  assert.equal(parsed.header.version, 1)
  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.entries[1].topic, 'beta')
})

test('note text round-trips through parseNoteText/serializeNoteText', () => {
  const body = 'first line\n\nsecond line with 中文 and emoji 🎉'
  const text = serializeNoteText({ topic: 'alpha', memoryId: 'local', file: 'memories/alpha.md', body })
  const parsed = parseNoteText(text)
  assert.equal(parsed.topic, 'alpha')
  assert.equal(parsed.body, body.trim())
})

test('a fully hand-written memory root is readable like a native one', () => {
  const dir = tempDir()
  try {
    writeFile(dir, 'MEMORY.md', [
      '# MEMORY.md', '', '> mm-id: local', '> mm-version: 1', '> mm-kind: index', '',
      '## alpha',
      '- **summary:** External summary.',
      '- **tags:** ext',
      '- **file:** memories/alpha.md',
      '- **updated:** 2026-05-05T00:00:00.000Z',
      '- **budget:** 6/4000', '',
      'external body',
    ].join('\n'))
    writeFile(dir, 'memories/alpha.md', ['# alpha', '', '> mm-version: 1', '> mm-kind: note', '', 'external body'].join('\n'))
    const memory = Memory.open({ root: dir, memoryId: 'local' })
    const note = memory.readTopic('alpha')
    assert.equal(note.body, 'external body')
    assert.equal(note.summary, 'External summary.')
    assert.equal(memory.uriFor('alpha'), 'mm://local/alpha')
  } finally {
    cleanup(dir)
  }
})

test('URI scheme parses canonical and shorthand forms', () => {
  assert.deepEqual(parseMemoryUri('mm://local/alpha'), { memoryId: 'local', topic: 'alpha' })
  assert.deepEqual(parseMemoryUri('mm:beta'), { memoryId: null, topic: 'beta' })
  assert.equal(parseMemoryUri('http://x/y'), null)
  assert.equal(parseMemoryUri('mm:///alpha'), null)
})

test('character count uses code points; byte length uses UTF-8', () => {
  assert.equal(countChars('中文🎉'), 3)
  assert.equal('中文🎉'.length, 4) // UTF-16 units differ: this is the point
  assert.equal(byteLength('中文🎉'), 6 + 4)
})

test('topic validation rejects invalid slugs and traversal', () => {
  assert.throws(() => validateTopic('../evil'), MemoryError)
  assert.throws(() => validateTopic('a/b'), MemoryError)
  assert.throws(() => validateTopic(''), MemoryError)
  assert.throws(() => validateTopic('a'.repeat(65)), MemoryError)
  assert.equal(validateTopic('alpha-beta_1.x'), 'alpha-beta_1.x')
})

test('slugForTopic produces safe filenames', () => {
  assert.equal(slugForTopic('Hello World!'), 'hello-world')
  assert.equal(slugForTopic('alpha'), 'alpha')
})

test('a note body may contain "#" headings (title is only the leading line)', () => {
  const dir = tempDir()
  try {
    const memory = Memory.ensure({ root: dir })
    const body = 'Intro line\n\n# Section One\n\nbody of section one\n\n## Sub section\n\ndetails'
    const out = memory.write({ topic: 'alpha', content: body })
    assert.equal(out.ok, true)
    memory.reload()
    assert.equal(memory.readTopic('alpha').body, body)
  } finally {
    cleanup(dir)
  }
})

test('a hand-written note whose body contains "#" headings loads correctly', () => {
  const dir = tempDir()
  try {
    writeFile(dir, 'memories/alpha.md', [
      '# alpha', '', '> mm-id: local', '> mm-version: 1', '> mm-kind: note', '',
      'lead', '', '# A section in the body', '', 'stuff', '',
    ].join('\n'))
    writeFile(dir, 'MEMORY.md', [
      '# MEMORY.md', '', '> mm-id: local', '> mm-version: 1', '> mm-kind: index', '',
      '## alpha',
      '- **summary:** s', '- **tags:**', `- **file:** memories/alpha.md`,
      '- **updated:** 2026-01-01T00:00:00.000Z', '- **budget:** 0/4000', '',
    ].join('\n'))
    const memory = Memory.open({ root: dir, memoryId: 'local' })
    const note = memory.readTopic('alpha')
    assert.equal(note.body, 'lead\n\n# A section in the body\n\nstuff')
  } finally {
    cleanup(dir)
  }
})

test('index file paths with backslashes are rejected (Windows traversal guard)', () => {
  assert.throws(() => assertSafeRelPath('memories\\..\\evil.md'), MemoryError)
  assert.throws(() => assertSafeRelPath('..\\evil.md'), MemoryError)
  assert.throws(() => assertSafeRelPath('memories/../evil.md'), MemoryError)
  assert.throws(() => assertSafeRelPath('C:\\evil.md'), MemoryError)
  assert.equal(assertSafeRelPath('memories/alpha.md'), 'memories/alpha.md')
})

test('a malicious backslash file: value cannot be loaded from disk', () => {
  const dir = tempDir()
  try {
    writeFile(dir, 'MEMORY.md', [
      '# MEMORY.md', '', '> mm-id: local', '', '## leaker',
      `- **file:** memories\\..\\escape.txt`, '', '',
    ].join('\n'))
    // the index must not even parse a `file:` that could traverse the root
    assert.throws(() => Memory.open({ root: dir, memoryId: 'local' }), MemoryError)
  } finally {
    cleanup(dir)
  }
})

test('URI parsing enforces the slug grammar on both components', () => {
  assert.equal(parseMemoryUri('mm://local/..'), null)
  assert.equal(parseMemoryUri('mm://local/-abc'), null)
  assert.equal(parseMemoryUri('mm:../x'), null)
  assert.equal(parseMemoryUri('mm://..local/a'), null)
})
