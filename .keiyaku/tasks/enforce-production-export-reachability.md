---
id: task/enforce-production-export-reachability
title: Enforce production export reachability
state: open
priority: 1
needs:
  - task/centralize-task-timestamp-advancement-and-remove
  - task/collapse-the-package-root-export-mirror
  - task/narrow-workspace-place-ownership-and-delete-test
  - task/partition-heart-row-mechanics-by-fact-family
  - task/separate-akuma-body-supervision-from-turn-execut
  - task/share-contract-and-arc-document-envelope-parsing
  - task/split-git-repository-primitives-by-change-axis
  - task/split-protocol-operations-by-change-reason
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: ""
createdAt: 2026-08-18T03:55:57.451Z
updatedAt: 2026-08-18T03:56:24.400Z
---
按 owner逐批清理无生产读者或仅由测试维持的 internal exports/wrappers，使测试通过 public behavior或真正 private seam进入。随后扩展 knip reachability gate以检查 production exports/types，同时排除 package entry points中 owner law明确的 public surface。

不要为过 gate新增 allowlist或虚假调用者。删除是默认；仅当外部 package surface或跨 owner capability有当前读者时保留。测试只验证 gate能抓住一个无读者 production export。