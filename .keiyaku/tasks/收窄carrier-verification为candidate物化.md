---
id: 收窄carrier-verification为candidate物化
title: 收窄carrier-verification为candidate物化
state: done
pri: 0
needs: []
parent: null
from: []
createdAt: 2026-08-06T17:07:52.049Z
updatedAt: 2026-08-07T04:47:50.911Z
creator: thekoc
---
Remove carrier lifecycle/currentness adjudication from Verification preparation. protocol owns lifecycle observation; carrier accepts the already selected candidate SnapshotId and only materializes/disposes its temporary worktree. Delete the unread returned candidate and null branch. Preserve physical Git failures.