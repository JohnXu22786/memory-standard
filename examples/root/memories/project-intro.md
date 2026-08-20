# project-intro

> mm-id: local
> mm-version: 1
> mm-kind: note
> mm-topic: project-intro
> mm-file: memories/project-intro.md

本项目致力于为 dsh 生态提供统一的分层记忆标准：

- 顶层索引 `MEMORY.md` 优先加载，硬顶 200 行 / 25 KB。
- 详细记忆按主题拆分为 `memories/<topic>.md`，按需加载。
- 每次写入带字符预算，超出即报错并返回用量，绝不静默截断。
- 读写通过公开的 markdown 格式与 `mm://` URI 与其他工具/agent 互认。
