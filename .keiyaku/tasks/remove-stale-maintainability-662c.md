---
id: task/remove-stale-maintainability-662c
title: Remove stale maintainability file-line hard gate
state: done
priority: 3
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-02T04:48:27.538Z
updatedAt: 2026-09-02T04:59:09.640Z
---
Implement Faye prior ruling (act/1037) corresponding to item 14: remove the hard production file total-line limit and per-file ceiling exception table from scripts/check-maintainability.js, while retaining function-level complexity/max-lines-per-function, max-len, lint, and markdown limits. Delete obsolete exception diagnostics/tests only when proven redundant; do not compress source or change owner boundaries. Update focused maintainability tests and run npm run test:maintainability, npm run test:typecheck, npm run build. This is debt closure, not a new architecture finding; no law changes and no edits to active P1/P2 regions.