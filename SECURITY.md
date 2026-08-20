# Security Policy

`dsh-memory-standard` persists memory as plain Markdown, may ingest session logs,
and consumes your `$DSH_HOME` by default — so treat memory and path handling bugs
seriously.

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a vulnerability

Please report suspected vulnerabilities to the
[security advisories](https://github.com/JohnXu22786/memory-standard/security/advisories/new)
page rather than opening a public issue — especially anything involving path
resolution (`src/core/paths.ts`, `src/core/memory.ts`) or the FTS5/SQLite search
adapter (`src/core/search.ts`).

## Data handling notes

- Memory files are plain Markdown/URI files — review them before granting agents
  write access to a root that contains secrets.
- The CLI is an external observer with full write access to its root; keep the
  default root under `$DSH_HOME` and mind shared-machine permissions.
- Freeze/snapshot semantics are documented in `SPEC.md`; never treat a frozen
  snapshot artifact as an integrity seal unless you layer your own hashing on top.

## Disclosure policy

We patch privately and, once a fix is released, publish an advisory describing the
affected versions and the timeline.
