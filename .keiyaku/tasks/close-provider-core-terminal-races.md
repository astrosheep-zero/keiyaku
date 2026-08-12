---
id: task/close-provider-core-terminal-races
title: Close provider core terminal races
state: done
priority: 0
needs: []
parent: task/complete-the-provider-core-capability-model
supersedes: []
relates: []
note: ""
createdAt: 2026-08-12T17:35:32.194Z
updatedAt: 2026-08-12T18:01:22.120Z
---
Fix the two parent-review blockers already settled by docs/akuma-execution.md: interrupt must admit born Soul and pause atomically without unborn residue even while the leash is held; Body must preserve an already terminal successful provider turn when a concurrent Tell arrives, leaving that Tell pending for the successor instead of submitting to a settled Session. Add focused adverse-order regressions.