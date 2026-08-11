---
id: task/清理-akuma-crash-遗留-request-transport
title: 清理 Akuma crash 遗留 request transport
state: open
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-09T01:10:10.819Z
updatedAt: 2026-08-09T01:10:10.819Z
contractId: null
---
以 docs/akuma.md Body Requests transport 非事实法为权威，在新 body sweep 后、drive pump 开门前清除旧 requests transport root，避免 crash 目录永久残留；不得触碰 Heart request facts。来源：act_81 nonblocker 2。