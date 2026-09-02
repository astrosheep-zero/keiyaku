---
id: task/preserve-accepted-mutation-lags-dea5
title: Preserve accepted mutation lags and explicit finality
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-02T04:36:01.647Z
updatedAt: 2026-09-02T09:12:11.417Z
---
Track P1-A from Faye acts 1203/1205: ensure private-state publication-seat close failures after confirmed publication become typed post-admission lag on accepted outcomes, and make projectMutationFinality consume explicit owner lag surfaces rather than instanceof or incidental shape probing. Scope is src/git/private-state-seat.ts, settlement and task lag producers, protocol outcome/completion/operations plumbing, src/library/mutation.ts, and focused tests. Keep admission irreversible and accepted; do not touch Verification environment, runtime termination, fleet, architecture scripts, forwarding codec compression, or law docs. Depends on no other Task. Completion requires deterministic seat-close regression, explicit-finality regression, focused tests, npm run test:typecheck, and npm run build.