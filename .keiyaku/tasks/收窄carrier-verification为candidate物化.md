---
id: task/收窄carrier-verification为candidate物化
title: 收窄carrier-verification为candidate物化
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
contractId: null
---
Remove carrier lifecycle/currentness adjudication from Verification preparation. protocol owns lifecycle observation; carrier accepts the already selected candidate SnapshotId and only materializes/disposes its temporary worktree. Delete the unread returned candidate and null branch. Preserve physical Git failures.