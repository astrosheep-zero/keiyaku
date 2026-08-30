---
id: task/architecture-ownership/move-task-request-semantics-to
title: Move Task request semantics to its owner
state: done
priority: 0
needs:
  - task/architecture-ownership/move-contract-request-semantics
parent: task/architecture-ownership/detach-heart-lifecycle-from
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T07:30:52.384Z
updatedAt: 2026-08-28T07:58:24.483Z
---
Arc 3: every Task mutation owns request, complete live-result, durable-evidence, execution, and replay descriptors without a central Task union in generic request code.