---
id: task/reconcile-custody-and-cleanup
title: Reconcile custody and cleanup convergence
state: open
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-22T15:36:03.581Z
updatedAt: 2026-08-22T15:36:03.581Z
---
Track three independent correctness gaps discovered during manual cleanup. The current world has 152 delivery refs and 29 candidate refs after removing three invalid legacy here-workspace terminal journals. Global reconcile can decode 295 Contracts, but settlement publication still reports repeated state-ref CAS retry lags. This parent task is planning authority only; implementation and owner-document changes belong in the child tasks.