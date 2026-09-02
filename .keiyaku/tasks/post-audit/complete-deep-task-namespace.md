---
id: task/post-audit/complete-deep-task-namespace
title: Complete deep Task namespace durability
state: done
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T09:58:48.234Z
---
If strict crash durability remains a Task promise, sync each newly created ancestor directory entry when creating nested namespaces. Otherwise document the narrower guarantee with a concrete recovery test.