---
id: 收窄-eligibility-观察集并拒绝-26dc193d
title: 收窄 eligibility 观察集并拒绝未知前驱
state: open
pri: 0
needs: []
parent: null
from: []
createdAt: 2026-08-06T18:46:50.613Z
updatedAt: 2026-08-06T18:46:50.613Z
creator: thekoc
---
按 docs/lifecycle.md Eligibility：bind/amend 只观察自身与 after；claimed 才观察全世界。bind/amend 对未解析 after 返回 unknown-prerequisite。删除 bind/amend 的全量 observeCarrier 与 placeEligibleBounds 路径，保持 bound 与触发事实同 offer。
