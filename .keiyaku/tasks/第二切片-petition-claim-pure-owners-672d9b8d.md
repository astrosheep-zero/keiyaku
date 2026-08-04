---
id: 第二切片-petition-claim-pure-owners-672d9b8d
title: 第二切片：petition/claim pure owners（Delivery Laws 5–8）
state: open
pri: 1
needs:
  - 收窄-refoperation-至-claim-单次-ca-d09b3da2
parent: null
from: []
createdAt: 2026-08-04T04:26:32.728Z
updatedAt: 2026-08-04T04:26:32.728Z
creator: thekoc
---
恢复四个已暂停路径（src/core/verbs/petition.ts、claim.ts、tests/verbs-petition.test.ts、tests/verbs-claim.test.ts），按法典 Delivery Laws 5–8 落地：

- petition：canonical candidate 构造（deterministic merge，actor/`at` 定 author/committer/timestamp，固定 message；同输入同 OID）；conflict = typed refusal；无 RefOperation，无 reconcile。
- claim：ClaimData={petition} 引用；全系统唯一 RefOperation（target expectedPredecessor → candidate）；无 shell preparation；ref-moved = 终态 petition-stale；gate approval.reviewedHead == petition.deliveryHead；reconcile = 结算清场。
- Nail 2 端到端。拒绝表（Delivery Refusals）不越线。

验收：faye 亲验 diff。
