---
id: v4-carrier-owned-contract-journal-path
title: v4 carrier-owned contract journal path
state: done
pri: 0
needs: []
parent: v4-architecture-correct-extensible-mvp
from:
  - v4-concept-and-primitive-audit
createdAt: 2026-08-06T00:15:17.732Z
updatedAt: 2026-08-06T01:20:19.504Z
creator: thekoc
---
Move the kei identity to contracts/*.jsonl projection from pact into carrier, update all readers/tests, and add an ownership guard. Authority: docs/architecture.md Identity Coordinates lines 275-276; expert finding 2.