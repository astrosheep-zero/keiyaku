---
id: task/maintainability-owner-refactor/return-all-oversized-source
title: Return all oversized source owners below 500
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: All eight child deliveries are done on current main. Stale controls were removed with measured validation; target-placement and render/kanshi were re-measured at 495 and 500 effective lines and capped at 501. Full npm test, maintainability, architecture, reachability, typecheck, build, and diff-check pass.
createdAt: 2026-08-24T01:49:58.212Z
updatedAt: 2026-08-24T05:12:52.074Z
---
Replace every current file exemption above 500 with a coherent owner split. Preserve one authority per decision and do not compress formatting or create generic helper layers. Sequence the child deliveries in the order listed by the audit ruling.