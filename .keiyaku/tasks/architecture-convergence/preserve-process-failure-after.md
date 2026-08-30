---
id: task/architecture-convergence/preserve-process-failure-after
title: Preserve process failure after owned exit
state: done
priority: 0
needs: []
parent: task/architecture-convergence/close-or-bind-residual
supersedes: []
relates: []
note: ""
createdAt: 2026-08-29T20:24:04.043Z
updatedAt: 2026-08-29T20:44:35.892Z
---
Fix terminateOwnedProcess so a POSIX group-signal EPERM cannot mask an originating operation failure when the directly owned child concurrently proves exit. Do not ignore EPERM globally: only a bounded owned-handle exit proof may settle it; otherwise preserve the signal failure. Add deterministic runtime/Git proof and restore the focused test.