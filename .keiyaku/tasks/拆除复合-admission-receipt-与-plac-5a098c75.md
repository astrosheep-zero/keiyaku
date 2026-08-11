---
id: task/拆除复合-admission-receipt-与-plac-5a098c75
title: 拆除复合 admission receipt 与 placement 吞错
state: done
priority: 0
needs:
  - task/attestation-subject-统一证词与-gat-da92658b
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T04:47:49.230Z
updatedAt: 2026-08-07T11:29:07.454Z
---
依据 docs/lifecycle.md、docs/verification.md、docs/public-api.md、docs/cli.md 与 Square act_360 的最终勘误，重塑 composed operation 公开结果：

- leading act 单独决定 outer arm：写 verb 是自己的 journal admission，audit 是 observation report。refused/retry 断言本次调用零 facts；leading act 完成后 outer 永远 accepted。
- Verification producer、attestation admission、placement 是独立义务，固定顺序但每项无条件运行，只通过 admitted facts 通信。前一项 stop 不取消后一项，一次调用可有两个 stop。
- deliver value 保留 verification?/placement? 两个独立 presence-discriminated channel；review 只有 placement?；audit 把同型 VerificationStop 放在 AuditReport.attempt。
- VerificationStop 统一 runtime nonterminal 与 attestation refusal/retry；PlacementStop 统一 placement refusal/retry。gates-unsatisfied 必须可见。
- package-root accepted 改为 {facts, head, value}；删除公开 Receipt/prior/snapshot。prior/snapshot 仅 protocol 私有合成材料。
- CLI accepted exit 0，逐 channel 渲染 stop <obligation> <json>；不得从 value 挖 facts、不得加单 halt、停序列、skip boolean 或兼容字段。

验收：gates=[] + Verification timeout 仍 claimed；verified gate + timeout 同时有 verification/placement stop；audit attestation refusal accepted+facts=[]+typed attempt；package root 不可达 prior/snapshot；refused/retry 恒零 facts。

Remaining blocker from independent review: audit manufactures ProtocolReceipt values with facts:[]/prior/snapshot/journal even when no admission occurred, then CLI resultFromOutcome treats that fake write receipt like every accepted mutation and invokes contract.reconcile(). Split internal read-observation acceptance from admission receipts; audit still maps publicly to accepted Outcome with zero facts and observed head, but never gains mutation/reconcile authority from a synthetic receipt.