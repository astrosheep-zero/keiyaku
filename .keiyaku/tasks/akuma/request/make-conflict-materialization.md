---
id: task/akuma/request/make-conflict-materialization
title: Make conflict materialization recoverable and durably evidenced
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-30T18:12:31.269Z
updatedAt: 2026-08-30T19:51:40.260Z
---
Contract deliver conflict materialization has no Keiyaku-only recovery after a previously materialized worktree is delivered and the target moves again: stale MERGE_HEAD blocks replacement even after unresolved paths are gone. In the observed retry, forwarded --materialize-conflict performed the projection but returned `Contract contract.deliver completed without durable service evidence`. Fix the lifecycle so successful candidate capture retires or replaceably owns old merge state, and every performed materialization returns truthful durable evidence without ambiguous failure-after-effect. Cover target movement, repeated materialization, and forwarded delivery.