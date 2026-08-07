---
id: task/删除只读audit第二次carrier观察
title: 删除只读audit第二次carrier观察
state: drop
priority: 0
needs: []
parent: null
supersedes: []
relates: []
contractId: null
---
Audit report and accepted receipt in one invocation must describe one journal head. The initial read remains the producer/document observation. When Verification admits a fact, do not reread the moving carrier ref; read the immutable journal blob named by receipt.snapshot.head, validate/fold it through carrier observation code, and project AuditReport from exactly those entries. Read-only and nonterminal producer outcomes reuse the initial report. Do not put journal history in the public receipt, increment counters ad hoc, or add a cache.

已被无 public Receipt 的当前模型覆盖：audit 从本次接纳的不可变 journal facts 投影，不再存在 receipt.snapshot.head 二次读取机制。