---
id: task/architecture-ownership/own-opencode-fork-before
title: Own OpenCode fork before readiness
state: done
priority: 0
needs:
  - task/architecture-ownership/enforce-one-resource-one
parent: task/architecture-ownership/own-provider-resources-before
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T08:03:33.377Z
updatedAt: 2026-08-28T08:06:32.131Z
---
Provider Arc 2: route fork runtime establishment through AttemptCustody.signal, own the runtime before fork RPC, and prove force disposal during pending readiness closes the server.