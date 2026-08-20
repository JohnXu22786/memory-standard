/**
 * Memory layout and root resolution.
 *
 * Resolution order for the memory root:
 *   1. an explicit `root` option (after `~`/env expansion),
 *   2. the `DSH_MEMORY_ROOT` environment variable,
 *   3. `$DSH_HOME/memory` (DSH_HOME defaults to `~/.dsh`).
 *
 * @module
 */

import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** Expand a leading `~` to the user home directory. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Expand `$VAR` and `${VAR}` references. Unknown variables expand to empty. */
export function expandEnv(path: string): string {
  return path.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) => {
    const value = process.env[name]
    return value !== undefined && value !== '' ? value : ''
  })
}

/** Resolve the dsh home directory (`$DSH_HOME` or `~/.dsh`). */
export function dshHome(): string {
  const env = process.env.DSH_HOME?.trim()
  return env && env.length > 0 ? env : join(homedir(), '.dsh')
}

/** Resolve and normalize the memory root from an explicit path or defaults. */
export function resolveRoot(explicit?: string): string {
  const direct = explicit?.trim()
  if (direct && direct.length > 0) {
    return normalizeRoot(direct)
  }
  const envRoot = process.env.DSH_MEMORY_ROOT?.trim()
  if (envRoot && envRoot.length > 0) {
    return normalizeRoot(envRoot)
  }
  return normalizeRoot(join(dshHome(), 'memory'))
}

function normalizeRoot(raw: string): string {
  return resolve(expandHome(expandEnv(raw)))
}

export interface MemoryLayout {
  root: string
  indexFile: string
  detailDir: string
}

/** The on-disk layout for a memory root. */
export function memoryLayout(root: string): MemoryLayout {
  return {
    root,
    indexFile: join(root, 'MEMORY.md'),
    detailDir: join(root, 'memories'),
  }
}

/** The relative (POSIX) path of a topic's detail file. */
export function detailRel(topic: string): string {
  return `memories/${topic}.md`
}

/** Convert a POSIX-style relative path (as stored in the index) to a platform path. */
export function toPlatformPath(rel: string): string {
  return sep === '/' ? rel : rel.split('/').join(sep)
}
