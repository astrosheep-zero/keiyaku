---
id: task/capture-one-execution-channel-per-drive/type-routed-task-forwarding-and
title: Type routed Task forwarding and public surface proof
state: done
priority: 0
needs: []
parent: task/architecture-ownership/inject-one-per-drive-execution
supersedes: []
relates: []
note: "Completed typed routed Task forwarding: action/input-specific results flow through requestForwardedTask without index casts; public Keiyaku member surface reflects withExecution. Focused Task, CLI, request, audit, Library verification suite passed; typecheck, build, architecture, maintainability, reachability, format, and diff check passed. Known unrelated public guidance-regexp and four Square-edge cli-akuma failures recorded separately."
createdBy: aku/worker/4b5380b1
createdAt: 2026-08-28T16:28:14.932Z
updatedAt: 2026-08-28T16:40:08.391Z
---
Address journal 01M14K4Z97D1EZMWNWEXF3RDBJ: correct the intentional Keiyaku.withExecution runtime-surface assertion and replace Task forwarding request/result casts with action-typed forwarding. Preserve local/routed composition; do not change the independent library-contract-operations Settlement baseline.