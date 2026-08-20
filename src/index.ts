/**
 * dsh bundle entry for `dsh-memory-standard`.
 *
 * This module is what the dsh (DeepSeek Harness) loader activates: it exports
 * `name`, `inject`, `Config` (a schemastery schema) and `apply(ctx, config)`
 * per the bundle contract. It wires the memory standard into a running
 * harness: registers the five mem_* tools, provides the `memory` service for
 * other plugins/agents, registers the standing "standard bit" system-prompt
 * section, and (when enabled) nudges on an interval and at session end.
 *
 * The core library (`./core/*`) is dependency-free; only this entry and the
 * dsh adapters import dsh/cordis packages, which dsh supplies.
 *
 * @module
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { Memory } from './core/memory.js'
import { registerMemoryTools } from './dsh/tools.js'
import { memoryGuideSection } from './dsh/guide.js'
import type { GuideLang } from './dsh/guide.js'
import type { SearchMode } from './types.js'
import { URI_SCHEME } from './types.js'

export const name = 'memory-standard'
// tools + systemPrompt must exist before this plugin activates.
export const inject = ['tools', 'systemPrompt']

export interface MemoryBundleConfig {
  /** Empty string resolves via DSH_MEMORY_ROOT, then $DSH_HOME/memory. */
  root: string
  memoryId: string
  indexLines: number
  indexBytes: number
  detailMaxBytes: number
  defaultWriteBudget: number
  search: { mode: SearchMode; limit: number; maxSnippetChars: number }
  nudge: { enabled: boolean; intervalMs: number }
  lang: GuideLang
}

export const Config: z<MemoryBundleConfig> = z.object({
  root: z.string().default(''),
  memoryId: z.string().default('local'),
  indexLines: z.natural().default(200),
  indexBytes: z.natural().default(25600),
  detailMaxBytes: z.natural().default(65536),
  defaultWriteBudget: z.natural().default(4000),
  search: z
    .object({
      mode: z.union(['auto', 'scan', 'fts5']).default('auto'),
      limit: z.natural().default(10),
      maxSnippetChars: z.natural().default(160),
    })
    .default({ mode: 'auto', limit: 10, maxSnippetChars: 160 }),
  nudge: z
    .object({
      enabled: z.boolean().default(false),
      intervalMs: z.natural().default(1800000),
    })
    .default({ enabled: false, intervalMs: 1800000 }),
  lang: z.union(['auto', 'en', 'zh']).default('auto'),
})

/** The minimal structural view of the harness context this bundle consumes. */
interface MemoryCtx {
  tools: { register(definition: unknown): () => void }
  systemPrompt: { section(section: { name: string; order: number; text: string }): void }
  logger: { info(message: string): void; warn(message: string): void }
  provide(name: string, value: unknown): () => void
  emit(name: string, ...args: unknown[]): void
}

export function apply(ctx: Context, config: MemoryBundleConfig): () => void {
  const mctx = ctx as unknown as MemoryCtx

  const memory = Memory.ensure({
    root: config.root.trim().length > 0 ? config.root.trim() : undefined,
    memoryId: config.memoryId,
    indexLines: config.indexLines,
    indexBytes: config.indexBytes,
    detailMaxBytes: config.detailMaxBytes,
    defaultWriteBudget: config.defaultWriteBudget,
    search: {
      mode: config.search.mode,
      limit: config.search.limit,
      maxSnippetChars: config.search.maxSnippetChars,
    },
    nudge: { enabled: config.nudge.enabled, intervalMs: config.nudge.intervalMs },
  })

  registerMemoryTools(mctx, memory)
  mctx.systemPrompt.section(memoryGuideSection(config.lang))
  mctx.provide('memory', memory)

  let timer: ReturnType<typeof setInterval> | null = null
  if (config.nudge.enabled) {
    const fire = (): void => {
      try {
        mctx.emit('memory/nudge', memory.nudge())
      } catch (error) {
        mctx.logger.warn(`memory-standard: nudge emit failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    timer = setInterval(fire, Math.max(1000, config.nudge.intervalMs))
    mctx.logger.info(`memory-standard: memory at ${memory.root}; uri scheme ${URI_SCHEME}://${config.memoryId}/<topic>`)
    fire()
  } else {
    mctx.logger.info(`memory-standard: memory at ${memory.root}; nudge disabled`)
  }

  // session end: a final nudge + resource release (runs when the plugin fiber disposes)
  const dispose = (): void => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (config.nudge.enabled) {
      try {
        mctx.emit('memory/nudge', memory.nudge())
      } catch (error) {
        mctx.logger.warn(`memory-standard: final nudge failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    memory.dispose()
  }
  return dispose
}

// Re-export the library surface so `import 'dsh-memory-standard'` also works as a library.
export * from './core/index.js'
