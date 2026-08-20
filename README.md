# dsh-memory-standard

[English](./README.md) | [简体中文](./README.zh.md)

[![CI](https://github.com/JohnXu22786/memory-standard/actions/workflows/ci.yml/badge.svg)](https://github.com/JohnXu22786/memory-standard/actions/workflows/ci.yml)

A **Memory Standard Protocol (mm)** plugin for the DeepSeek Harness (dsh): a
deterministic, layered, cross-agent memory system built on plain markdown
files — not a proprietary protocol.

The dsh ecosystem has dozens of memory plugins but no shared standard, and
the official core only ships a default-off MCP memory example. This plugin
claims the missing "standard seat": **deterministic budgets + layered
MEMORY.md + cross-agent mutual recognition + session-log ingestion** that
works with official compaction/session logs.

- **Layered memory** — `MEMORY.md` is the hand-loaded index (hard cap:
  200 lines / 25 KiB, default); detailed notes live in `memories/<topic>.md`
  and load on demand.
- **Deterministic budgets** — over any budget is a structured error with
  usage metrics demanding an index rewrite, **never a silent truncation**.
  Writes carry a character budget and return usage so an agent can compress
  on the spot.
- **Cross-agent mutual recognition** — a documented plain-markdown format,
  portable `mm://<memoryId>/<topic>` URIs, a JSON Schema
  (`schema/memory.schema.json`), and an open read/write API. No closed
  protocol.
- **Write timing** — `mem_write` API plus session-end / periodic nudging;
  writes persist to disk immediately and load in the **next** session
  (in-session reads stay frozen, protecting any prompt cache).
- **Ingestion collaboration** — `mem_digest` recognizes official dsh session
  logs / compaction output as a memory source and distills candidate memories
  (optional, self-contained, LLM-free).
- **Toolchain** — dsh tools `mem_read`, `mem_write`, `mem_search`,
  `mem_budget`, `mem_digest`, plus a `dsh-memory` CLI.

The core library is dependency-free (Node built-ins only) and works both
inside dsh and standalone.

## Status

Developer-preview dsh ecosystem; format version `mm v1` (see
[`SPEC.md`](SPEC.md)). Compatible with the installed `@deepseek-ai/dsh` CLI
and bundle format (`dsh.bundle.patch` + `cordis.patch.yml` + `apply(ctx)`).

---

## Quick start

### 1. Integrate with dsh (local directory bundle)

From the directory that contains this package (`dsh-memory-standard/`):

```bash
dsh plugin --profile demo add ./

# or install directly from this GitHub repository
dsh plugin --profile demo add github:JohnXu22786/memory-standard
# or from npm once published
dsh plugin --profile demo add dsh-memory-standard
# the standalone CLI is also published as a global npm bin
npm install -g dsh-memory-standard

# boot the profile; the five mem_* tools + the 'memory-standard' system section load
dsh --profile demo
```

`dsh plugin` forwards to pnpm inside the profile; peer dependencies
(`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`)
resolve from the dsh installation. Verified against `dsh@0.1.0-rc.6`.

> Notes for other install paths:
> - As a dev overlay → copy `cordis.patch.yml` and point a `--patch` overlay at
>   the package's entry (`name` = package name for the row).
> - The plugin auto-initializes the memory root (`$DSH_HOME/memory`, or
>   `$DSH_MEMORY_ROOT`) on first load — no manual `init` needed.

### 2. Configure

The bundle ships defaults; every value is overridable by overriding the
`memory-standard` row by id in a later layer (profile `cordis.patch.yml`,
`$DSH_HOME` overlay, or `--patch`):

```yaml
- id: memory-standard
  config:
    root: ''                 # '' => $DSH_MEMORY_ROOT, else $DSH_HOME/memory
    memoryId: local
    indexLines: 200          # hard cap on MEMORY.md lines
    indexBytes: 25600        # hard cap on MEMORY.md bytes (25 KiB)
    detailMaxBytes: 65536    # hard cap per detail file
    defaultWriteBudget: 4000 # per-write character budget
    search:
      mode: auto             # auto | scan | fts5
      limit: 10
      maxSnippetChars: 160
    nudge:
      enabled: true          # session-end / periodic nudging (memory/nudge events)
      intervalMs: 1800000
    lang: auto               # auto | en | zh (system-prompt section language)
```

### 3. Use it

In a dsh session the agent gets the five tools (plus a system-prompt section
that explains the protocol):

| tool | purpose |
| --- | --- |
| `mem_read` | read the index, all summaries, or one note's full body (frozen snapshot) |
| `mem_write` | write/update a note with a character budget; returns usage; never truncates |
| `mem_search` | search memory (FTS5 when available, else scan; CJK-aware scan) |
| `mem_budget` | deterministic budget report (index caps, per-note usage, pending writes) |
| `mem_digest` | distill candidate memories from a session log / text (never writes) |

Other plugins can access memory directly via the provided service:

```ts
const memory = ctx.get('memory')
memory.write({ topic: 'deploy-region', content: 'us-east-1', summary: 'Deployment region' })
memory.search('deploy')
```

### 4. Standalone CLI

```bash
npm run build                # needed once to compile lib/
node lib/cli.js init --root <dir>
node lib/cli.js write deploy --content "we deploy to us-east-1" --root <dir>
node lib/cli.js read deploy --root <dir>
node lib/cli.js budget --root <dir>
node lib/cli.js search deploy --root <dir>
node lib/cli.js digest --file <session.log.jsonl> --root <dir>
```

All commands accept `--json` for machine-readable output; `--root` selects the
memory root. Install globally with `npm i -g .` to get the `dsh-memory` bin.

---

## How it works

### Layered memory

```
<root>/MEMORY.md          hand-loaded index (small, hard-capped)
<root>/memories/t1.md     on-demand detail notes (free markdown)
```

`mem_read` without a topic returns the index (the hand-load surface); a topic
returns that note's full body. Budget lets the agent decide what belongs in
the index summary vs. the detail note.

### Deterministic budgets

Three no-truncation guarantees (see [`SPEC.md`](SPEC.md) §6):

1. a write over its **character budget** fails with `usage.overflow`, writes
   nothing; compress and retry,
2. a note over its **byte cap** fails, preserving the previous content,
3. an index over its **line/byte hard cap** fails and *demands a rewrite* —
   the error text says so explicitly. Deleting/consolidating to fit again is
   the recovery path.

A compliant writer must never "fix" an over-budget write by silently dropping
content — the standard views that as data loss.

### Frozen snapshots

`Memory` loads a snapshot once per session. Reads and search serve that
snapshot; writes go to disk for the next session. `pendingWrites` exposes
staged writes; `reload()` re-snapshots (used by the CLI and integrations).
This keeps the session's view self-consistent and protects prompt caches.

### Cross-agent interop

- The on-disk format is plain, documented markdown (`SPEC.md`) and the URI
  scheme is `mm://<memoryId>/<topic>`.
- `schema/memory.schema.json` describes the note shape for any compliant
  writer/reader.
- The public API (`Memory`, and `ctx.get('memory')` in dsh) is an open
  interface — not a closed tool protocol. Any agent or tool can read/write the
  same files.

### Ingestion collaboration

dsh stores sessions under `$DSH_HOME/sessions` and compacts them; those logs
are recognized as a memory source. `mem_digest` reads the most recent
`*.jsonl`/`*.md` (or an explicit file/text), recognizes `mm:` markers,
`MEMO:`/`记忆：`/`记住：` lines, summary lines, and markdown headings, and
returns budgeted candidates for review. It never auto-writes — the agent
chooses what to commit.

---

## Project layout

```
src/
  types.ts            shared/interop types + defaults (mm v1)
  core/               dependency-free library (Node built-ins only)
    memory.ts         Memory facade: snapshots, writes, budget, search, digest
    format.ts         index/note markdown grammar + URIs (SPEC implementation)
    budget.ts         deterministic budget arithmetic
    search.ts         scan search + optional SQLite FTS5 (node:sqlite)
    digest.ts         session-log distillation
    paths.ts          layout & root resolution
  dsh/
    tools.ts          the five mem_* defineTool registrations
    guide.ts          system-prompt "standard bit"
  cli.ts              dsh-memory CLI
  index.ts            dsh bundle entry (name/inject/Config/apply)
cordis.patch.yml      bundle patch layer
schema/memory.schema.json
SPEC.md / README.md / README.zh.md
examples/root/        runnable example memory
test/                 node:test suite (budget/layered/snapshot/search/digest/interop/cli)
```

## Development

```bash
npm install
npm run build      # tsc -> lib/
npm test           # build + node --test
npm run typecheck
```

Uses only dev dependencies (`typescript`, `@types/node`, and the dsh peer
packages for type-checking). Runtime dependencies: none beyond Node built-ins
(`node:sqlite` optional for FTS5; graceful fallback to scan).

## License

MIT — see [LICENSE](LICENSE).
