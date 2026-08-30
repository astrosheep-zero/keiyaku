---
id: task/akuma/request/make-conflict-materialization/replay-materialized-handoff
title: Replay materialized handoff evidence
state: done
priority: 1
needs:
  - task/akuma/request/make-conflict-materialization/retire-proven-resolved-handoffs
parent: task/akuma/request/make-conflict-materialization
supersedes: []
relates: []
note: ""
createdBy: aku/worker/5d71d5a4
createdAt: 2026-08-30T18:32:03.525Z
updatedAt: 2026-08-30T18:40:48.407Z
---
Implement the settled forwarded-evidence half under docs/public-results.md and docs/akuma-requests.md: preserve materialized handoff identity as durable service evidence, replay it truthfully without a delivery fact or rematerialization, and retain fact evidence for recorded deliveries.