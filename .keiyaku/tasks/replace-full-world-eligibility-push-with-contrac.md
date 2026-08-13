---
id: task/replace-full-world-eligibility-push-with-contrac
title: Replace full-world eligibility push with contract-local pull
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-13T04:43:39.380Z
updatedAt: 2026-08-13T06:23:47.782Z
---
Remove accumulated-world work from Contract placement. Claim mutates only the claimed Contract; eligibility is derived from a Contract and its declared prerequisites; bound is materialized atomically by the first operation that requires it. Partition the one state tree into active and terminal journal locators without introducing a second authority or reverse index.