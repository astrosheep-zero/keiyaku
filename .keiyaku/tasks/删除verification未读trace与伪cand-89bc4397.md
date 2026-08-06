---
id: 删除verification未读trace与伪cand-89bc4397
title: 删除verification未读trace与伪candidate坐标
state: open
pri: 0
needs: []
parent: null
from: []
createdAt: 2026-08-06T17:10:29.936Z
updatedAt: 2026-08-06T17:10:43.957Z
creator: thekoc
---
Production consumers read only Verification outcome kind plus terminal verdict/summary. Delete readerless plan/executions/execution payloads. ProduceVerificationInput.candidateTree is only regex-validated and does not bind the actual cwd; delete it and its validator. Keep runtime process outcome local to the producer loop and preserve external terminal/timeout/spawn-error/unknown-exit behavior.