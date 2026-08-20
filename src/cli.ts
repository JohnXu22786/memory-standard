#!/usr/bin/env node
/**
 * `dsh-memory` — standalone CLI for the Memory Standard.
 *
 * The CLI is an external observer: every invocation is a fresh, live memory
 * (writes are immediately visible), unlike an in-session agent whose reads use
 * the frozen snapshot. Pure Node + node:sqlite optionally; no npm runtime
 * dependencies.
 *
 * @module
 */

import { Memory } from './core/memory.js'
import { MemoryError } from './core/errors.js'

// node:sqlite is experimental; suppress its one-time warning so CLI stderr stays
// clean for scripts (the engine still probes and uses FTS5 exactly as before).
const originalEmitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const name = typeof warning === 'object' && warning !== null ? (warning as { name?: string }).name ?? '' : ''
  const message = typeof warning === 'string' ? warning : (warning as { message?: string }).message ?? ''
  if (name === 'ExperimentalWarning' && /SQLite/i.test(message)) return
  if (typeof warning === 'string' && /\x53QLite is an experimental feature/i.test(warning)) return
  return (originalEmitWarning as (warning: string | Error, ...rest: unknown[]) => void)(warning, ...rest)
}) as typeof process.emitWarning

interface Args {
  flags: Map<string, string | boolean>
  positionals: string[]
}

const HELP = `dsh-memory — Memory Standard Protocol CLI

Usage:
  dsh-memory init [--root PATH] [--json]
  dsh-memory write <topic> --content TEXT [--budget N] [--summary S] [--tags T] [--root PATH] [--json]
  dsh-memory read [topic] [--all] [--root PATH] [--json]
  dsh-memory list [--root PATH] [--json]
  dsh-memory search <query> [--mode auto|scan|fts5] [--limit N] [--root PATH] [--json]
  dsh-memory budget [--root PATH] [--json]
  dsh-memory digest [--file PATH] [--text TEXT] [--max-items N] [--topic-hint S] [--root PATH] [--json]
  dsh-memory delete <topic> [--root PATH] [--json]
  dsh-memory uri <topic> [--root PATH]
  dsh-memory help

Topics are ASCII slugs (content may be any language). Budgets are deterministic:
an over-budget write errors with usage metrics and never truncates.
`

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>()
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        flags.set(arg.slice(0, eq), arg.slice(eq + 1))
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          // boolean-ish flags that take no value
          const valueless = new Set(['--json', '--all'])
          if (valueless.has(arg)) {
            flags.set(arg, true)
          } else {
            flags.set(arg, next)
            i += 1
          }
        } else {
          flags.set(arg, true)
        }
      }
    } else {
      positionals.push(arg)
    }
  }
  return { flags, positionals }
}

function flagStr(args: Args, name: string): string | undefined {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

function flagBool(args: Args, name: string): boolean {
  return args.flags.get(name) === true || flagStr(args, name) === 'true'
}

/** A non-negative integer flag, or undefined when not provided; fails on garbage. */
function intFlag(args: Args, name: string): number | undefined {
  const raw = flagStr(args, name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) fail(`${name} expects a non-negative integer (got "${raw}")`)
  return n
}

function fail(message: string, code = 1): never {
  process.stderr.write(`dsh-memory: ${message}\n`)
  process.exit(code)
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 0)}\n`)
}

function rootFromArgs(args: Args): string | undefined {
  const root = flagStr(args, '--root')
  return root !== undefined && root.length > 0 ? root : undefined
}

function openMemory(args: Args): Memory {
  return Memory.ensure({ root: rootFromArgs(args) })
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  const command = args.positionals[0]
  const rest = args.positionals.slice(1)
  const json = flagBool(args, '--json')

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP)
      return

    case 'init': {
      const memory = Memory.ensure({ root: rootFromArgs(args) })
      if (json) printJson({ ok: true, root: memory.root, files: ['MEMORY.md', 'memories/'] })
      else process.stdout.write(`initialized memory root at ${memory.root} (MEMORY.md + memories/)\n`)
      return
    }
    case 'write': {
      const topic = rest[0] ?? fail('write requires a <topic>')
      const content = flagStr(args, '--content') ?? fail('write requires --content TEXT')
      const budget = intFlag(args, '--budget')
      const memory = openMemory(args)
      let outcome
      try {
        outcome = memory.write({
          topic,
          content,
          budget,
          summary: flagStr(args, '--summary'),
          tags: flagStr(args, '--tags'),
        })
      } catch (error) {
        if (error instanceof MemoryError) fail(error.message)
        throw error
      }
      if (outcome.ok) {
        if (json) printJson(outcome)
        else process.stdout.write(`${outcome.action} ${outcome.uri}\n`)
        return
      }
      if (json) printJson(outcome)
      else process.stderr.write(`dsh-memory: ${outcome.message}\n`)
      process.exitCode = 1
      return
    }

    case 'read': {
      const memory = openMemory(args)
      if (rest[0] !== undefined) {
        const topic = rest[0]
        try {
          const note = memory.readTopic(topic)
          if (note === undefined) {
            if (json) printJson({ found: false, topic, uri: memory.uriFor(topic) })
            else process.stderr.write(`dsh-memory: no note for topic ${topic}\n`)
            process.exitCode = 1
            return
          }
          if (json) printJson(note)
          else {
            process.stdout.write(`# ${note.topic}\n\nsummary: ${note.summary || '-'}\ntags: ${note.tags.join(', ') || '-'}\nupdated: ${note.updated}\n\n${note.body}\n`)
          }
          return
        } catch (error) {
          if (error instanceof MemoryError) fail(error.message)
          throw error
        }
      }
      const index = memory.readIndex()
      const all = flagBool(args, '--all')
      if (json) {
        if (all) printJson({ index, notes: memory.listNotes() })
        else printJson(index)
        return
      }
      const entries = all ? memory.listNotes() : index.entries
      const lines = [`Memory index (${index.entries.length} entries, ${index.lineCount} lines / ${index.byteCount} bytes${index.overBudget ? ' — OVER BUDGET' : ''}):`, '']
      for (const e of entries) {
        lines.push(`- ${e.topic}${e.summary ? ` — ${e.summary}` : ''}`)
      }
      process.stdout.write(`${lines.join('\n')}\n`)
      return
    }

    case 'list': {
      const memory = openMemory(args)
      const notes = memory.listNotes()
      const topics = notes.map((n) => n.topic)
      if (json) printJson({ topics, count: topics.length, notes: notes.map((n) => ({ topic: n.topic, uri: n.uri, summary: n.summary, updated: n.updated })) })
      else process.stdout.write(`${topics.length === 0 ? '(no notes)' : topics.join('\n')}\n`)
      return
    }

    case 'search': {
      const query = rest[0] ?? fail('search requires a <query>')
      const modeArg = flagStr(args, '--mode') ?? 'auto'
      const limit = intFlag(args, '--limit')
      const memory = openMemory(args)
      const mode = modeArg === 'scan' || modeArg === 'fts5' ? modeArg : 'auto'
      const result = memory.search(query, {
        mode,
        limit: limit !== undefined && limit > 0 ? limit : undefined,
      })
      if (json) printJson(result)
      else {
        if (result.total === 0) process.stdout.write('no matches\n')
        else {
          process.stdout.write(`${result.total} match(es) via ${result.engine} — ${query}\n${result.note ? `note: ${result.note}\n` : ''}`)
          for (const m of result.matches) process.stdout.write(`- ${m.topic} (${m.uri}): ${m.snippet}\n`)
          if (result.truncated) process.stdout.write('(truncated to limit)\n')
        }
      }
      return
    }

    case 'budget': {
      const memory = openMemory(args)
      const report = memory.budget()
      if (json) printJson(report)
      else {
        const lines = [
          `memory root: ${report.root}`,
          `snapshot: ${report.loadedAt} (${report.pendingWrites} pending write(s))`,
          `index: ${report.index.entries} entries, ${report.index.lines}/${report.index.lineCap} lines, ${report.index.bytes}/${report.index.byteCap} bytes${report.index.overBudget ? ' — OVER BUDGET' : ''}`,
          `notes: ${report.detail.noteCount}, ${report.detail.totalBodyChars} chars / ${report.detail.totalBytes} bytes (max ${report.detail.maxBytes}/file)`,
          `search engine: ${report.search.engine}${report.anomalies.danglingEntries > 0 || report.anomalies.orphanFiles.length > 0 ? `\nanomalies: ${report.anomalies.danglingEntries} dangling, ${report.anomalies.orphanFiles.length} orphan` : ''}`,
          '',
          ...report.perTopic.map((t) => `- ${t.topic}: ${t.bodyChars}/${t.writeBudget} chars (${t.budgetUsedPct}%)`),
        ]
        process.stdout.write(`${lines.join('\n')}\n`)
      }
      return
    }

    case 'digest': {
      const file = flagStr(args, '--file')
      const text = flagStr(args, '--text')
      const maxItems = intFlag(args, '--max-items')
      const topicHint = flagStr(args, '--topic-hint')
      const memory = openMemory(args)
      const result = memory.digest({
        file,
        source: text,
        maxItems,
        topicHint,
      })
      if (json) printJson(result)
      else {
        if (result.sourceKind === 'none') {
          process.stderr.write(`dsh-memory: no digest source: ${result.note}\n`)
          process.exitCode = 1
        } else {
          process.stdout.write(`digest from ${result.source} — ${result.candidates.length} candidate(s); review then mem_write:\n`)
          for (const c of result.candidates) process.stdout.write(`- [${c.topic}/${c.kind}] ${c.summary} (${c.chars}/${c.budget} chars)\n`)
        }
      }
      return
    }

    case 'delete': {
      const topic = rest[0] ?? fail('delete requires a <topic>')
      const memory = openMemory(args)
      let outcome
      try {
        outcome = memory.delete(topic)
      } catch (error) {
        if (error instanceof MemoryError) fail(error.message)
        throw error
      }
      if (json) printJson(outcome)
      else process.stdout.write(`deleted ${topic}: ${outcome.removed ? 'removed' : 'not found'}\n`)
      return
    }

    case 'uri': {
      const topic = rest[0] ?? fail('uri requires a <topic>')
      const memory = openMemory(args)
      process.stdout.write(`${memory.uriFor(topic)}\n`)
      return
    }

    default:
      fail(`unknown command: ${command}\n${HELP}`)
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`dsh-memory: internal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
