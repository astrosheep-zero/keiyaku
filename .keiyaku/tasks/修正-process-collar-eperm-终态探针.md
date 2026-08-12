---
id: task/修正-process-collar-eperm-终态探针
title: 修正 process collar EPERM 终态探针
state: drop
priority: 1
needs: []
parent: task/complete-the-provider-core-capability-model
supersedes: []
relates: []
note: "Rejected: POSIX kill(-pgid, 0) EPERM proves the process group still exists but is inaccessible. A missing or recycled leader PID does not prove descendants in that group are gone, so projecting gone would create a false terminal. Current unverifiable is the honest result."
createdAt: 2026-08-09T01:10:11.089Z
updatedAt: 2026-08-12T16:35:47.413Z
---
以 docs/akuma.md collar 证据法与 runtime/proc ownership 为边界：probeProcessTree 遇到 kill(-pgid,0) EPERM 时核对 recorded pid start token；token 消失或不匹配判 gone，仅匹配时保持 unverifiable。补并发负载 fork regression；不得在 Akuma 层补丁。来源：act_81 nonblocker 3。