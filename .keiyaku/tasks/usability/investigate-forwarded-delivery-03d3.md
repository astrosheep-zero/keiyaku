---
id: task/usability/investigate-forwarded-delivery-03d3
title: "Investigate forwarded-delivery stale tender: AKUMA_REQUESTS path keeps old tender"
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: "RESOLVED 2026-09-28: root cause was --overwrite dropped at the parent Body adapter (src/akuma-body.ts). Fix claimed under kei/forwarded-delivery-honors-7c15 (main 50864bbe9): passthrough restored, both-arm pin through the real parent-Body port, law sentence in docs/akuma-requests.md."
createdAt: 2026-09-28T10:58:59.956Z
updatedAt: 2026-09-28T11:46:11.233Z
---
Worker report (2026-09-28, render campaign): a delivery run inside an Akuma turn (AKUMA_REQUESTS env set, forwarded-request path) kept the OLD tender; re-running the same deliver locally with AKUMA_REQUESTS removed picked up the NEW tender. Suspected stale-tender bug in the forwarded-request path: request forwarding may reuse or replay an earlier request/tender instead of issuing a fresh one. Investigation only, read-only: locate the forwarding path (akuma requests transport, AKUMA_REQUESTS env composition at provider spawn, the CLI-side forwarding), establish the exact staleness mechanism with file:line evidence, reproduce cheaply if possible, and propose the fix direction. Do NOT alter main; any implementation fix needs its own settled Contract.