---
id: task/isolate-git-index-writes-during
title: Isolate Git index writes during conflict materialization and delivery
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: Private-index conflict capture Contract was independently reviewed satisfied, claimed, and integrated as df8c6b4e.
createdAt: 2026-08-27T13:09:52.529Z
updatedAt: 2026-08-30T07:02:56.000Z
---
When deliver materializes a target-moved conflict, resolving the conflict requires index state, but a worker must not mutate the shared repository index or stage unrelated files. Define and implement an isolated GIT_INDEX_FILE/object-store path for conflict resolution and delivery handoff. Preserve all foreign worktree changes, mark only resolved Contract files, and verify with status, tests, and a delivery attempt. This task tracks the coordination bug discovered while delivering kei/remove-durable-worktree-hook-marker.