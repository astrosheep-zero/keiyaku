---
id: task/v4-managed-terminal-cleanup-ordering
title: v4 managed terminal cleanup ordering
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
contractId: null
---
Fix managed terminal reconcile so it removes Keiyaku-owned delivery worktrees and refs in an order that remains usable from any invocation cwd, including the managed worktree itself. Preserve here ownership: never mutate the caller worktree or branch. Add a real-shell regression that asserts fulfilled and abandoned terminal cleanup leaves no managed delivery/candidate resources and reports typed lag only for genuine failure.