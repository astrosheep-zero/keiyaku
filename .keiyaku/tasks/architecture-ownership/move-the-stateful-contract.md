---
id: task/architecture-ownership/move-the-stateful-contract
title: Move the stateful Contract handle intact
state: done
priority: 0
needs:
  - task/architecture-ownership/require-the-command-index-at
parent: task/architecture-ownership/close-the-heart-owner-index-and
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T09:01:14.121Z
updatedAt: 2026-08-28T09:22:45.784Z
---
Move the complete stateful KeiyakuHandle and seat capability from contract.ts into one coherent contract-handle owner. Leave static facade, construction, listing, observation, and binding in contract.ts; do not create tiny wrappers or stuff more into contract-operations.ts.