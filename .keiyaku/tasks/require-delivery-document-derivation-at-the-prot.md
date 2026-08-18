---
id: task/require-delivery-document-derivation-at-the-prot
title: Require delivery document derivation at the protocol boundary
state: in_progress
priority: 1
needs: []
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: ""
createdAt: 2026-08-18T03:55:57.451Z
updatedAt: 2026-08-18T03:57:35.582Z
---
将当前全部生产 delivery/audit调用都提供的 document derivation从 internal optional input改为 required capability，删除 active delivery中的 unavailable sentinel与不可达 throw分支。Contract missing仍由 core decision返回既有 typed refusal。

不把 document decoding移进 Protocol，不改变 public DeliverInput或 audit结果；只收紧内部 composition contract并删除无生产状态。