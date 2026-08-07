---
id: task/消除-core-eligibility-与-gates-的-9e02421c
title: 消除 core eligibility 与 gates 的二次扫描
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T04:47:50.431Z
updatedAt: 2026-08-07T11:29:07.459Z
contractId: null
---
保持 docs/lifecycle.md 的 eligibility 和 gate 语义不变，清除随合同/证词数量平方增长的实现：

- placeEligibleBounds 对 offer facts 建一次 ContractId 索引，以游标消费可用 ULID；不得在 observed-contract 循环中反复 find 或 Array.shift。
- gatesSatisfied 一次逆序扫描 attestations，以 declared gate Set 和 per-gate seen-subject 保持“同 gate+subject 最新 testimony + current subject”语义；不得逐 gate 重扫整段历史。
- gateSatisfied 单 gate 读面保留。currentness 仍只调用 core subjectIsCurrent，不复制 dependency-key 判断。
- 不新增 registry/provider/缓存状态，不改事实、公有 API 或持久化。跑 dependency-currentness、eligibility、library placement 精准测试、typecheck、architecture。