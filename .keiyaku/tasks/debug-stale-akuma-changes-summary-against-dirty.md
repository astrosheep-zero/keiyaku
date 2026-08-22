---
id: task/debug-stale-akuma-changes-summary-against-dirty
title: Debug stale Akuma changes summary against dirty Contract worktree
state: drop
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: "Investigation completed: historical objects are gone; Akuma reportedChanges and Contract workspace dirty are distinct owner facts and not a contradiction. No product fix is justified."
createdAt: 2026-08-18T16:47:13.291Z
updatedAt: 2026-08-22T07:28:04.609Z
---
Reproduce the observed contradiction on aku/micu-grok/c8228414: keiyaku status @observation-results reported changes 0 while the associated Contract status reported worktree dirty and git status in the managed worktree showed M src/library/fleet.ts. Determine which owner and observation epoch supplies the Akuma changes summary, whether it is stale provider-reported activity or an incorrectly joined worktree projection, and remove the contradiction rather than assuming ordinary lag. Preserve Akuma, Contract, Git, and worktree ownership boundaries; do not add polling, a cache, or a second diff authority. Add focused evidence covering a managed Contract worktree changing during an Akuma body and specify whether one atomic observation must agree or the UI must identify distinct epochs/sources honestly.