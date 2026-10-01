---
id: task/maintenance/simplify-cli-receipt-rendering-65f5
title: Simplify CLI receipt rendering internals
state: done
priority: 1
needs: []
parent: task/maintenance/repository-wide-simplification-adad
supersedes: []
relates: []
note: ""
createdAt: 2026-09-29T13:38:26.583Z
updatedAt: 2026-09-29T14:12:57.711Z
---
Within CLI output ownership, clear the `renderAcceptedDeliver`, `stopLines`, and reconciliation `lagRow` maintainability failures; delete confirmed unread render projections; and converge the shared short Git identity rule. Preserve every receipt byte and keep accepted mutation receipts distinct from reconciliation reports.