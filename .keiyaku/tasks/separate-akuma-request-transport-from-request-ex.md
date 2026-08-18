---
id: task/separate-akuma-request-transport-from-request-ex
title: Separate Akuma request transport from request execution
state: open
priority: 1
needs:
  - task/replace-source-topology-architecture-allowlists
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: ""
createdAt: 2026-08-18T03:55:57.451Z
updatedAt: 2026-08-18T03:56:24.400Z
---
在 Akuma Request owner 内分离 wire claim/receipt codec 与 atomic file transport、caller request admission、Body-side request serving/pump/recovery。call/wait/tell/kill 继续使用同一 request state machine 和 Heart facts，不复制 decode、reservation 或 settlement judge。

以 crash-left transport recovery、claim/receipt exactness、upstream forwarding状态为核心不变量；不按每个 action复制模块。完成时移除 requests.ts 的 file-line exemption。