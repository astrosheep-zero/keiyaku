---
id: task/post-audit/make-targeted-task-reads
title: Make targeted Task reads independent of full board scans
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T10:22:29.681Z
---
Make TaskHandle.read and equivalent targeted reads load the authority path directly. Share one board snapshot within a public operation. Add scale benchmarks for hundreds to thousands of Tasks before introducing any non-authoritative index or persisted children structure.