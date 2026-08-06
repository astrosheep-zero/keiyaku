---
id: 删除只读audit第二次carrier观察
title: 删除只读audit第二次carrier观察
state: in_progress
pri: 0
needs: []
parent: null
from: []
createdAt: 2026-08-06T17:18:44.155Z
updatedAt: 2026-08-06T21:16:24.548Z
creator: thekoc
startedAt: 2026-08-06T17:18:53.382Z
---
Audit report and accepted receipt in one invocation must describe one journal head. The initial read remains the producer/document observation. When Verification admits a fact, do not reread the moving carrier ref; read the immutable journal blob named by receipt.snapshot.head, validate/fold it through carrier observation code, and project AuditReport from exactly those entries. Read-only and nonterminal producer outcomes reuse the initial report. Do not put journal history in the public receipt, increment counters ad hoc, or add a cache.
