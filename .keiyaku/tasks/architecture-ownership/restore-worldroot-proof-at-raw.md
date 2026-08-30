---
id: task/architecture-ownership/restore-worldroot-proof-at-raw
title: Restore WorldRoot proof at raw boundaries
state: done
priority: 1
needs:
  - task/architecture-ownership/inject-one-per-drive-execution
parent: task/architecture-ownership/reduce-request-execution-and
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T03:35:26.188Z
updatedAt: 2026-08-29T19:26:48.712Z
---
Keep WorldRoot as a canonical physical coordinate minted only by the World namespace. Replace boundary casts with the existing resolver appropriate to each caller without conflating canonical identity with marker existence.