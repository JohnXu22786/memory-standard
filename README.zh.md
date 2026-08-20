# dsh-memory-standard（记忆标准协议插件）

[English](./README.md) | [简体中文](./README.zh.md)

[![CI](https://github.com/JohnXu22786/memory-standard/actions/workflows/ci.yml/badge.svg)](https://github.com/JohnXu22786/memory-standard/actions/workflows/ci.yml)

面向 DeepSeek Harness（dsh）的**记忆标准协议（mm）** 插件：一种确定性、分层、
跨 agent 互认的记忆系统，基于普通 Markdown 文件——而非专有协议。

dsh 生态已有数十个记忆类插件却缺乏统一标准，官方核心也只带一个默认关闭的
MCP 记忆示例。本插件抢占缺失的「标准位」：**确定性预算 + 分层 MEMORY.md +
跨 agent 互认 + 与官方 compaction/会话日志的摄取协同**。

- **分层记忆** —— `MEMORY.md` 为优先加载的索引（硬顶：默认 200 行 / 25 KB）；
  详细记忆存放于 `memories/<topic>.md`，按需加载。
- **确定性预算** —— 超过任何预算都是带用量指标的确定性错误，并要求重写索引，
  **绝不静默截断**。写入带字符预算并返回用量，便于 agent 当场压缩。
- **跨 agent 互认** —— 有规范的纯 Markdown 格式、可移植的
  `mm://<memoryId>/<topic>` URI、JSON Schema（`schema/memory.schema.json`）与
  开放读写接口，而非闭锁协议。
- **写入时机** —— `mem_write` API + 会话结束/周期提示（nudging）；写入立即
  落盘、**下一会话生效**（会话内读取保持冻结，保护提示词缓存）。
- **摄取协同** —— `mem_digest` 识别官方 dsh 会话日志 / compaction 产物作为
  记忆来源并蒸馏候选记忆（可选、自包含、无需 LLM）。
- **工具链** —— dsh 工具 `mem_read`、`mem_write`、`mem_search`、`mem_budget`、
  `mem_digest`，外加 `dsh-memory` CLI。

核心库零运行时依赖（仅 Node 内置模块），既能嵌入 dsh 使用，也可独立运行。

## 状态

dsh 生态为开发者预览期；格式版本 `mm v1`（见 [`SPEC.md`](SPEC.md)）。
与已安装的 `@deepseek-ai/dsh` CLI 及 bundle 规范（`dsh.bundle.patch` +
`cordis.patch.yml` + `apply(ctx)`）兼容。

---

## 快速开始

### 1. 接入 dsh（本地目录 bundle）

在包含本包的目录（`dsh-memory-standard/`）内执行：

```bash
# 把 bundle 安装进一个 dsh profile（首次使用会自动创建）
dsh plugin --profile demo add ./

# 启动 profile，五个 mem_* 工具与 'memory-standard' 系统段随之加载
dsh --profile demo
```

`dsh plugin` 会在 profile 目录内转调 pnpm；peer 依赖（`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`）从 dsh 安装解析。
已在 `dsh@0.1.0-rc.6` 上验证。

> 其他安装路径：
> - 发布到 npm 后：`dsh plugin --profile demo add dsh-memory-standard`。
> - 作为开发 overlay：将 `cordis.patch.yml` 复制或引用到 `--patch` 覆盖层，
>   行内 `name` 指向本包入口。
> - 插件首次加载会自动初始化记忆根（`$DSH_HOME/memory` 或 `$DSH_MEMORY_ROOT`），
>   无需手动 `init`。

### 2. 配置

bundle 自带默认值；可在更上层（profile 的 `cordis.patch.yml`、`$DSH_HOME`
覆盖层或 `--patch`）通过行 `id` 覆盖 `memory-standard`：

```yaml
- id: memory-standard
  config:
    root: ''                 # '' => $DSH_MEMORY_ROOT，否则 $DSH_HOME/memory
    memoryId: local
    indexLines: 200          # MEMORY.md 行数硬顶
    indexBytes: 25600        # MEMORY.md 字节硬顶（25 KB）
    detailMaxBytes: 65536    # 单个详细记忆文件字节硬顶
    defaultWriteBudget: 4000 # 每次写入的字符预算
    search:
      mode: auto             # auto | scan | fts5
      limit: 10
      maxSnippetChars: 160
    nudge:
      enabled: true          # 会话结束/周期提示（memory/nudge 事件）
      intervalMs: 1800000
    lang: auto               # auto | en | zh（系统提示段语言）
```

### 3. 使用

dsh 会话中，agent 会获得五个工具（外加解释该协议的系统提示段）：

| 工具 | 用途 |
| --- | --- |
| `mem_read` | 读取索引、全部摘要或单个 note 全文（冻结快照） |
| `mem_write` | 带字符预算写入/更新 note；返回用量；绝不截断 |
| `mem_search` | 记忆搜索（可用时用 FTS5，否则用 scan；scan 支持中文） |
| `mem_budget` | 确定性预算报告（索引上限、各 note 用量、pending 写入） |
| `mem_digest` | 从会话日志 / 文本蒸馏候选记忆（绝不写入） |

其他插件可通过提供的服务直接访问记忆：

```ts
const memory = ctx.get('memory')
memory.write({ topic: 'deploy-region', content: 'us-east-1', summary: '部署区域' })
memory.search('deploy')
```

### 4. 独立 CLI

```bash
npm run build                # 首次使用需先编译 lib/
node lib/cli.js init --root <dir>
node lib/cli.js write deploy --content "we deploy to us-east-1" --root <dir>
node lib/cli.js read deploy --root <dir>
node lib/cli.js budget --root <dir>
node lib/cli.js search deploy --root <dir>
node lib/cli.js digest --file <session.log.jsonl> --root <dir>
```

所有命令均支持 `--json` 机器可读输出；`--root` 指定记忆根。全局安装
`npm i -g .` 后可直接使用 `dsh-memory`。

---

## 工作原理

### 分层记忆

```
<root>/MEMORY.md         优先加载的索引（小、有硬顶）
<root>/memories/t1.md    按需加载的详细记忆（自由 Markdown）
```

不传 topic 的 `mem_read` 返回索引（即优先加载面）；传 topic 则返回该 note
全文。预算可帮助 agent 判断哪些内容进索引摘要、哪些进详细 note。

### 确定性预算

三条「绝不截断」保证（详见 [`SPEC.md`](SPEC.md) §6）：

1. 写入超过**字符预算**即失败并返回 `usage.overflow`，不写任何内容；
   压缩后重试，
2. note 超过**字节上限**即失败，保留原有内容，
3. 索引超过**行/字节硬顶**即失败并明确**要求重写**——错误文案会明说。
   删除/合并使索引重新达标是恢复路径。

规范的写入方绝不能用「静默丢内容」来“修复”超预算写入——标准将其视为数据丢失。

### 冻结快照

`Memory` 每会话只加载一次快照。读取与搜索都服务于该快照；写入落盘、下一会话
生效。`pendingWrites` 暴露本会话已暂存的写入；`reload()` 重新快照（CLI 与集成
场景使用）。这保证了会话内视图自洽，并保护提示词缓存。

### 跨 agent 互认

- 磁盘格式为规范的纯 Markdown（`SPEC.md`），URI 为
  `mm://<memoryId>/<topic>`。
- `schema/memory.schema.json` 描述任何合规写入/读取方都应遵循的 note 形状。
- 公开 API（`Memory`，以及 dsh 中的 `ctx.get('memory')`）是开放接口——
  不是封闭工具协议。任何 agent 或工具都能读写同一批文件。

### 摄取协同

dsh 将会话存放在 `$DSH_HOME/sessions` 并做 compaction；这些日志即被识别为
记忆来源。`mem_digest` 会读取最近的 `*.jsonl`/`*.md`（或显式文件/文本），
识别 `mm:` 标记、`MEMO:`/`记忆：`/`记住：` 行、总结行与 Markdown 标题，并返回
带预算的候选供审查。它绝不自动写入——由 agent 决定提交哪些。

---

## 项目结构

```
src/
  types.ts            共享/互认类型 + 默认值（mm v1）
  core/               零依赖库（仅 Node 内置模块）
    memory.ts         Memory 门面：快照、写入、预算、搜索、蒸馏
    format.ts         索引/note 的 Markdown 文法 + URI（SPEC 的实现）
    budget.ts         确定性预算计算
    search.ts         scan 搜索 + 可选 SQLite FTS5（node:sqlite）
    digest.ts         会话日志蒸馏
    paths.ts          目录布局与根解析
  dsh/
    tools.ts          五个 mem_* 工具的 defineTool 注册
    guide.ts          系统提示「标准段」
  cli.ts              dsh-memory CLI
  index.ts            dsh bundle 入口（name/inject/Config/apply）
cordis.patch.yml      bundle 补丁层
schema/memory.schema.json
SPEC.md / README.md / README.zh.md
examples/root/        可运行的示例记忆
test/                 node:test 测试套件（预算/分层/快照/搜索/蒸馏/互认/CLI）
```

## 开发

```bash
npm install
npm run build      # tsc -> lib/
npm test           # 构建 + node --test
npm run typecheck
```

仅使用开发依赖（`typescript`、`@types/node`，以及用于类型检查的 dsh peer
包）。运行时除了 Node 内置模块外零依赖（`node:sqlite` 可选用于 FTS5；不可用时
自动降级为 scan）。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
