# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-20

Initial release.

### Added

- Layered `MEMORY.md` index + `memories/<topic>.md` detail files with hard
  line/byte caps.
- Deterministic write budgets: an over-budget write errors with usage metrics and
  never truncates.
- Cross-agent interoperability via `mm://` URIs, plain Markdown and optional
  JSON/schema interop.
- `mem_read`, `mem_write`, `mem_search`, `mem_budget`, `mem_digest` dsh tools, a
  `memory` service, and a standing system-prompt guide section.
- A standalone `dsh-memory` CLI (`init`, `write`, `read`, `list`, `search`,
  `budget`, `digest`, `delete`, `uri`).
- Session-log ingestion (`digest`) interoperating with official compaction/session
  logs.
