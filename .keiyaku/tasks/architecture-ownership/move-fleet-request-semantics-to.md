---
id: task/architecture-ownership/move-fleet-request-semantics-to
title: Move Fleet request semantics to its owner
state: done
priority: 0
needs: []
parent: task/architecture-ownership/detach-heart-lifecycle-from
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T07:30:40.089Z
updatedAt: 2026-08-28T07:37:49.616Z
---
Arc 1: Fleet wait, tell, and kill own their request, live-result, durable-evidence, execution, and replay descriptors. Generic request code retains only framing and lifecycle.