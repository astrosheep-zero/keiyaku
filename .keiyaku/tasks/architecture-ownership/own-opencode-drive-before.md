---
id: task/architecture-ownership/own-opencode-drive-before
title: Own OpenCode drive before readiness
state: done
priority: 0
needs:
  - task/architecture-ownership/prove-opencode-close-failure
parent: task/architecture-ownership/own-provider-resources-before
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T08:22:26.475Z
updatedAt: 2026-08-28T08:24:30.181Z
---
Provider Arc 3: register the OpenCode start/resume physical runtime before readiness and propagate readiness-close failure through ProviderAttempt.closed, with deterministic reproduction.