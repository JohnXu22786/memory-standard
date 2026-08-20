/**
 * The five model-facing memory tools, registered on `ctx.tools` as dsh tools:
 * mem_read, mem_write, mem_search, mem_budget, mem_digest.
 *
 * Reads serve the frozen snapshot; writes persist to disk with deterministic
 * budgets (over-budget is a structured `ok:false` result carrying usage, never
 * a truncation); digest never writes â€” it returns candidates to review.
 *
 * @module
 */

import type { Memory } from '../core/memory.js'
import { validateTopic } from '../core/text.js'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'

/** Type a per-property parameter map for defineTool, preserving literal inference. */
function parameters<const S extends ParameterSchemaSpec>(fields: S): S {
  return fields
}

/** Register all five tools against `memory`. */
export function registerMemoryTools(ctx: { tools: { register(definition: unknown): () => void } }, memory: Memory): void {
  const tools = buildToolDefinitions(memory)
  for (const definition of tools) {
    ctx.tools.register(definition)
  }
}

function buildToolDefinitions(memory: Memory) {
  const memRead = defineTool({
    name: 'mem_read',
    description:
      'Read memory. Omit `topic` to read the index (hand-loaded MEMORY.md); use `topic: all` for the index plus every note summary; pass a topic slug to read that noteâ€™s full body. Serves the frozen session snapshot.',
    parameters: parameters({
      topic: {
        type: 'string',
        description: 'Topic slug to read in full, or the literal `all`; omit to read the index.',
      },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          topic: { type: 'string' },
          uri: { type: 'string' },
          found: { type: 'boolean' },
          note: { type: 'json' },
          index: { type: 'json' },
          entries: { type: 'json' },
        },
      },
      render: (_args, value: any) => [{ type: 'text' as const, text: renderMemRead(value) }],
    },
    async execute(args): Promise<any> {
      const target = args.topic === undefined ? '' : args.topic.trim()
      if (target === 'all') {
        const index = memory.readIndex()
        const entries = memory.listNotes().map((n) => ({ topic: n.topic, uri: n.uri, summary: n.summary, updated: n.updated, bodyChars: n.bodyChars }))
        return { kind: 'all', index: summarizeIndex(index), entries }
      }
      if (target === '') {
        const index = memory.readIndex()
        return { kind: 'index', index: summarizeIndex(index), entries: index.entries.map((e) => ({ topic: e.topic, uri: memory.uriFor(e.topic), summary: e.summary, updated: e.updated, bodyChars: e.bodyChars })) }
      }
      validateTopic(target)
      const note = memory.readTopic(target)
      return { kind: 'note', topic: target, uri: memory.uriFor(target), found: note !== undefined, note: note ?? null }
    },
  })

  const memWrite = defineTool({
    name: 'mem_write',
    description:
      'Write (create or update) a memory note for `topic`. `content` is free markdown (ä¸­æ–‡/English). An explicit `budget` (characters) defaults to the configured write budget. On over-budget the tool returns ok:false with usage metrics â€” read `usage.overflow`, compress `content`, and retry; memory is never silently truncated. Writes persist to disk now and load next session.',
    parameters: parameters({
      topic: { type: 'string', required: true, description: 'Topic slug for the note (ASCII slug; content may be any language).' },
      content: { type: 'string', required: true, description: 'Note body in markdown.' },
      budget: { type: 'number', description: 'Character budget (Unicode code points) for this write.' },
      summary: { type: 'string', description: 'One-line summary stored in the index.' },
      tags: { type: 'string', description: 'Comma-separated tags.' },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          code: { type: 'string' },
          message: { type: 'string' },
          reason: { type: 'string' },
          topic: { type: 'string' },
          uri: { type: 'string' },
          action: { type: 'string' },
          pendingWrites: { type: 'integer' },
          usage: { type: 'json' },
        },
      },
      render: (_args, value: any) => [{ type: 'text' as const, text: renderMemWrite(value) }],
    },
    async execute(args): Promise<any> {
      validateTopic(args.topic)
      return memory.write({
        topic: args.topic,
        content: args.content,
        budget: args.budget,
        summary: args.summary,
        tags: args.tags,
      })
    },
  })

  const memSearch = defineTool({
    name: 'mem_search',
    description:
      'Search memory. `mode`: auto (SQLite FTS5 when available, else scan), fts5, or scan. `limit` caps returned matches. Serves the frozen snapshot.',
    parameters: parameters({
      query: { type: 'string', required: true, description: 'Search terms.' },
      mode: { type: 'string', enum: ['auto', 'fts5', 'scan'] as const, description: 'Engine: auto/scan work for CJK; fts5 suits latin text. Default auto.' },
      limit: { type: 'number', description: 'Maximum matches to return.' },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          engine: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          note: { type: 'string' },
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                topic: { type: 'string' },
                uri: { type: 'string' },
                updated: { type: 'string' },
                score: { type: 'number' },
                snippet: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value: any) => [{ type: 'text' as const, text: renderMemSearch(value) }],
    },
    async execute(args): Promise<any> {
      return memory.search(args.query, { mode: args.mode, limit: args.limit })
    },
  })

  const memBudget = defineTool({
    name: 'mem_budget',
    description:
      'Report deterministic memory budgets: index lines/bytes vs hard caps, per-note character budget usage, pending writes since the snapshot, search engine, and index anomalies. Use it before compressing or when a write reports over-budget.',
    parameters: parameters({}),
    output: {
      schema: { type: 'json' },
      render: (_args, value: any) => [{ type: 'text' as const, text: renderMemBudget(value) }],
    },
    async execute(): Promise<any> {
      return memory.budget()
    },
  })

  const memDigest = defineTool({
    name: 'mem_digest',
    description:
      'Distill candidate memories from a session log or text (official compaction/session logs are recognized as memory sources). `source` is inline text, `file` is a path; with neither, the latest $DSH_HOME/sessions log is used when present. Returns candidates with deterministic budgets â€” it never writes; review them and call mem_write for the ones worth keeping.',
    parameters: parameters({
      source: { type: 'string', description: 'Raw text to distill (e.g. compaction transcript).' },
      file: { type: 'string', description: 'Path to a session log / transcript file.' },
      maxItems: { type: 'number', description: 'Maximum candidate count.' },
      topicHint: { type: 'string', description: 'Preferred topic slug for marker-derived candidates.' },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          sourceKind: { type: 'string', required: true },
          note: { type: 'string', required: true },
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                topic: { type: 'string' },
                kind: { type: 'string' },
                summary: { type: 'string' },
                body: { type: 'string' },
                chars: { type: 'integer' },
                budget: { type: 'integer' },
                overBudget: { type: 'boolean' },
              },
            },
          },
          usage: { type: 'json' },
        },
      },
      render: (_args, value: any) => [{ type: 'text' as const, text: renderMemDigest(value) }],
    },
    async execute(args): Promise<any> {
      return memory.digest({ source: args.source, file: args.file, maxItems: args.maxItems, topicHint: args.topicHint })
    },
  })

  return [memRead, memWrite, memSearch, memBudget, memDigest]
}

function summarizeIndex(index: ReturnType<Memory['readIndex']>) {
  return {
    memoryId: index.memoryId,
    root: index.root,
    loadedAt: index.loadedAt,
    lineCount: index.lineCount,
    byteCount: index.byteCount,
    lineCap: index.lineCap,
    byteCap: index.byteCap,
    overBudget: index.overBudget,
    entries: index.entries.length,
  }
}

function renderMemRead(value: Record<string, unknown>): string {
  const kind = value.kind as string | undefined
  if (kind === 'note') {
    const note = value.note as { topic?: string; summary?: string; tags?: string[]; updated?: string; body?: string } | null
    if (note === null) return '(not found)'
    const tags = (note.tags ?? []).join(', ')
    return ['# ' + (note.topic ?? ''), 'summary: ' + (note.summary ?? ''), tags.length > 0 ? 'tags: ' + tags : '', 'updated: ' + (note.updated ?? ''), '', note.body ?? ''].join('\n').replace(/\n{3,}/g, '\n\n')
  }
  const index = value.index as { lineCount?: number; byteCount?: number; overBudget?: boolean; entries?: number } | undefined
  const entries = value.entries as Array<{ topic?: string; summary?: string }> | undefined
  const lines = [
    `Memory index (${index?.entries ?? 0} entries, ${index?.lineCount ?? 0} lines / ${index?.byteCount ?? 0} bytes; ${index?.overBudget ? 'OVER BUDGET' : 'within caps'}):`,
    '',
    ...(entries ?? []).map((e) => `- ${e.topic ?? ''}${e.summary ? ` â€” ${e.summary}` : ''}`),
  ]
  return lines.join('\n')
}

function renderMemWrite(value: Record<string, unknown>): string {
  if (value.ok !== true) {
    const usage = value.usage as { bodyChars?: number; writeBudget?: number; overflow?: number } | undefined
    return [
      `memory write refused: ${String(value.reason ?? value.message ?? '')}`,
      `code: ${String(value.code ?? '')}`,
      usage ? `usage: ${usage.bodyChars ?? 0} chars / budget ${usage.writeBudget ?? 0} (overflow ${usage.overflow ?? 0}) â€” compress and retry` : '',
    ].join('\n')
  }
  return `wrote ${String(value.action ?? 'updated')} memory ${String(value.topic ?? '')} (${String(value.uri ?? '')}); ${String(value.pendingWrites ?? 0)} pending write(s) since snapshot`
}

function renderMemSearch(value: Record<string, unknown>): string {
  const matches = value.matches as Array<{ topic?: string; snippet?: string }> | undefined
  if ((value.total as number | undefined) === 0) return `no matches for ${String(value.query)}`
  const lines = [`${value.total} match(es) via ${String(value.engine)} (${String(value.query)}):`, '']
  for (const m of matches ?? []) lines.push(`- ${m.topic ?? ''}: ${m.snippet ?? ''}`)
  return lines.join('\n')
}

function renderMemBudget(value: Record<string, unknown>): string {
  const index = value.index as { entries?: number; lines?: number; bytes?: number; lineCap?: number; byteCap?: number; overBudget?: boolean } | undefined
  const detail = value.detail as { noteCount?: number; totalBodyChars?: number; totalBytes?: number; maxBytes?: number } | undefined
  const perTopic = value.perTopic as Array<{ topic?: string; bodyChars?: number; writeBudget?: number; budgetUsedPct?: number }> | undefined
  const lines = [
    `memory root: ${String(value.root ?? '')}`,
    `snapshot: ${String(value.loadedAt ?? '')} (${String(value.pendingWrites ?? 0)} pending write(s))`,
    `index: ${index?.entries ?? 0} entries, ${index?.lines ?? 0}/${index?.lineCap ?? 0} lines, ${index?.bytes ?? 0}/${index?.byteCap ?? 0} bytes${index?.overBudget ? ' â€” OVER BUDGET' : ''}`,
    `notes: ${detail?.noteCount ?? 0}, ${detail?.totalBodyChars ?? 0} chars / ${detail?.totalBytes ?? 0} bytes (max ${detail?.maxBytes ?? 0}/file)`,
    '',
    ...(perTopic ?? []).map((t) => `- ${t.topic ?? ''}: ${t.bodyChars ?? 0}/${t.writeBudget ?? 0} chars (${t.budgetUsedPct ?? 0}%)`),
  ]
  return lines.join('\n')
}

function renderMemDigest(value: Record<string, unknown>): string {
  const candidates = value.candidates as Array<{ topic?: string; summary?: string; chars?: number; budget?: number }> | undefined
  if ((value.sourceKind as string | undefined) === 'none') return `no memory source available: ${String(value.note ?? '')}`
  const lines = [
    `digest from ${String(value.source ?? '')} â€” ${(candidates ?? []).length} candidate(s); review and mem_write the ones worth keeping:`,
    '',
    ...(candidates ?? []).map((c) => `- [${c.topic ?? ''}] ${c.summary ?? ''} (${c.chars ?? 0}/${c.budget ?? 0} chars)`),
  ]
  return lines.join('\n')
}

