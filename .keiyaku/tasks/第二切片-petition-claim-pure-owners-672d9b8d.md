---
id: task/第二切片-petition-claim-pure-owners-672d9b8d
title: 第二切片：petition/claim pure owners（Delivery Laws 5–8）
state: done
priority: 1
needs:
  - task/收窄-refoperation-至-claim-单次-ca-d09b3da2
parent: null
supersedes: []
relates: []
contractId: null
---
恢复四个已暂停路径（src/core/verbs/petition.ts、claim.ts、tests/verbs-petition.test.ts、tests/verbs-claim.test.ts），按法典 Delivery Laws 5–8 落地：

- petition：canonical candidate 构造（deterministic merge，actor/`at` 定 author/committer/timestamp，固定 message；同输入同 OID）；conflict = typed refusal；无 RefOperation，无 reconcile。
- claim：ClaimData={petition} 引用；全系统唯一 RefOperation（target expectedPredecessor → candidate）；无 shell preparation；ref-moved = 终态 petition-stale；gate approval.reviewedHead == petition.deliveryHead；reconcile = 结算清场。
- Nail 2 端到端。拒绝表（Delivery Refusals）不越线。

验收：faye 亲验 diff。

验收方式修订（user 指示）：faye 不亲读 diff。root 在 square 报确切 diff 后，由 faye 派 akuma 对照 Delivery Laws 5–8 与 Nail 2 复核，复核结论经 square 裁决放行。上一条 d09b3da2 同规则。

Milestone implementation complete pending Square/Faye acceptance: petition pure owner split from shell-bound candidate preparation; claim owns sole target CAS and terminal petition-stale; candidate metadata follows Act 198 (actor exact name, fixed keiyaku@keiyaku.invalid email, author == committer, fixed parents/message); claim no longer imports admission; stale tests distinguish carrier commit from journal head. Verification: focused 12/12, full 100/100, source typecheck, build, and git diff --check pass. Square act #43 requests the task-prescribed Akuma review. CLI task now also needs actor-来源-keiyaku-projection-id-注-9d9b432c so architecture-correct MVP precedes dogfood.