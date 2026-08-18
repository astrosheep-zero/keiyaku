---
id: task/make-exact-contract-status-use-the-existing-sing
title: Make exact Contract status use the existing single-Contract observation primitive
state: done
priority: 0
needs: []
parent: task/restore-factual-contract-observation-and-receipt
supersedes: []
relates: []
note: ""
createdAt: 2026-08-18T02:33:47.446Z
updatedAt: 2026-08-18T03:33:59.541Z
---
`status <kei/...>` must not read the complete Contract board and then filter it. Reuse the existing Contract observation primitive and render a dedicated single-Contract view without Split Horizon, world sections, or aggregate counts. Short selectors may retain the catalog read required to resolve them. Verify the full-id path observes one Contract regardless of board size.
