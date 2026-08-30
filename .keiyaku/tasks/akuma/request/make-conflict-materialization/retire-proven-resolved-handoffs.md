---
id: task/akuma/request/make-conflict-materialization/retire-proven-resolved-handoffs
title: Retire proven resolved handoffs
state: done
priority: 1
needs: []
parent: task/akuma/request/make-conflict-materialization
supersedes: []
relates: []
note: ""
createdBy: aku/worker/5d71d5a4
createdAt: 2026-08-30T18:31:58.486Z
updatedAt: 2026-08-30T18:40:47.348Z
---
Implement the settled Git-custody half under docs/git.md and docs/git-reconciliation.md: retire only a consumed or replaceable Keiyaku-owned resolved handoff, preserve its exact tree, retain all foreign and unresolved operations, and report post-admission cleanup failure as reconciliation lag.