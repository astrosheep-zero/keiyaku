---
id: task/rewrite-claude-provider-with-live-steer
title: Rewrite Claude provider with live steer
state: done
priority: 0
needs: []
parent: task/complete-the-provider-core-capability-model
supersedes: []
relates: []
note: ""
createdAt: 2026-08-13T00:46:26.264Z
updatedAt: 2026-08-13T12:40:33.481Z
---
Delete the current Claude adapter and rebuild it around one long-lived Claude Query with a pushable SDKUserMessage source. Initial input and live Tells share that Query; post-yield source pull is submission evidence, successful result checkpoints emit exact consumed receipts, terminal-before-submit returns turn-ended, and unreceipted accepted Tells remain replayable. Correct the owning provider law and add focused provider plus Body integration regressions without provider-name branches, streamInput, compatibility residue, or a second durable authority.