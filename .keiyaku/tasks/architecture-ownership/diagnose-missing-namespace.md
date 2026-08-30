---
id: task/architecture-ownership/diagnose-missing-namespace
title: Diagnose missing namespace-context reconcile action
state: done
priority: 1
needs: []
parent: task/architecture-ownership/reduce-request-execution-and
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T16:28:27.563Z
updatedAt: 2026-08-28T16:30:21.949Z
---
Independently reproduce tests/library-contract-operations.test.ts case 'repo reconcile keeps per-Contract reports after discovery' on current main. Determine why settlement actions are [] instead of namespace-context/kept, identify the owning prior change or baseline fixture drift, and return exact file/line evidence. Do not mix the fix into Routing.