---
id: task/restore-full-test-green-after-architecture-polic
title: Restore full test green after architecture policy growth
state: open
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-19T06:04:30.516Z
updatedAt: 2026-08-19T06:04:30.516Z
---
npm test currently fails because scripts/architecture/policy.ts has 1385 effective lines above its bounded 1350 exemption. Reduce real policy representation or delete stale/redundant declarations without raising the cap, weakening exact-symbol enforcement, splitting the single policy authority, or compressing readable structure. Completion requires the full npm test suite, typecheck, and build green.