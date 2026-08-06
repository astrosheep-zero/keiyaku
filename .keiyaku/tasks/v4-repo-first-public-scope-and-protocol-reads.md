---
id: v4-repo-first-public-scope-and-protocol-reads
title: v4 Repo-first public scope and protocol reads
state: drop
pri: 0
needs: []
parent: v4-architecture-correct-extensible-mvp
from: []
supersedes:
  - v4-carrier-scoped-public-library-and-cl-4b84cf51
notes:
  - actor: thekoc
    timestamp: 2026-08-06T02:11:55.613Z
    text: Public Repo bind/contract premise was superseded by Act 325. Its explicit carrier scope and aggregate status/reconcile implementation remains evidence for the replacement integration.
createdAt: 2026-08-06T01:52:23.307Z
updatedAt: 2026-08-06T02:11:55.613Z
creator: thekoc
---
Implement the settled Repo-first library scope in docs/architecture.md Public Library And First-Class Domain Objects and Layer Contracts. Add protocol-owned repository status/reconcile reads, make carrier repository resolution require an explicit path, and expose the protocol operations needed by Repo without changing CLI or document parsing. Remove no public Keiyaku statics in this slice; integration owns that migration.
