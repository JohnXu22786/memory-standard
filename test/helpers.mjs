// Shared test helpers: temp memory roots and fixtures.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Create a throwaway temp directory. */
export function tempDir(prefix = 'mm-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Recursively remove a temp directory returned by tempDir(). */
export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** Write a file at root/relPath, creating parent directories. Returns absolute path. */
export function writeFile(root, relPath, content) {
  const full = join(root, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
  return full
}

/** Read root/relPath as utf8, or null when missing. */
export function readFile(root, relPath) {
  const full = join(root, relPath)
  return existsSync(full) ? readFileSync(full, 'utf8') : null
}

export function fileExists(root, relPath) {
  return existsSync(join(root, relPath))
}

/** A compact example dsh session log (JSONL) mentioning an explicit memory marker. */
export function sessionLogFixture() {
  return [
    { type: 'session/user', content: { text: 'set up the project' } },
    { type: 'session/assistant', content: { text: 'Alright, scaffolding the repo.' } },
    { type: 'session/user', content: { text: 'REMEMBER this: mm:deploy-region we deploy to us-east-1' } },
    { type: 'session/assistant', content: { text: '总结：本项目采用 REST 架构，核心服务部署在 us-east-1。' } },
    { type: 'session/tool', content: { text: 'bash: completed' } },
  ].map((line) => JSON.stringify(line)).join('\n')
}

export function sessionLogFixturePath(dir) {
  return writeFile(dir, 'sessions/session-2026-08-20T00-00-00.jsonl', sessionLogFixture())
}
