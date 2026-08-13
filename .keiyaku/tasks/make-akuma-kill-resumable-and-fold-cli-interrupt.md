---
id: task/make-akuma-kill-resumable-and-fold-cli-interrupt
title: Make Akuma kill resumable and fold CLI interrupt into tell
state: done
priority: 0
needs: []
parent: task/complete-the-provider-core-capability-model
supersedes: []
relates: []
note: ""
createdAt: 2026-08-12T12:52:54.988Z
updatedAt: 2026-08-12T14:00:59.104Z
---
Restore the settled Akuma lifecycle: kill stops the current Body without terminating the durable Aku, preserves pending tells and Body Requests, and permits a later tell to wake from retained session/history. Keep interrupt as a Library composition fenced by Heart transaction plus leash, while the CLI exposes it only as tell --interrupt and removes the standalone interrupt root verb. Hard-cut old death-row/void-by-kill authority and update the Akuma execution, Heart, public, and CLI owners with focused concurrency and wake tests.