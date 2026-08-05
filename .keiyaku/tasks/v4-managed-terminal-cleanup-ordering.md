---
id: v4-managed-terminal-cleanup-ordering
title: v4 managed terminal cleanup ordering
state: done
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-05T09:19:52.741Z
updatedAt: 2026-08-05T11:18:09.713Z
creator: thekoc
---
Fix managed terminal reconcile so it removes Keiyaku-owned delivery worktrees and refs in an order that remains usable from any invocation cwd, including the managed worktree itself. Preserve here ownership: never mutate the caller worktree or branch. Add a real-shell regression that asserts fulfilled and abandoned terminal cleanup leaves no managed delivery/candidate resources and reports typed lag only for genuine failure.
