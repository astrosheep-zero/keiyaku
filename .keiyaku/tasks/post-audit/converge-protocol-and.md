---
id: task/post-audit/converge-protocol-and
title: Converge Protocol and composition boundaries incrementally
state: done
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T10:53:25.376Z
---
Define a narrow composition root for cross-product Contract, Task, Akuma and workspace sagas. Keep Protocol focused on one Contract operation and prevent ambient process environment or low-level product reach-through. Make incremental moves with architecture tests, not a full rewrite.