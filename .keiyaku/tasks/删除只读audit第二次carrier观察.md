---
id: 删除只读audit第二次carrier观察
title: 删除只读audit第二次carrier观察
state: drop
pri: 0
needs: []
parent: null
from: []
notes:
  - actor: thekoc
    timestamp: 2026-08-07T04:49:00.971Z
    text: 已被无 public Receipt 的当前模型覆盖：audit 从本次接纳的不可变 journal facts 投影，不再存在 receipt.snapshot.head 二次读取机制。
createdAt: 2026-08-06T17:18:44.155Z
updatedAt: 2026-08-07T04:49:00.971Z
creator: thekoc
---
Audit report and accepted receipt in one invocation must describe one journal head. The initial read remains the producer/document observation. When Verification admits a fact, do not reread the moving carrier ref; read the immutable journal blob named by receipt.snapshot.head, validate/fold it through carrier observation code, and project AuditReport from exactly those entries. Read-only and nonterminal producer outcomes reuse the initial report. Do not put journal history in the public receipt, increment counters ad hoc, or add a cache.
