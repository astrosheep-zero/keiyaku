---
id: task/收束-protocol-内部编排原语并-9f308fa6
title: 收束 protocol 内部编排原语并恢复行数预算
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T04:48:14.457Z
updatedAt: 2026-08-07T11:29:07.455Z
contractId: null
---
按现行 docs/lifecycle.md、docs/verification.md、docs/public-api.md 做零产品语义变更的内部重塑：

1. intent 只保留一个通用 admission 入口；删除 bind/amend/deliver/abandon/arc 五个纯转发 wrapper，但不得复活 composed lifecycle runner。
2. Verification 只保留“给定已观测 ContractState，执行 producer 并尝试 admission”的一个入口。deliver 直接传 accepted receipt snapshot；audit 传自己的 initial state。删除 prepared/stored 双实现及多余 observe。
3. operations 只增加一个私有 receipt-step fold，统一 accepted facts/snapshot 合并与 refused/retry StepStop。不得改变事实顺序、outer outcome、公开类型或持久化。
4. 保持可读格式，不以压缩空行或折叠类型骗过 7000 行预算。跑 intent/operations 相关精准测试、typecheck、architecture。

Audit finding: IntentAdmissionOptions.placeEligibleBounds is a single-caller boolean mode that silently changes a targeted intent into full-world observation, mints extra entries, and rewrites the offer. Only admitPlacement uses it. Remove this semantic switch from generic admitIntent; keep admitIntent as the narrow targeted observe/decide/admit primitive and make the explicitly full-world placement path own eligible-bound propagation. Do not create a generic lifecycle runner.

Small clarity cut: boundedAttempts(entryCount) hides two quantities and implements the attempt budget as [0,1,2]. Keep the settled private budget of three, but name MAX_SEMANTIC_ATTEMPTS and mintAttempts({attemptCount, entryCount}) or an equivalent unambiguous helper. No public retry knob and no new product rule.