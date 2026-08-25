---
id: task/maintainability-owner-refactor/isolate-terminal-git
title: Isolate terminal Git reconciliation under the existing lock
state: done
priority: 1
needs: []
parent: task/maintainability-owner-refactor/return-all-oversized-source
supersedes: []
relates: []
note: Current-main replacement Contract landed and claimed the owner split.
createdAt: 2026-08-24T01:49:58.212Z
updatedAt: 2026-08-24T04:32:20.410Z
---
Move terminal seal observation, recovery snapshot, worktree cleanup, and ref custody release behind one typed terminal reconciliation operation. The top-level reconcile function retains the sole per-Contract lock and calls the operation while holding it.