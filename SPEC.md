# Memory Standard Protocol — Specification (mm) v1

This document is the normative specification of **mm**, the Memory Standard
Protocol implemented by `dsh-memory-standard`. It defines a deterministic,
layered, cross-agent memory format:

- a hand-loaded **index** (`MEMORY.md`) with hard line/byte budgets,
- per-topic **detail files** in plain markdown, loaded on demand,
- portable **`mm://` URIs** to address notes across tools and agents,
- **deterministic budgets**: exceeding one is a structured error with usage
  metrics — never a silent truncation,
- **frozen-snapshot reads**: a session reads a snapshot taken at start; writes
  persist to disk and load in the next session.

Anything that reads/writes files matching this layout interoperates with the
standard — there is no proprietary protocol and no closed tool contract. The
reference implementation ships alongside as a dependency-free TypeScript
library (`lib/core`) plus a JSON Schema (`schema/memory.schema.json`).

## 1. Terms

| term | meaning |
| --- | --- |
| memory root | the directory that holds the index and the detail directory |
| memory id | a label in `mm://<memoryId>/<topic>` URIs (default `local`) |
| topic | a portable ASCII slug naming one note (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, ≤ 64 chars) |
| character | one Unicode code point (what humans read) |
| byte | one UTF-8 byte |
| line | editor-displayed lines (a trailing newline does not open a new line) |

## 2. Layout

```
<root>/
  MEMORY.md            index (hand-load priority)
  memories/            detail directory
    <topic>.md         one detail file per topic
```

Default root resolution: an explicit `root`, else `$DSH_MEMORY_ROOT`, else
`$DSH_HOME/memory` (`$DSH_HOME` defaults to `~/.dsh`). A `~` prefix and
`$VAR`/`${VAR}` references are expanded in explicit roots.

## 3. Index — `MEMORY.md`

```markdown
# MEMORY.md

Memory Standard Index — hand-load priority; managed by dsh-memory-standard.
Hard caps: 200 lines / 25600 bytes. Over budget => rewrite (never truncate).

> mm-id: local
> mm-version: 1
> mm-kind: index
> mm-caps: 200 lines / 25600 bytes

## <topic>
- **summary:** one-line summary
- **tags:** a, b
- **file:** memories/<topic>.md
- **updated:** 2026-01-02T03:04:05.000Z
- **budget:** <bodyChars>/<writeBudget>

Optional free-form entry body lines (preserved verbatim).

## <topic2>
...
```

Parsing rules (normative):

- The file begins with an `# MEMORY.md` title; any `> mm-*:` lines before the
  first `## ` heading are header metadata.
- Each entry is a `## <topic>` section. Inside a section, lines of the form
  `- **key:** value` are metadata for the recognized keys
  `summary, tags, file, updated, budget`; every other line — including blank
  lines and unknown `- **key:** value` lines — is preserved verbatim as the
  entry body (forward compatible: no reader data is ever dropped).
- `file` must be a safe relative path: POSIX separators only (a backslash is
  rejected, since Windows would re-interpret it as a separator), no `..`
  segment, no absolute path. Readers must additionally verify a resolved path
  stays inside the memory root.
- A heading that is not a valid topic slug is a parse error. Consequently an
  **entry body must not contain a line beginning with `## `** (it would be
  read as a new entry); put multi-section content in the detail file instead.
- Serialization sorts entries by topic and is deterministic.

## 4. Detail files — `memories/<topic>.md`

```markdown
# <topic>

> mm-id: local
> mm-version: 1
> mm-kind: note
> mm-topic: <topic>
> mm-file: memories/<topic>.md

<free-form markdown body, any language>
```

Meta lines are only `> mm-*:` ones; other blockquotes and `#` headings are
ordinary body content, so any markdown body round-trips verbatim. The body is
the raw bytes after the header block.

## 5. URIs

- Canonical: `mm://<memoryId>/<topic>` (e.g. `mm://local/deploy-region`)
- Shorthand (same memory): `mm:<topic>`
- `parseMemoryUri`/`uriFor` are the reference implementation.

Topics are the same slug grammar as filenames, so a URI segment maps directly
to a file path and never needs escaping.

## 6. Deterministic budgets

Budgets are a contract: **an over-budget operation fails with metrics and
writes nothing; the standard never truncates.** A compliant writer must not
"fix" an over-budget write by silently dropping content.

- **per-write character budget**: a write admits a body of at most `budget`
  code points (explicit `budget`, else the configured default, 4000). Over →
  `E_WRITE_BUDGET_EXCEEDED` with `usage = { bodyChars, writeBudget, overflow,
  ... }`. Compress the body and retry.
- **detail file byte cap**: the serialized detail file must fit
  `detailMaxBytes` (default 64 KiB). Over → `E_FILE_BUDGET_EXCEEDED`.
- **index hard caps**: the serialized `MEMORY.md` must fit `indexLines`
  (default 200 lines) and `indexBytes` (default 25 KiB). Over →
  `E_INDEX_BUDGET_EXCEEDED`, whose message demands an index **rewrite /
  consolidation** — never truncation. A delete/consolidation that makes the
  index fit again is allowed.
- Budgets are measured deterministically: code points for characters, UTF-8
  for bytes, the §1 line rule for lines. Failure priority is: write budget,
  then detail file cap, then index caps.
- **Deletes are always allowed** (they only ever shrink the index), so an
  over-budget index — e.g. one grown by an external edit — is recoverable
  through the documented `delete`/consolidation path until writes fit again.
  Writes are additions and remain capped.
- `mem_budget`/`budget()` report, per note: `bodyChars`, `writeBudget`,
  `budgetUsedPct`; and for the index: `lines`/`lineCap`, `bytes`/`byteCap`,
  `overBudget`, `overflowLines`, `overflowBytes`, plus anomalies
  (`danglingEntries`, `orphanFiles`) and `pendingWrites`.

## 7. Frozen snapshots

Reading is served from a **snapshot** loaded once at open/ensure/reload:

- Reads (`readTopic`, `listNotes`, `readIndex`, `search`) always see the
  snapshot — self-consistent within a session, protecting any prompt cache
  built from memory.
- Writes persist to disk immediately and durably; they are visible to the
  **next** session (a fresh process or `reload()`). `pendingWrites` counts the
  write/delete operations staged in the current session (not distinct topics).
- `reload()` re-snapshots from disk, picking up this session's writes and any
  external edits from other agents/processes (cross-process interop).
- Writes are atomic per file (unique temp + rename) and never destroy prior
  content. Concurrent writers share the root without a lock: the last
  read-modify-write can overwrite a concurrently added entry (a documented
  limitation of lock-free file storage) — longer-running agents should
  `reload()` before committing when writes may race.
- The CLI is an external observer: each invocation is a fresh live memory.

## 8. Search

- `scan` (always available): code-point tokenization that also handles CJK
  (unigrams + bigrams); weighted haystack — topic weighted above summary/tags
  above body; ranked by score desc, topic asc. Deterministic.
- `fts5` (optional): SQLite FTS5 via `node:sqlite` — zero npm dependency,
  best for whitespace/latin text. When requested but unavailable it falls back
  to `scan` and reports `engine: "scan"` with a note.
- Engine selection is a pure function: `scan` is never upgraded; `auto`
  chooses fts5 when available. `mem_search` serves the frozen snapshot.

## 9. Ingestion (session-log collaboration)

`mem_digest`/`digest()` is an optional, dependency-free entry point that
distills candidate memories from official session logs or text. It **never
writes**; it returns structured candidates (`topic`, `kind`, `summary`,
`body`, `chars`, `budget`, `overBudget`) for review, then `mem_write`.

- Sources: inline `text`, a `file` path, or (when neither is given) the most
  recent `$DSH_HOME/sessions/*.{jsonl,json,md}`.
- Extraction is deterministic and LLM-free:
  - `kind: uri` — lines containing `mm:` / `mm://` markers (topic = the URI,
    body = the rest of the line),
  - `kind: explicit` — lines starting (after a token boundary) with
    `MEMO:` / `REMEMBER` / `记忆：` / `记住：`,
  - `kind: summary` — lines starting with `Summary:` / `Conclusion:` /
    `总结：` / `结论：`,
  - `kind: heading` — `##`/`###` headings in markdown-ish text.
- Candidate bodies are proposal-trimmed to the write budget (`overBudget: true`
  when trimmed); real write budgets are enforced by `mem_write`.

## 10. Cross-agent interop

- **Files are the API**: plain, documented markdown + `mm://` URIs. Any other
  tool or agent can read/write memory with the reference implementation,
  the JSON Schema, or by following this spec directly.
- **Read/write interfaces, not a closed protocol**: the library exposes
  `Memory` (open/read/write/delete/search/budget/digest/reload) and a service
  (`ctx.get('memory')` in dsh).
- `schema/memory.schema.json` (Draft 2020-12) describes the note shape any
  compliant writer emits.
- The `lib/core` reference implementation imports only Node built-ins, so it
  is usable inside or outside dsh.

## 11. Versioning

- `mm-version: 1` is the current format version. Forward-compatible readers
  ignore unknown `mm-*` meta keys and unknown header `>` lines.
- This repo is a dsh bundle; see `package.json` (`dsh.bundle.patch`) and
  `cordis.patch.yml`.
