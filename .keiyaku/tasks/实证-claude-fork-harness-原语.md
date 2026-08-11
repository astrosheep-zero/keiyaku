---
id: task/实证-claude-fork-harness-原语
title: 实证 Claude fork harness 原语
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-08T17:32:58.218Z
updatedAt: 2026-08-08T20:05:11.544Z
contractId: null
---
在 Cut 2 实现前，对当前 @anthropic-ai/claude-agent-sdk 做本地 API 与最小运行证据检查：确认能否从 completed answered turn 的 durable historyId/native coordinate 创建独立上游 session，明确所需输入、返回 coordinate、取消与失败证据。输出 concrete capability gap；若 SDK 不支持，不得用复制 heart/session id 或重新 resume 冒充 fork。只有证据足以成文 provider-native fork contract 时才关闭任务。