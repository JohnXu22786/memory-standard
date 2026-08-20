# Integrating `dsh-memory-standard` into a DeepSeek Harness profile

This walkthrough uses the real `dsh` CLI. It is written against
`dsh@0.1.0-rc.6` (bundle format: top-level YAML-array patch + `apply(ctx)`
entry) and was verified with the exact commands below.

## What a dsh bundle is

A dsh bundle is an npm package plus:

- a **manifest** in `package.json`: `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`,
- a **patch layer** file `cordis.patch.yml` (a YAML array; rows `- insert:`
  add plugin rows),
- a **plugin entry** that exports `name`, optional `inject`, optional
  `Config` (schemastery), and `apply(ctx, config)`.

`apply` may return a disposer that runs on unload — this bundle returns one to
clear the nudge timer and release the FTS index on session end.

## Step 1 — build the package (once)

```bash
npm install
npm run build        # compiles TypeScript -> lib/
```

## Step 2 — add it to a profile

```bash
dsh plugin --profile demo add ./dsh-memory-standard
```

`dsh plugin` forwards to pnpm inside the profile directory. The bundle's peer
dependencies (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`,
`@deepseek-ai/schemastery`) resolve from the dsh installation first, then from
the profile's `node_modules`.

First use of `dsh plugin --profile demo` initializes the profile (`dsh-base`
and friends) and records the bundle in `dsh.profile.bundles`.

> Not under a dsh CLI? Manual install: `pnpm add ./dsh-memory-standard` in the
> profile directory and add `"dsh-memory-standard"` to the profile's
> `dsh.profile.bundles` array.

## Step 3 — check it composed

```bash
dsh --profile demo --dump-config
```

The `memory-standard` row (id `memory-standard`) should appear with its
default `config`. To tune it, override the row by id in the profile
`cordis.patch.yml` (a later layer) — an override replaces the whole `config`,
so restate every field, e.g.:

```yaml
- id: memory-standard
  config:
    root: ''
    memoryId: local
    indexLines: 200
    indexBytes: 25600
    detailMaxBytes: 65536
    defaultWriteBudget: 4000
    search: { mode: auto, limit: 10, maxSnippetChars: 160 }
    nudge: { enabled: true, intervalMs: 1800000 }
    lang: auto
```

## Step 4 — boot

```bash
dsh --profile demo
```

On load the plugin:

- initializes the memory root (`<root>/MEMORY.md` + `<root>/memories/`),
- registers `mem_read`, `mem_write`, `mem_search`, `mem_budget`,
  `mem_digest` on `ctx.tools` (they appear in the model's tool set and
  system prompt automatically),
- registers the `memory-standard` system-prompt section,
- provides the `memory` service (`ctx.get('memory')`) for other plugins,
- when nudging is enabled, emits `memory/nudge` events on an interval and at
  session end (listen with `ctx.on('memory/nudge', (report) => ...)`).

## Troubleshooting

| symptom | check |
| --- | --- |
| tools missing after boot | make sure `tools` and `systemPrompt` services are present in the profile (dsh-base provides them); confirm the row is not `disabled` |
| `E_PARSE` on load | an existing `MEMORY.md` at the resolved root isn't `mm v1`-conformant; the plugin never overwrites user data — rename it and let it re-init |
| FTS5 not used | `mode: scan` or no `node:sqlite` (Node ≥ 22.5); falls back to scan automatically |
| bundle does not activate | overlay rows load their `name` package via Node resolution; the installed package must be resolvable from the profile |
