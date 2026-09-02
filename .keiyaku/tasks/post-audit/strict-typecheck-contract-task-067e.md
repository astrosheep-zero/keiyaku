---
id: task/post-audit/strict-typecheck-contract-task-067e
title: Strict-typecheck Contract Task Git and Verification tests
state: done
priority: 2
needs: []
parent: task/migrate-remaining-historical
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T17:37:01.892Z
updatedAt: 2026-09-01T19:31:15.453Z
---
Migrate the Contract/Task/Git/Verification test cluster into strict coverage: tests/cli-verification.test.ts, tests/git-delivery.test.ts, tests/git-reconciliation.test.ts, tests/library-audit.test.ts, tests/library-concurrency-placement.test.ts, tests/library-nuke.test.ts, tests/library-verification.test.ts, tests/protocol-bind-observe.test.ts, tests/settlement.test.ts, tests/target-checkout-reconcile.test.ts, tests/task-operations.test.ts, tests/verification-producer.test.ts, tests/worktree-hooks.test.ts, and tests/worktree-places.test.ts. Preserve behavior, use current public identity/result types, and remove obsolete fixture drift. Do not modify production code or the shared tsconfig in the worker; the coordinator will add the completed file list to the maintained strict subset after both parallel lanes finish.,