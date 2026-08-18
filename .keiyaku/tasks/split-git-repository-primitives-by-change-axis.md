---
id: task/split-git-repository-primitives-by-change-axis
title: Split Git repository primitives by change axis
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
在同一 Git owner 内把 src/git/repository.ts 的独立 primitives 按变化原因分离：repository/worktree coordinates、process command boundary、refs、objects/trees/commits、diff codecs。保持 read observation、admission、reconcile 和 target placement 的现有 owner，不创造第二 Git facade。

迁移真实调用者并删除无读者 primitives；每个新 module 必须有多个真实 capability 或一个完整 primitive family，禁止薄 wrapper/barrel。完成时移除 repository.ts 的 file-line exemption。