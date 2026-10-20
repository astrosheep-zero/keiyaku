---
id: debt/enforce-production-export-reachability
title: Enforce production export reachability
state: drop
priority: 1
needs:
  - debt/centralize-task-timestamp-advancement-and-remove
  - debt/collapse-the-package-root-export-mirror
  - debt/narrow-workspace-place-ownership-and-delete-test
  - debt/partition-heart-row-mechanics-by-fact-family
  - debt/separate-akuma-body-supervision-from-turn-execut
  - debt/share-contract-and-arc-document-envelope-parsing
  - debt/split-git-repository-primitives-by-change-axis
  - debt/split-protocol-operations-by-change-reason
parent: debt/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: "Rejected: known no-reader exports can be removed from verified reader evidence. A new global export gate has no demonstrated failing case and would add policy/allowlist maintenance rather than remove an existing adjudicator."
createdAt: 2026-08-18T03:55:57.451Z
updatedAt: 2026-08-18T04:27:04.789Z
---
按 owner逐批清理无生产读者或仅由测试维持的 internal exports/wrappers，使测试通过 public behavior或真正 private seam进入。随后扩展 knip reachability gate以检查 production exports/types，同时排除 package entry points中 owner law明确的 public surface。

不要为过 gate新增 allowlist或虚假调用者。删除是默认；仅当外部 package surface或跨 owner capability有当前读者时保留。测试只验证 gate能抓住一个无读者 production export。