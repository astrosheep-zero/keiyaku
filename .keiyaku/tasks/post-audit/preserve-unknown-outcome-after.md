---
id: task/post-audit/preserve-unknown-outcome-after
title: Preserve unknown outcome after submitted request cancellation
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T10:16:37.117Z
---
Define and implement the submitted boundary for Body Request cancellation. Before request publication, cancellation may remain cancelled. After durable request publication, return typed unknown with the logical requestId and action; never imply that no operation occurred. Cover caller retry and durable Heart settlement semantics.