---
id: task/根治优化-npm-test-的-git-heavy-测试架构
title: 根治优化 npm test 的 Git-heavy 测试架构
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-25T15:54:20.721Z
updatedAt: 2026-08-25T16:34:25.885Z
---
Objective
Reduce full npm test latency by moving pure assertions out of Git-backed integration paths, reducing repeated repository setup, and separating test concurrency by cost without weakening lifecycle coverage.

Evidence
The full suite is dominated by Git/process-heavy files; keep normal end-to-end and first recovery boundaries while removing duplicate setup and matrix cases.

Acceptance
A focused benchmark records before/after wall time. The delivered test commands remain npm-only, the full verification path stays available, and changed tests preserve the user-visible lifecycle invariants.