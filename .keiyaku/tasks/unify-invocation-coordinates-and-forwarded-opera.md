---
id: task/unify-invocation-coordinates-and-forwarded-opera
title: Unify invocation coordinates and forwarded operation inputs
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: "Amended Task context is caller-edge-only: public Tasks remains World-only; CLI resolves/writes context through the Task owner with one narrow policy edge; linked-worktree lookup is covered. Here audit now captures the candidate from RepositoryScope.effectiveCwd, without pre-admission worktree enumeration; target adjudication retains target.failed for Git observation failure. Focused audit/context/public tests, typecheck, architecture, build, maintainability, reachability, and diff-check pass. Full npm test no longer has the Coordinate audit failure but remains nonzero from aggregate fixture interference in cli-verification and target-checkout plus unrelated library-akuma-creation untidy/asleep. No review or delivery action taken."
createdAt: 2026-08-19T07:02:57.980Z
updatedAt: 2026-08-19T18:41:23.766Z
---
Make directory-local Task context, durable Contract workspace appointment, and Body Request forwarding preserve one ordinary-operation coordinate model.