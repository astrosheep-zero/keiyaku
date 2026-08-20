---
id: task/narrow-workspace-place-ownership-and-delete-test
title: Narrow Workspace Place ownership and delete test-only APIs
state: done
priority: 1
needs:
  - task/replace-source-topology-architecture-allowlists
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: ""
createdAt: 2026-08-18T03:55:57.451Z
updatedAt: 2026-08-18T13:45:22.155Z
---
删除仅由测试维持的 firstFreePlace、单项 appoint/release wrappers，生产只保留锁内批量 allocation/release和完整 appointment read。contract-worktree Managed projection必须接收调用方同一次 observation 已读取的 Place register，不再保留自行重读 fallback。

保留 workspace.md 定义的 Here appointment repair tolerance。删除同路径同状态的重复 Place测试，只保留 allocation order、批量原子变化、corruption和 appointment projection核心状态。