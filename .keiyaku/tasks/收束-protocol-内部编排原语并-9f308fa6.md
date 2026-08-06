---
id: 收束-protocol-内部编排原语并-9f308fa6
title: 收束 protocol 内部编排原语并恢复行数预算
state: in_progress
pri: 0
needs: []
parent: null
from:
  - 拆除复合-admission-receipt-与-plac-5a098c75
  - 迁移-library-方言与-verification-aca216f8
createdAt: 2026-08-06T16:28:55.578Z
updatedAt: 2026-08-06T16:29:35.434Z
creator: thekoc
startedAt: 2026-08-06T16:29:35.434Z
---
按现行 docs/lifecycle.md、docs/verification.md、docs/public-api.md 做零产品语义变更的内部重塑：

1. intent 只保留一个通用 admission 入口；删除 bind/amend/deliver/abandon/arc 五个纯转发 wrapper，但不得复活 composed lifecycle runner。
2. Verification 只保留“给定已观测 ContractState，执行 producer 并尝试 admission”的一个入口。deliver 直接传 accepted receipt snapshot；audit 传自己的 initial state。删除 prepared/stored 双实现及多余 observe。
3. operations 只增加一个私有 receipt-step fold，统一 accepted facts/snapshot 合并与 refused/retry StepStop。不得改变事实顺序、outer outcome、公开类型或持久化。
4. 保持可读格式，不以压缩空行或折叠类型骗过 7000 行预算。跑 intent/operations 相关精准测试、typecheck、architecture。
