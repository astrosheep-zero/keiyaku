---
id: task/定版-provider-observation-event-中间层
title: 定版 provider observation event 中间层
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: 需先由 Faye 对公共类型、Heart 持久化坐标、fallback 与拒绝项作根因定版。
createdAt: 2026-08-09T03:08:55.448Z
updatedAt: 2026-08-09T03:37:29.022Z
contractId: null
---
依据 docs/akuma.md Provider boundary，裁定并实现 Claude/Codex 原生 harness 事件到 provider-neutral observation vocabulary 的最小完整映射；分离 session control 与 public observation，保持 TurnResult 为唯一终局。