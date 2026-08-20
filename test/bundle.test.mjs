// Bundle-entry contract: the compiled dsh bundle (lib/index.js) must export
// name/inject/Config/apply and, when applied, register the five mem_* tools,
// register the system-prompt section, provide the `memory` service, and return
// a disposer. Uses a minimal fake ctx (the entry only calls a small, documented
// surface: tools.register, systemPrompt.section, logger, provide, emit).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tempDir, cleanup } from './helpers.mjs'

const bundle = await import(new URL('../lib/index.js', import.meta.url))

function fakeContext() {
  const registered = []
  const sections = []
  const provided = {}
  const emitted = []
  return {
    state: { registered, sections, provided, emitted },
    ctx: {
      tools: { register: (def) => { registered.push(def); return () => {} } },
      systemPrompt: { section: (s) => { sections.push(s) } },
      logger: { info: () => {}, warn: () => {} },
      provide: (name, value) => { provided[name] = value; return () => {} },
      emit: (name, ...args) => { emitted.push([name, args]) },
    },
  }
}

test('bundle entry exports the dsh contract', () => {
  assert.equal(bundle.name, 'memory-standard')
  assert.ok(Array.isArray(bundle.inject))
  assert.ok(bundle.inject.includes('tools'))
  assert.ok(bundle.inject.includes('systemPrompt'))
  assert.equal(typeof bundle.apply, 'function')
  assert.equal(typeof bundle.Config, 'function')
})

test('Config validates and applies defaults', () => {
  const config = bundle.Config(undefined)
  for (const key of ['root', 'memoryId', 'indexLines', 'indexBytes', 'detailMaxBytes', 'defaultWriteBudget', 'search', 'nudge', 'lang']) {
    assert.ok(key in config, `default ${key} must be present`)
  }
  assert.equal(config.indexLines, 200)
  assert.equal(config.memoryId, 'local')
  assert.equal(config.search.mode, 'auto')
})

test('apply registers five tools, a guidance section, and the memory service; returns a disposer', () => {
  const dir = tempDir()
  try {
    const app = fakeContext()
    const dispose = bundle.apply(app.ctx, { ...bundle.Config(undefined), root: dir, nudge: { enabled: true, intervalMs: 5000 } })
    assert.equal(typeof dispose, 'function')
    assert.equal(app.state.registered.length, 5)
    const names = app.state.registered.map((t) => t.name).sort()
    assert.deepEqual(names, ['mem_budget', 'mem_digest', 'mem_read', 'mem_search', 'mem_write'])
    assert.equal(app.state.sections.length, 1)
    assert.equal(app.state.sections[0].name, 'memory-standard')
    assert.ok(app.state.provided.memory, 'memory service must be provided')
    const memory = app.state.provided.memory
    const outcome = memory.write({ topic: 'smoke', content: 'bundle works' })
    assert.equal(outcome.ok, true)
    assert.equal(memory.pendingWrites, 1)
    memory.reload()
    assert.equal(memory.readTopic('smoke').body, 'bundle works')
    dispose()
  } finally {
    cleanup(dir)
  }
})

test('package.json declares the dsh bundle patch and exports map ships the schema', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(pkg.dsh, { bundle: { patch: './cordis.patch.yml' } })
  assert.equal(pkg.exports['./schema/memory.schema.json'], './schema/memory.schema.json')
})
