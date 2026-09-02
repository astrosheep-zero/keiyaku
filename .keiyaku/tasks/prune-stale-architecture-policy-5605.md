---
id: task/prune-stale-architecture-policy-5605
title: Prune stale architecture policy exceptions
state: done
priority: 3
needs: []
parent: null
supersedes: []
relates:
  - task/close-architecture-checker-c421
note: "Faye act/1226 classifies item 10 as architecture-policy debt: allowlists/denies increasingly describe current state. Audit scripts/architecture/policy.ts and policy-capabilities.ts against actual imports/capability diagnostics; delete only provably redundant or stale entries, preserving owner boundaries and checker behavior. No broad rewrites or new exception mechanism; add focused regression evidence."
createdAt: 2026-09-02T06:23:54.453Z
updatedAt: 2026-09-02T06:47:39.868Z
---
