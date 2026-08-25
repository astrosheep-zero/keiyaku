---
id: task/maintainability-owner-refactor/split-architecture-policy
title: Split architecture policy composition and source analysis
state: done
priority: 0
needs: []
parent: task/maintainability-owner-refactor/return-all-oversized-source
supersedes:
  - task/replace-source-topology-architecture-allowlists
relates: []
note: ""
createdAt: 2026-08-24T01:49:58.212Z
updatedAt: 2026-08-24T02:23:41.976Z
---
Keep one composed ArchitecturePolicy. Move zones into domain-owned declaration fragments and separate TypeScript source analysis from graph and policy diagnostics. Every resulting source file stays below 500.