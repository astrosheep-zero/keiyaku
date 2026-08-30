---
id: task/architecture-ownership/observe-every-background
title: Observe every background retirement failure
state: done
priority: 0
needs:
  - task/architecture-ownership/own-opencode-drive-before
parent: task/architecture-ownership/own-provider-resources-before
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T08:33:03.223Z
updatedAt: 2026-08-28T08:35:26.333Z
---
Provider Arc 4: every fire-and-forget retirement is explicitly observed; cleanup failure remains reported by ProviderAttempt.closed and never escapes as an unhandled rejection.