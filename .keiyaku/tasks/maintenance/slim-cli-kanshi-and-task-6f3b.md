---
id: task/maintenance/slim-cli-kanshi-and-task-6f3b
title: Slim CLI, Kanshi, and Task presentation fixtures
state: done
priority: 2
needs: []
parent: task/maintenance/repository-wide-simplification-adad
supersedes: []
relates: []
note: ""
createdAt: 2026-09-29T13:38:26.583Z
updatedAt: 2026-09-29T15:34:41.023Z
---
Reduce repeated CLI, Kanshi, and Task presentation fixture construction while preserving every test case and exact assertion. Consolidate repeated executable, capture, Task-row, Kanshi-report, and Contract-row setup in coherent existing support modules; do not introduce a fixture framework or delete behavioral coverage.