---
id: task/post-audit/bound-agenteventchannel-backlog
title: Bound AgentEventChannel backlog
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T09:26:50.641Z
---
Give AgentEventChannel a finite backlog and an explicit policy for coalescing or dropping reconstructible intermediate events while retaining terminal/error meaning. Emit after end must be rejected or ignored consistently. Add slow-consumer and provider-flood tests.