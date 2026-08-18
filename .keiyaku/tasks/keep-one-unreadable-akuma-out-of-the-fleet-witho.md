---
id: task/keep-one-unreadable-akuma-out-of-the-fleet-witho
title: Keep one unreadable Akuma out of the Fleet without failing the section
state: done
priority: 0
needs: []
parent: task/restore-factual-contract-observation-and-receipt
supersedes: []
relates: []
note: ""
createdAt: 2026-08-18T02:33:47.446Z
updatedAt: 2026-08-18T03:33:59.367Z
---
The compact Fleet list silently omits an individual valid AkuId whose Heart or Leash row cannot be projected. Other readable rows remain visible and Kanshi does not turn one bad row into a failed Fleet section. Add no per-row failure type, retry, diagnostic row, or recovery mechanism.
