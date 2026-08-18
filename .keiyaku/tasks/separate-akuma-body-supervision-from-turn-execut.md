---
id: task/separate-akuma-body-supervision-from-turn-execut
title: Separate Akuma Body supervision from turn execution
state: open
priority: 1
needs:
  - task/replace-source-topology-architecture-allowlists
  - task/separate-akuma-request-transport-from-request-ex
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: ""
createdAt: 2026-08-18T03:55:57.451Z
updatedAt: 2026-08-18T03:56:24.400Z
---
把 Body 的 lease/process supervision 与 provider turn drive state machine 分成两个 coherent modules。supervisor仍单独拥有 birth/start/recovery/stop 与 descendant cleanup；turn engine只拥有 provider session、event persistence、tell consumption 和 completion closure。

Request pump通过一个窄 capability 接入，不新增 generic runtime framework、provider registry或第二 lifecycle judge。完成时移除 body.ts 的 file-line exemption。