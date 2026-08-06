---
id: v4-protocol-only-public-operation-orchestration
title: v4 protocol-only public operation orchestration
state: done
pri: 0
needs: []
parent: v4-architecture-correct-extensible-mvp
from:
  - v4-concept-and-primitive-audit
createdAt: 2026-08-06T00:15:16.932Z
updatedAt: 2026-08-06T01:20:07.580Z
creator: thekoc
---
Move composite Keiyaku/Delivery operation orchestration out of the public facade into protocol, enforce library-to-protocol-only dependency, and preserve the exact public API and receipts. Authority: docs/architecture.md Public Library and Pact/Protocol sections; expert finding 1.