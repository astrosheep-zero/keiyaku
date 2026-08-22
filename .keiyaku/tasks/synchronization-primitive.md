---
id: task/synchronization-primitive
title: Synchronization primitive
state: done
priority: 2
needs: []
parent: task/replace-worktree-hook-recovery-delay-with-explic
supersedes: []
relates: []
note: Implemented process-signal start/release handshake with deferred promises; removed polling and watcher/FIFO coordination.
createdBy: aku/worker-2/b0286eb4
createdAt: 2026-08-20T12:13:03.279Z
updatedAt: 2026-08-20T12:37:09.156Z
---
Choose and implement the minimal explicit signal for hook start/release; no polling, watcher, or sleep.