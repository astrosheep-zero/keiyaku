---
id: task/extract-git-process-execution-capability
title: Extract Git process execution capability
state: done
priority: 1
needs: []
parent: task/审计项目架构边界-重复与-owner-错位
supersedes:
  - task/split-git-repository-primitives-by-change-axis
relates: []
note: ""
createdAt: 2026-08-18T09:41:23.107Z
updatedAt: 2026-08-18T10:27:53.007Z
---
First architecture-cleanup delivery from the settled split blueprint. Move the Git subprocess execution/error family from src/git/repository.ts into src/git/process.ts, migrate real callers directly, move the unique spawn capability policy, and remove the repository.ts maintainability exemption. Keep repository/worktree/object/ref/diff ownership in repository.ts; no forwarding exports, barrels, docs changes, topology tests, or readability compression. If repository.ts later exceeds 500 effective lines, refs.ts is the preselected next cut.