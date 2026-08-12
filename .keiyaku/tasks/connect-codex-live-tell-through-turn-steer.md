---
id: task/connect-codex-live-tell-through-turn-steer
title: Connect Codex live tell through turn/steer
state: in_progress
priority: 0
needs: []
parent: task/complete-the-provider-core-capability-model
supersedes: []
relates: []
note: ""
createdAt: 2026-08-12T16:40:37.037Z
updatedAt: 2026-08-12T16:40:57.763Z
---
Under docs/akuma-provider.md, expose Session.tell only for Codex app-server turn/steer. Map one TellId to clientUserMessageId, submit text to the currently admitted thread/turn, validate the response names that same active turn, and return an adapter fence only after native acceptance. Keep Claude without live tell because streamInput only proves transport queueing and no terminal receipt stream is mapped. Add provider and Body integration regressions; no capability registry or provider-name branch.