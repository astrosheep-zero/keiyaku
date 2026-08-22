---
id: task/represent-repository-reconciliation-discovery-fa
title: Represent repository reconciliation discovery failures honestly
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-16T10:48:38.754Z
updatedAt: 2026-08-21T08:14:59.606Z
---
Repo.reconcile() currently promises one per-Contract typed report and no aggregate failure, but an operational failure before the Git world yields any ContractId cannot be represented by RepoReconcileReport { contracts[] }. Settle the public result model and CLI rendering from the user perspective, preserve successful per-Contract reports, and make pre-observation failure explicit without synthetic ContractIds, silent empty success, or raw implementation exceptions.