---
id: v4-repo-first-public-scope-and-protocol-reads
title: v4 Repo-first public scope and protocol reads
state: open
pri: 0
needs: []
parent: v4-architecture-correct-extensible-mvp
from: []
supersedes:
  - v4-carrier-scoped-public-library-and-cl-4b84cf51
createdAt: 2026-08-06T01:52:23.307Z
updatedAt: 2026-08-06T01:52:23.307Z
creator: thekoc
---
Implement the settled Repo-first library scope in docs/architecture.md Public Library And First-Class Domain Objects and Layer Contracts. Add protocol-owned repository status/reconcile reads, make carrier repository resolution require an explicit path, and expose the protocol operations needed by Repo without changing CLI or document parsing. Remove no public Keiyaku statics in this slice; integration owns that migration.
