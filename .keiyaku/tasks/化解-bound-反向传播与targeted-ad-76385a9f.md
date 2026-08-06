---
id: 化解-bound-反向传播与targeted-ad-76385a9f
title: 化解-bound-反向传播与targeted-admission复杂度矛盾
state: drop
pri: 0
needs: []
parent: null
from:
  - 审计剩余双权威重复门与隐含前提
notes:
  - actor: thekoc
    timestamp: 2026-08-06T23:05:11.665Z
    text: "Concrete contradiction: docs/lifecycle.md requires a prerequisite claimed offer to atomically append bound to every newly eligible dependent. src/protocol/intent.ts implements that by observeCarrierForAdmission and src/core/facts/eligibility.ts scans observation.keys(). Act 362 transport law requires targeted observation/admission O(touched journal size + bounded ancestor depth), never O(world), while banning reverse indexes and per-contract refs. A single placement cannot discover arbitrary reverse dependents under all three laws. Do not hide the scan in a helper. Resolve the product law first, then delete either proactive reverse propagation or the targeted complexity claim; preserve one authoritative readiness model."
createdAt: 2026-08-06T23:04:37.573Z
updatedAt: 2026-08-06T23:11:55.586Z
creator: thekoc
---
