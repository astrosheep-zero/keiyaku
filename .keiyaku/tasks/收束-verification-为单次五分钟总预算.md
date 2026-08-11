---
id: task/收束-verification-为单次五分钟总预算
title: 收束 Verification 为单次五分钟总预算
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-06T20:34:40.568Z
updatedAt: 2026-08-07T11:29:07.456Z
---
docs/verification.md 定义每次 Verification run 只有固定五分钟预算。当前 producer 把完整 timeoutMs 传给每个有序 declaration，N 个脚本最坏运行 N × timeoutMs。以一个 invocation deadline 给每个后续 process 传剩余预算；预算耗尽立即返回 timeout。保持同步顺序、非零继续、非终态不入账，不引入后台 runner、lease、cache 或设置项。测试使用可控 process seam 精确证明第二步只获得剩余预算，不使用真实等待。