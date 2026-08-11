---
id: task/实现-akuma-body-requests-cut-3
title: 实现 Akuma Body Requests Cut 3
state: done
priority: 1
needs:
  - task/接通-akuma-codex-app-server-provider
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-08T23:36:47.089Z
updatedAt: 2026-08-09T01:11:33.839Z
contractId: null
---
以 docs/akuma.md 为唯一权威，将 mailbox 统一改名为 Body Requests，并实现受限 provider 写入持久请求、unsandboxed body 代为执行 Akuma.call、回写 receipt，以及 body 重启后的 child-birth settlement。不得引入通用消息队列、第二权威或新的 public verb。