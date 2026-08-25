---
id: task/maintainability-owner-refactor/delete-stale-maintainability
title: Delete stale maintainability controls and measure staleness
state: done
priority: 0
needs: []
parent: task/maintainability-owner-refactor/return-all-oversized-source
supersedes: []
relates: []
note: ""
createdAt: 2026-08-24T01:49:58.212Z
updatedAt: 2026-08-24T05:00:17.803Z
---
Remove the deliver file cap, bindKeiyaku cap, prepareDelivery cap, and renderRefusalFacts entry. Add measured stale detection for file caps at no more than 400 and named function caps at no more than 80.