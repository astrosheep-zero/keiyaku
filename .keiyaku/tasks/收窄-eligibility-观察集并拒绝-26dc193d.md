---
id: task/收窄-eligibility-观察集并拒绝-26dc193d
title: 收窄 eligibility 观察集并拒绝未知前驱
state: drop
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T04:49:02.331Z
updatedAt: 2026-08-07T11:29:07.456Z
---
按 docs/lifecycle.md Eligibility：bind/amend 只观察自身与 after；claimed 才观察全世界。bind/amend 对未解析 after 返回 unknown-prerequisite。删除 bind/amend 的全量 observeCarrier 与 placeEligibleBounds 路径，保持 bound 与触发事实同 offer。

旧任务要求 bind/amend 只观察直接 after，与当前权威的传递前驱闭包和环拒绝冲突；现行闭包观察由已完成任务统一实现。