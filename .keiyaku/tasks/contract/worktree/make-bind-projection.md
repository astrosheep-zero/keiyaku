---
id: task/contract/worktree/make-bind-projection
title: Do not project into a refused occupied worktree path
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-30T18:29:29.806Z
updatedAt: 2026-08-30T18:56:10.291Z
---
Root cause is deterministic post-failure projection, not Place allocation or hooks. Git reconciliation correctly refuses an existing unregistered appointed path, but library reconciliation still unconditionally runs the Contract worktree projector, contaminating that foreign directory with derived guidance and making retries repeat the refusal. Project only after the invocation proves the managed worktree was successfully realized or retained as a registered worktree. Preserve the occupied-path refusal and every pre-existing byte; never auto-delete or classify a guidance-looking directory as safe. Regression: pre-create foreign appointed directory, bind/reconcile refuses and leaves it byte-identical with no guidance; move it aside, reconcile succeeds and then projects guidance.