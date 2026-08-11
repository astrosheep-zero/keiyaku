---
id: task/faye-复核-akuma-capability-harness-架构里
title: Faye 复核 Akuma capability harness 架构里程碑
state: done
priority: 1
needs:
  - task/实现-akuma-interrupt-非终止-put-down
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-08T17:40:51.926Z
updatedAt: 2026-08-08T19:59:04.440Z
contractId: null
---
在 Profile、status/wait/history 与 interrupt 完整 diff 和 verification evidence 可读后，通过 Square 向 Faye 提交一次自包含架构里程碑 review。要求根因级检查：用户 capability 与 custody primitive 是否分层正确；akuma.ts 是否零裁决；heart SQL/事务是否唯一权威；body/provider/runtime harness 是否物理闭环；是否存在重复代码、边界违反、概念错位、双权威或无读者机制。将可持续裁决写回 docs/akuma.md 所有者法并在同一 coherent change 收口，不以 task/Square 作为第二 law。