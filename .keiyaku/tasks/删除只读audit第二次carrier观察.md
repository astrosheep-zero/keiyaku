---
id: 删除只读audit第二次carrier观察
title: 删除只读audit第二次carrier观察
state: open
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-06T17:18:44.155Z
updatedAt: 2026-08-06T17:18:52.837Z
creator: thekoc
---
auditOperation already has initial readAudit. When verifyDelivery returns null, no process or admission ran, so return the initial report/empty receipt without a second full carrier observation. Preserve the second observation after any producer attempt, admission, refusal, or retry.