---
id: task/maintainability-owner-refactor/split-projection-and-renderer
title: Split projection and renderer change axes
state: done
priority: 1
needs: []
parent: task/maintainability-owner-refactor/return-all-oversized-source
supersedes: []
relates: []
note: ""
createdAt: 2026-08-24T01:49:58.212Z
updatedAt: 2026-08-24T04:31:47.237Z
---
Separate Heart ledger folding from snapshot/history selection, Akuma activity rendering from command receipts, and Contract history rendering from mutation receipts. Preserve public output bytes except where an owning UI law requires a deliberate change.