---
id: 拆除复合-admission-receipt-与-plac-5a098c75
title: 拆除复合 admission receipt 与 placement 吞错
state: in_progress
pri: 0
needs:
  - attestation-subject-统一证词与-gat-da92658b
parent: null
from: []
createdAt: 2026-08-06T05:42:38.723Z
updatedAt: 2026-08-06T21:41:18.107Z
creator: thekoc
startedAt: 2026-08-06T09:13:08.258Z
---
依据 docs/lifecycle.md、docs/public-api.md、docs/cli.md 以及 Square act_358 的最终裁决，重塑 deliver/review 的 composed result：

- 顶层 refused/retry 严格断言本次调用零 journal fact；只有被调用 verb 自身的 admission 可以决定这两臂。
- 一旦 verb fact admitted，外层不可逆地 accepted，并携带本次调用全部 admitted facts。
- trailing verification/placement 最多产生一个 presence-discriminated halt {step, reason}；halt 立即停序列，后续步骤不执行，不得覆写 outer arm。
- 删除 verification/placement/attempt 分散字段与 per-step stop 复写；runtime timeout/spawn-error/unknown-exit 也是 verification halt reason。
- prior/snapshot 只作 protocol 内部折叠材料，不进入持久权威；不得从 value 再挖 facts。
- CLI accepted exit 0，统一渲染 halt <step> <json>；拒绝 boolean skip、step 数组、多 halt、halt 后补偿/重试。

先把 act_358 整合进三份 owner docs，再实施。精准回归覆盖：deliver 已落后 placement terminal、gates-unsatisfied 可见、verification timeout 停止 placement、refused/retry 恒零 facts。