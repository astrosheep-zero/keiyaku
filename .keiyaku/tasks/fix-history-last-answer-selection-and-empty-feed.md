---
id: task/fix-history-last-answer-selection-and-empty-feed
title: Fix history last answer selection and empty feedback
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates:
  - task/complete-the-provider-core-capability-model
note: history --last must return only the latest answered TurnFact complete answer bytes; never concatenate prior responses. When no answered turn exists, public/CLI result must be explicit and nonblank rather than empty. Trace provider terminal answer, Heart TurnFact, facade result, and CLI writer before changing.
createdAt: 2026-08-13T05:20:14.580Z
updatedAt: 2026-08-13T07:18:47.980Z
---
