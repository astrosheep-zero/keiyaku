---
id: task/post-audit/bound-line-rpc-protocol-memory
title: Bound Line RPC protocol memory and request lifetime
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T09:37:36.900Z
---
Add maximum line and unterminated-buffer bounds, reject pending requests on malformed protocol input, and give each request a deadline. Preserve provider/session failure semantics and add tests for oversized lines, invalid JSON, and stalled responses.