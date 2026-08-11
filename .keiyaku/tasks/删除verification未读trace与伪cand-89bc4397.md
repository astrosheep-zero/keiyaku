---
id: task/删除verification未读trace与伪cand-89bc4397
title: 删除verification未读trace与伪candidate坐标
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T04:47:51.608Z
updatedAt: 2026-08-07T11:29:07.447Z
---
Production consumers read only Verification outcome kind plus terminal verdict/summary. Delete readerless plan/executions/execution payloads. ProduceVerificationInput.candidateTree is only regex-validated and does not bind the actual cwd; delete it and its validator. Keep runtime process outcome local to the producer loop and preserve external terminal/timeout/spawn-error/unknown-exit behavior.