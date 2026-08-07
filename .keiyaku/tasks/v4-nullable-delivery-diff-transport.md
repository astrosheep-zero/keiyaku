---
id: task/v4-nullable-delivery-diff-transport
title: v4 nullable Delivery diff transport
state: done
priority: 0
needs: []
parent: task/v4-architecture-correct-extensible-mvp
supersedes: []
relates: []
contractId: null
---
Implement docs/architecture.md Delivery.diff law through carrier and protocol: return string including empty string while predecessor and candidate are resolvable, return null after transport bytes disappear, and never leak raw Git lookup errors. Add a real Git GC-pruned regression. Do not change CLI rendering or Repo/Keiyaku construction in this slice.