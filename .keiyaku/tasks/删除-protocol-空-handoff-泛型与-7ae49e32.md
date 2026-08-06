---
id: 删除-protocol-空-handoff-泛型与-7ae49e32
title: 删除 protocol 空 handoff 泛型与伪 reconcile 语义
state: open
pri: 1
needs:
  - 拆除复合-admission-receipt-与-plac-5a098c75
parent: null
from: []
createdAt: 2026-08-06T05:43:30.557Z
updatedAt: 2026-08-06T05:43:30.557Z
creator: thekoc
---
所有 pact verb 的 OfferDecision handoff 均恒为 null；ReconcileHandoff.handoff 与 admission 没有任何生产语义或读者，operations 只读取 acceptedEntries/prior/snapshot。当前命名把 protocol acceptance 错称为 reconcile handoff，并为不存在的未来值传播泛型。

在复合 admission/outcome 法定稿并落地后，删除 Handoff 泛型、每个 verb 的 handoff:null、未读 admission 字段与对应嵌套包装；把成功分支命名并建模为真实 accepted protocol receipt。保留 unknown recovery 所需的 durable fact recognition，不引入 handoff ledger 或兼容壳。
