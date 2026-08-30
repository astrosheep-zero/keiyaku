---
id: task/map-current-contract-audit
title: Map current Contract audit request boundary
state: done
priority: 0
needs: []
parent: task/architecture-ownership/inject-one-per-drive-execution
supersedes: []
relates: []
note: Mapped the current Contract request index and completed the audit forwarding implementation.
createdBy: aku/worker/4b5380b1
createdAt: 2026-08-28T13:05:53.127Z
updatedAt: 2026-08-28T13:57:09.877Z
---
Discovery: the Arc Region names the superseded request-execution.ts, while current main locates the predecessor's closed Contract request command index in src/library/contract-operations.ts. Map the minimal audit request/result/service-evidence integration without creating another command algebra.