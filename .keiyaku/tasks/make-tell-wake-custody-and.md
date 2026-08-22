---
id: task/make-tell-wake-custody-and
title: Make Tell wake custody and receipts durable and honest
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates:
  - task/investigate-tell-accepted
note: ""
createdAt: 2026-08-21T07:54:31.473Z
updatedAt: 2026-08-21T13:57:28.812Z
---
Implement Faye act/236: Tell wake success is witnessed by a durable successor Body fact in Heart, not OS spawn. Transfer pursuit duty only at that fact; return an evidence-backed failed wake while retaining pending Tell when the child exits first; converge concurrent wakers through the existing leash; and expose pending tells without a live Body honestly. Preserve level triggering, at-least-once delivery, and the no-daemon model.