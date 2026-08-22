---
id: task/failure-cleanup
title: Failure cleanup
state: done
priority: 2
needs: []
parent: task/replace-worktree-hook-recovery-delay-with-explic
supersedes: []
relates: []
note: Focused test passes; finally releases the hook process, awaits replay, terminates the caller, and removes temporary custody.
createdBy: aku/worker-2/b0286eb4
createdAt: 2026-08-20T12:13:03.279Z
updatedAt: 2026-08-20T12:37:09.416Z
---
Prove killed callers, replay, and failure paths release descriptors/processes and clean temporary resources.