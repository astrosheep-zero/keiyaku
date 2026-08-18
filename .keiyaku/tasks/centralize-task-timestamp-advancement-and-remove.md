---
id: task/centralize-task-timestamp-advancement-and-remove
title: Centralize Task timestamp advancement and remove dead projection
state: open
priority: 1
needs: []
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: ""
createdAt: 2026-08-18T03:33:12.842Z
updatedAt: 2026-08-18T03:33:12.842Z
---
在 Task owner 内只保留一份 updatedAt 单调推进规则：candidate 晚于 previous 时使用 candidate，否则 previous + 1ms。共享纯规则，但普通 mutation 继续按 mutation 捕获 clock，compose 继续在一次 invocation 内复用其捕获的 at。

删除生产和测试均无读者的 projectReady。恢复本切片触及的 Task 源码自然换行；测试只固定时间单调性、compose 单次 clock ownership 与删除后仍需成立的 board 投影，不按 helper 名测试。