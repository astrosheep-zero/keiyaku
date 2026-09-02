---
id: task/post-audit/clarify-task-external-writer
title: Clarify Task external-writer concurrency promise
state: done
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T09:47:58.639Z
---
Reconcile docs/task.md with the filesystem non-atomic compare-then-rename limitation. Either narrow the promise to cooperative writers plus best-effort external detection, or produce evidence that a stronger portable CAS is required. Do not add an immutable generation authority without a concrete product need.