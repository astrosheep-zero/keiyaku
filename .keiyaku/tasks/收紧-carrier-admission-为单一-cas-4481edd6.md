---
id: task/收紧-carrier-admission-为单一-cas-4481edd6
title: 收紧 carrier admission 为单一 CAS 结果模型
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-06T07:34:00.885Z
updatedAt: 2026-08-07T11:29:07.457Z
---
ContractJournalAppend.expectedHead 在类型与 carrier 中可省略并回退到 carrier 当场观察值，但 protocol 明确拒绝省略，全部生产代码也总是提供它；这留下了一套无人使用的隐式 CAS 模式。Admission 结果同时保留无人读取的 ok 判别，以及 accepted 分支无人读取的 carrierCommit/carrierTree。封闭 union 又混用 interface 与 type。

令 expectedHead 成为必填，删除 carrier fallback 与对应防御分支。以 kind 作为唯一判别，按实际读者收窄 accepted payload，并把这些内部封闭 data variants 统一为 readonly type aliases。不得删除仍会进入 public retry 诊断的 ref/head movement grounds。补 carrier 边界测试，证明显式 predecessor 是唯一 admission 入口。