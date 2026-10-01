---
id: task/maintenance/simplify-git-and-reconciliation-e717
title: Simplify Git and reconciliation result internals
state: done
priority: 1
needs: []
parent: task/maintenance/repository-wide-simplification-adad
supersedes: []
relates: []
note: ""
createdAt: 2026-09-29T13:38:26.583Z
updatedAt: 2026-09-29T14:15:41.634Z
---
Within Git reconciliation and public-result ownership, clear the Git lag decoder and library reconcile maintainability failures, converge the two confirmed lag classification switches, and remove only confirmed unread internal schema material. Keep Git decoding separate from protocol decoding and preserve retry, failure, and lag ownership.