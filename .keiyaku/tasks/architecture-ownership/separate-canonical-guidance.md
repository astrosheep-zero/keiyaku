---
id: task/architecture-ownership/separate-canonical-guidance
title: Separate canonical guidance rendering from worktree projection
state: done
priority: 2
needs: []
parent: task/architecture-ownership/reduce-request-execution-and
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T03:35:26.188Z
updatedAt: 2026-08-28T05:29:08.757Z
---
Keep one canonical Contract guidance renderer while separating its pure policy bytes from filesystem projection, custody, chmod, and lag reporting. Do not introduce a filesystem abstraction or a second renderer.