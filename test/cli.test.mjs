// CLI contract: spawn the real binary against a temp root and assert exit
// codes, JSON output, and budget-error behavior.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir, cleanup, readFile } from './helpers.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'cli.js')

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  })
  return { code: res.status, stdout: res.stdout, stderr: res.stderr }
}

test('cli init creates the memory root and prints its path', () => {
  const dir = tempDir()
  try {
    const { code, stdout } = run(['init', '--root', dir])
    assert.equal(code, 0)
    assert.match(stdout, /MEMORY\.md/)
  } finally {
    cleanup(dir)
  }
})

test('cli write + read round-trips content', () => {
  const dir = tempDir()
  try {
    const w = run(['write', 'alpha', '--content', 'hello world', '--summary', 'First', '--tags', 'a,b', '--root', dir, '--json'])
    assert.equal(w.code, 0)
    const out = JSON.parse(w.stdout)
    assert.equal(out.ok, true)
    assert.equal(out.usage.bodyChars, 11)

    const r = run(['read', 'alpha', '--root', dir, '--json'])
    assert.equal(r.code, 0)
    const note = JSON.parse(r.stdout)
    assert.equal(note.body, 'hello world')
    assert.equal(note.summary, 'First')
  } finally {
    cleanup(dir)
  }
})

test('cli list and budget reflect a written topic', () => {
  const dir = tempDir()
  try {
    run(['write', 'alpha', '--content', 'x', '--root', dir])
    const list = run(['list', '--root', dir, '--json'])
    assert.equal(list.code, 0)
    assert.deepEqual(JSON.parse(list.stdout).topics, ['alpha'])

    const b = run(['budget', '--root', dir, '--json'])
    assert.equal(b.code, 0)
    const report = JSON.parse(b.stdout)
    assert.equal(report.index.entries, 1)
  } finally {
    cleanup(dir)
  }
})

test('cli search finds written content', () => {
  const dir = tempDir()
  try {
    run(['write', 'deploy', '--content', 'we deploy to us-east-1', '--root', dir])
    const s = run(['search', 'us-east-1', '--root', dir, '--json'])
    assert.equal(s.code, 0)
    const res = JSON.parse(s.stdout)
    assert.ok(res.matches.some((m) => m.topic === 'deploy'))
  } finally {
    cleanup(dir)
  }
})

test('cli write over budget exits non-zero and reports overflow', () => {
  const dir = tempDir()
  try {
    const w = run(['write', 'alpha', '--content', '12345', '--budget', '3', '--root', dir, '--json'])
    assert.equal(w.code, 1)
    const parsed = JSON.parse(w.stdout)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.code, 'E_WRITE_BUDGET_EXCEEDED')
    assert.equal(parsed.usage.overflow, 2)
    assert.match(parsed.message, /budget/i)
    // nothing was written
    assert.equal(readFile(dir, 'MEMORY.md').includes('alpha'), false)
  } finally {
    cleanup(dir)
  }
})

test('cli delete removes the topic', () => {
  const dir = tempDir()
  try {
    run(['write', 'alpha', '--content', 'x', '--root', dir])
    const d = run(['delete', 'alpha', '--root', dir, '--json'])
    assert.equal(d.code, 0)
    const r = run(['read', 'alpha', '--root', dir])
    assert.equal(r.code, 1) // not found -> non-zero
  } finally {
    cleanup(dir)
  }
})

test('cli digest prints candidates for a file source', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'session.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, [
      JSON.stringify({ type: 'session/user', content: { text: 'remember mm:deploy-region region is us-east-1' } }),
    ].join('\n'), 'utf8')
    const d = run(['digest', '--file', file, '--root', dir, '--json'])
    assert.equal(d.code, 0)
    const res = JSON.parse(d.stdout)
    assert.ok(Array.isArray(res.candidates))
    assert.ok(res.candidates.some((c) => c.topic === 'deploy-region'))
  } finally {
    cleanup(dir)
  }
})
