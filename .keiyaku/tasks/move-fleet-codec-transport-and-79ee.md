---
id: task/move-fleet-codec-transport-and-79ee
title: Move Fleet codec transport and projection to owners
state: done
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-02T04:39:41.807Z
updatedAt: 2026-09-02T05:29:43.370Z
---
Implement Faye P2 item 6 (act/1203, act/1205): reduce src/library/fleet.ts responsibility by moving codec, Body transport, and public projection logic to akuma/** and body/** owners. Keep Library as composition for Akuma control plus Task/Dispatch association, polling, tell/kill execution. Preserve public behavior and strict runtime decoding; do not create wrapper chains or change law. Update architecture policy only for the resulting ownership edges and add focused Fleet/Body regressions. Do not touch P1-A/P1-B, runtime termination, or forwarding codec compression.