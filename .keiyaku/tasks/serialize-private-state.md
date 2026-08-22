---
id: task/serialize-private-state
title: Serialize private state publication across settlement and reconcile
state: open
priority: 1
needs: []
parent: task/reconcile-custody-and-cleanup
supersedes: []
relates: []
note: ""
createdAt: 2026-08-22T15:36:03.581Z
updatedAt: 2026-08-22T15:52:20.627Z
---
Resolve the mismatch between per-Contract/per-Task SQLite fences and the shared refs/heads/keiyaku-state CAS. The current settleAll uses Promise.all and each post-admission holder release publishes against a frozen state OID without acquiring a shared private-root writer fence. Define the serialization boundary, fresh observation and retry behavior, failure reporting, recovery, tests, and settlement owner law.

Faye ruling act/278: Git owns the shared private-root publication boundary. Add one fixed common-dir SQLite immediate lock covering all post-admission private-root writers, currently publishTaskHolderRelease; admission remains outside it. Acquire the boundary before freezing a fresh observation, then decide current Contract, matching holder, and expected OID from that same epoch. A CAS failure after this point means real outside concurrency, so report the existing task-holder lag for replay; do not add an in-call retry loop. settleAll may retain parallel Task Markdown settlement and namespace projection while holder publications queue on the shared fence. Preserve per-Task admission fences, Task predecessor CAS, optimistic admission CAS, and unknown publication recovery. Owner law: docs/settlement.md for settlement behavior; docs/git.md for the Git-owned boundary.
