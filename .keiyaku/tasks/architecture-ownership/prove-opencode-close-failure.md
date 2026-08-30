---
id: task/architecture-ownership/prove-opencode-close-failure
title: Prove OpenCode close failure settles custody
state: done
priority: 0
needs:
  - task/architecture-ownership/own-opencode-fork-before
parent: task/architecture-ownership/own-provider-resources-before
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T08:07:51.948Z
updatedAt: 2026-08-28T08:12:07.647Z
---
Correct Arc 2 closure proof: a rejected physical runtime close must settle the owned resource and make ProviderAttempt.closed reject rather than hang; add deterministic coverage.