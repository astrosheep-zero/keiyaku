---
id: task/拒绝-target-占用-keiyaku-自有-ref
title: 拒绝 target 占用 Keiyaku 自有 ref
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-06T21:19:40.386Z
updatedAt: 2026-08-07T11:29:07.455Z
contractId: null
---
按 docs/transport.md 的单一 ref ownership，public bind target 不得等于 carrier ref，也不得落在 managed delivery ref 或 candidate pin namespace。将三类 ref 命名常量收束到 carrier 的一个 owner，reconcile 与 bind target validation 复用；在记录 coordinates 前 TypeError 拒绝，不新增 lifecycle fact/refusal。添加三个自有命名拒绝和普通 target 保持可用的精准测试。