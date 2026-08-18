---
id: task/partition-heart-row-mechanics-by-fact-family
title: Partition Heart row mechanics by fact family
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
把 heart/rows.ts 的 table codec/statement按 coherent fact family 分离：Body/lifecycle、session/turn/activity、Request、control/kill。heart/index.ts 与 storage.ts 继续独占 transaction section、schema gate和跨 fact裁决；schema仍是一份。

不为每个 SQL statement建小文件，不从 row modules 导出 public product semantics。测试固定 canonical row/transaction不变量，不镜像文件清单。