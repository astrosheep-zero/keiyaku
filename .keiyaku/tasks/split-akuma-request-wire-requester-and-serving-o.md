---
id: task/split-akuma-request-wire-requester-and-serving-o
title: Split Akuma request wire requester and serving owners
state: done
priority: 1
needs: []
parent: task/审计项目架构边界-重复与-owner-错位
supersedes:
  - task/separate-akuma-request-transport-from-request-ex
relates: []
note: ""
createdAt: 2026-08-18T10:35:11.325Z
updatedAt: 2026-08-19T02:45:25.413Z
---
Apply the settled C2 three-way ownership split. request-wire.ts is the sole claim/receipt byte judge and atomic file protocol; requests.ts owns requester-side environment injection and call/wait/tell/kill/deliver requests; request-serve.ts owns durable receipt projection, Heart service, execution port, pump, cleanup, and recovery. Enforce requester -> wire and serve -> wire with no requester/serve cross-import, no forwarding facade, no generic RPC union, no child-side admission pre-check, no docs change, and no topology tests. Remove the requests.ts maintainability exemption without adding a replacement.