---
id: task/architecture-ownership/move-akuma-request-semantics-to
title: Move Akuma request semantics to its owner
state: done
priority: 0
needs:
  - task/architecture-ownership/move-task-request-semantics-to
parent: task/architecture-ownership/detach-heart-lifecycle-from
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T07:30:58.826Z
updatedAt: 2026-08-28T08:07:35.152Z
---
Arc 4: the Akuma call owner owns its request, child reservation, live result, durable evidence, and replay descriptor; Heart recovery remains payload-blind and uses stored child plus parent World.