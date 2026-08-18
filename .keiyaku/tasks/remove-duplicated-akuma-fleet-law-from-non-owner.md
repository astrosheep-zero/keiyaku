---
id: task/remove-duplicated-akuma-fleet-law-from-non-owner
title: Remove duplicated Akuma fleet law from non-owner chapters
state: in_progress
priority: 1
needs: []
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: ""
createdAt: 2026-08-18T03:33:12.842Z
updatedAt: 2026-08-18T03:57:37.455Z
---
docs/akuma-public.md 单独拥有 list/fleet 的 public row、失败与静默 skip 语义。从 docs/akuma.md 和 docs/akuma-heart.md 删除同一 public law 的重复陈述，只保留 identity/lifecycle 与 Heart storage/transaction 各自拥有的 durable law，并用窄引用指向 public owner。

不修改 list 实现，不改变单个不可读 member 的静默 skip，不把源文件拓扑或测试清单写入文档。