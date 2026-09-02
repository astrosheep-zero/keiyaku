---
id: task/post-audit/make-task-lock-cleanup-preserve
title: Make Task lock cleanup preserve committed action results
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T10:50:13.817Z
---
Update withTaskLocks so every acquired lock is attempted for release, cleanup failures are aggregated, and a successful action is not reported as an uncommitted failure. Add typed committed-with-cleanup-failure or unknown semantics where the public result requires it, with duplicate-retry regression tests.