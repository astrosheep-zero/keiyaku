---
id: task/architecture-ownership/detach-heart-lifecycle-from
title: Detach Heart lifecycle from forwarded command semantics
state: done
priority: 0
needs: []
parent: task/architecture-ownership/reduce-request-execution-and
supersedes: []
relates: []
note: Heart opaque lifecycle is implemented and focused request tests pass; remaining work moves generic wire codecs and owner-side live-result decoders.
createdAt: 2026-08-28T03:35:26.188Z
updatedAt: 2026-08-28T12:40:02.940Z
---
Make Heart own only authenticated request admission, opaque durable request/service bytes, and generic lifecycle transitions. Keep Soul-owned permission vocabulary separate from the closed verb codec index. Add runtime decoding for live Contract, Fleet, and Task results; remove the SQL business-action vocabulary and duplicate ContractId validation. This is the first delivery.