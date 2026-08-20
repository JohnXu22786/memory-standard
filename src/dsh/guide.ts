/**
 * The standing "standard bit": the system-prompt guidance section that tells
 * every agent in a session how to use the memory protocol deterministically.
 *
 * @module
 */

import { URI_SCHEME } from '../types.js'

export type GuideLang = 'auto' | 'en' | 'zh'

/** The system-prompt section (name/order/text) registered by the bundle. */
export function memoryGuideSection(lang: GuideLang): { name: string; order: number; text: string } {
  return {
    name: 'memory-standard',
    order: 50,
    text: guidanceText(lang),
  }
}

function guidanceText(lang: GuideLang): string {
  const en = [
    'This environment includes a layered Memory Standard (`memory-standard`).',
    '',
    '- Files: MEMORY.md is the hand-loaded index; detailed notes live in memories/<topic>.md and load on demand.',
    `- Address notes as \`${URI_SCHEME}://<memoryId>/<topic>\` (e.g. \`${URI_SCHEME}://local/project-intro\`).`,
    '- Budgets are deterministic and never truncated: keep each mem_write within its character budget and keep MEMORY.md within its line/byte caps; when a write returns budget usage, compress immediately and retry.',
    '- Reads serve a frozen session-start snapshot: writes persist to disk now and load next session; mem_budget shows pendingWrites.',
    '- mem_digest distills the latest session log into candidate memories; review and mem_write what is worth keeping.',
    '- Record durable, cross-agent facts (decisions, constraints, URIs, environment) early; keep details in notes and one-liners in the index.',
  ].join('\n')

  const zh = [
    '本环境内置「分层记忆标准」（memory-standard）。',
    '',
    '- 文件：MEMORY.md 为优先加载的索引；详细记忆存放于 memories/<topic>.md，按需加载。',
    `- 用 \`${URI_SCHEME}://<memoryId>/<topic>\`（如 \`${URI_SCHEME}://local/project-intro\`）寻址记忆。`,
    '- 预算确定性且绝不静默截断：每次 mem_write 控制在字符预算内，MEMORY.md 保持在行数/字节硬顶内；写入返回用量时立即压缩后重试。',
    '- 读取提供会话开始时冻结的快照：写入立即落盘、下一会话生效；mem_budget 可查看 pendingWrites。',
    '- mem_digest 可从最新会话日志蒸馏候选记忆；审查后用 mem_write 写入值得保留的条目。',
    '- 尽早沉淀持久化、跨 agent 可复用的事实（决策、约束、URI、环境）；细节入 notes，一行概览入索引。',
  ].join('\n')

  if (lang === 'zh') return zh
  return en
}
