---
id: predecessor-chaining-显式前驱与after默认
title: predecessor-chaining-显式前驱与after默认
state: drop
pri: 1
needs:
  - candidate-pin-ref-reconcile-活petition-f2b7d1a6
  - after-intent-fact-bind-amend-advisory
parent: null
from: []
createdAt: 2026-08-04T10:58:41.545Z
updatedAt: 2026-08-05T08:48:15.898Z
creator: thekoc
---
Implement act_203 predecessor chaining. Petition accepts caller-selected expectedPredecessor without requiring it to equal observed target head; default selection belongs to the flagship/edge and may use an unambiguous live petition candidate from after intent. Kernel does not sort or queue; claim CAS remains the sole target authority. Preserve PetitionData shape and terminal petition-stale: target must equal the petition premise for claim, and a broken predecessor/external movement becomes stale. Add chain tests where predecessor claim lands unchanged and broken chain becomes terminal stale. No seat numbering, queue storage, or automatic reordering.
