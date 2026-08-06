---
id: v4-nullable-delivery-diff-transport
title: v4 nullable Delivery diff transport
state: in_progress
pri: 0
needs: []
parent: v4-architecture-correct-extensible-mvp
from: []
createdAt: 2026-08-06T01:52:34.978Z
updatedAt: 2026-08-06T01:52:48.923Z
creator: thekoc
startedAt: 2026-08-06T01:52:48.923Z
---
Implement docs/architecture.md Delivery.diff law through carrier and protocol: return string including empty string while predecessor and candidate are resolvable, return null after transport bytes disappear, and never leak raw Git lookup errors. Add a real Git GC-pruned regression. Do not change CLI rendering or Repo/Keiyaku construction in this slice.
