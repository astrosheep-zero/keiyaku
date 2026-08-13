---
id: task/drain-codex-app-server-completion-events-before
title: Drain Codex app-server completion events before terminal closure
state: open
priority: 1
needs: []
parent: null
supersedes: []
relates:
  - task/align-akuma-running-ui-and-investigate-unclosed
note: "Root cause: Codex adapter ends AgentEventChannel immediately on turn/completed, so later or already-buffered item/completed notifications can lose their consumer before Heart admission. Define adapter-local terminal drain law; add regression for item/started -> turn/completed -> item/completed. Do not synthesize generic provider-neutral tool completion."
createdAt: 2026-08-13T04:19:45.006Z
updatedAt: 2026-08-13T04:19:45.006Z
---
