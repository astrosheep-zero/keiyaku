---
id: 复用准备拒绝与receipt唯一类型来源
title: 复用准备拒绝与Receipt唯一类型来源
state: done
pri: 0
needs: []
parent: null
from:
  - 审计剩余双权威重复门与隐含前提
createdAt: 2026-08-06T18:15:57.890Z
updatedAt: 2026-08-07T04:47:54.479Z
creator: thekoc
---
Owner: docs/lifecycle.md Protocol And Admission and docs/public-api.md Outcomes And Reports; latest act_360 public outcome law is already integrated there.

Package root has no Receipt/prior/snapshot. Protocol may retain only the process-local accepted state/journal values with named composition readers, including the accepted snapshot required by the single-observation handoff law. Delete unused `prior`; collapse `AttemptReceipt` and `ProtocolReceipt` into one internal type source; do not export that type through protocol operations; remove the implicit "primary append is whichever contains attempt.entryUlids[0]" convention by passing the owning contract coordinate explicitly if the accepted head/state needs it. Preserve accepted facts/head semantics, unknown recovery, audit report construction, and trailing-obligation composition. Add precise internal tests; do not restore a public Receipt or persist any handoff.
