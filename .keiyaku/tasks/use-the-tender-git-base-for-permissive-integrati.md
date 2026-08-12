---
id: task/use-the-tender-git-base-for-permissive-integrati
title: Use the tender Git base for permissive integration
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-12T02:22:46.362Z
updatedAt: 2026-08-12T02:31:44.499Z
---
Fix targeted permissive integration so a managed Contract worktree rebased onto the current target no longer conflicts against immutable ContractCoordinates.start. Keep start as birth topology; derive the three-way base from current tender HEAD and observed target under Git. Add regression coverage and update the Git owner. This blocks delivery of task/split-bind-guidance-and-tighten-formal-documenta.