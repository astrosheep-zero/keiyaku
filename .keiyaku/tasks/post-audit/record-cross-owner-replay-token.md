---
id: task/post-audit/record-cross-owner-replay-token
title: Record cross-owner replay-token review invariant
state: done
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T10:42:05.783Z
---
Add a small review/test template requiring each cross-owner saga to name its leading irreversible fact, durable replay token, consumption point, crash windows, and post-consumption failures. Do not build a generic saga framework.