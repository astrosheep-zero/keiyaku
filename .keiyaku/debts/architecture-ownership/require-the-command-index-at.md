---
id: debt/architecture-ownership/require-the-command-index-at
title: Require the command index at every pump
state: done
priority: 0
needs:
  - debt/architecture-ownership/make-erased-descriptors-runtime
parent: debt/architecture-ownership/close-the-heart-owner-index-and
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T09:01:13.671Z
updatedAt: 2026-08-28T09:11:47.973Z
---
Make command composition a required dependency of BodyRequestPump and runAkumaBody. Every known but unregistered action must produce a deterministic refused receipt instead of silence. Update direct CLI and library pump fixtures and prove child processes terminate.