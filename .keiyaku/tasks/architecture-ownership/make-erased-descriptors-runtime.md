---
id: task/architecture-ownership/make-erased-descriptors-runtime
title: Make erased descriptors runtime safe
state: done
priority: 0
needs: []
parent: task/architecture-ownership/close-the-heart-owner-index-and
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T09:01:01.906Z
updatedAt: 2026-08-28T09:10:00.634Z
---
Eliminate unknown execution context and owner casts from the erased request descriptor. Runtime-decode every request, live result, durable service, and stored reference at its owning Fleet, Contract, Task, or Akuma boundary; validate canonical AkuId and complete wait observations; classify malformed cross-process values as transport-integrity failures.