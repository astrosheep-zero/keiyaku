---
id: task/implement-the-provider-tell-witness-model
title: Implement the provider tell witness model
state: done
priority: 0
needs: []
parent: task/complete-the-provider-core-capability-model
supersedes: []
relates: []
note: ""
createdAt: 2026-08-12T10:27:58.724Z
updatedAt: 2026-08-12T12:33:25.792Z
---
Hard-cut the production Akuma provider, Body, and Heart tell pipeline to the settled witness model: shared timeline admission, repeatable delivery witnesses, optional terminal receipts, death voiding, and one pending|told|voided fold. Delete the old five-stage TellState and any duplicate pending projection. This is the prerequisite for bounded snapshot presentation.