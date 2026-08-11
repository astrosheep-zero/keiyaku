---
id: task/接通-akuma-codex-app-server-provider
title: 接通 Akuma codex-app-server provider
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-08T23:47:16.460Z
updatedAt: 2026-08-09T00:07:00.900Z
contractId: null
---
以 docs/akuma.md Provider boundary 与 Persona 为权威，新增 literal codex-app-server adapter：stdio JSON-RPC handshake、fresh/resume、session admission、assistant/activity/terminal translation、abort、native fork，以及由 cwd/access/network 计算的真实 confinement。不得引入 provider registry、settings catalog 或 v3 harness 状态机。