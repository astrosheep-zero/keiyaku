---
id: task/make-provider-completion-follow-narration-closur
title: Make Provider completion follow narration closure
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-15T08:15:44.849Z
updatedAt: 2026-08-15T08:15:44.849Z
---
Remove the Body-level race between Session events and completion. Provider adapters close narration before exposing completion; Body drains the one narration stream and then reads its terminal result. Regression: immediate completion cannot erase session/activity/history, and terminal tell fallback cannot hang.