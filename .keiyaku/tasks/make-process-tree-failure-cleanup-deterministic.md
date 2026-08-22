---
id: task/make-process-tree-failure-cleanup-deterministic
title: Make process-tree failure cleanup deterministic
state: open
priority: 1
needs: []
parent: task/stabilize-runtime-process-test-synchronization
supersedes: []
relates: []
note: ""
createdBy: aku/worker-2/3ad6a87d
createdAt: 2026-08-20T12:13:16.362Z
updatedAt: 2026-08-20T12:41:43.926Z
---
Use observable shutdown events with bounded deadlines and ensure probe resources close once on every failure path.